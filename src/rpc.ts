/**
 * JSON-RPC 2.0 client for the JetKVM `rpc` data channel.
 * DESIGN §2.3/§3.1: flat params object, monotonically increasing ids,
 * per-call timeout, unsolicited `method`-only events fan out to subscribers.
 */
import { JetKvmError } from "./util.ts";

export interface RpcEvent {
  method: string;
  params: unknown;
}

export interface RpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type EventHandler = (event: RpcEvent) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: JetKvmError) => void;
  timer: Timer;
  method: string;
}

/** Error codes the device uses (DESIGN §2.3). */
export const DEVICE_METHOD_NOT_FOUND = -32601;

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<EventHandler>();
  private closed: string | null = null;

  constructor(
    private readonly sendText: (text: string) => void,
    private readonly defaultTimeoutMs: number,
  ) {}

  get isOpen(): boolean {
    return this.closed === null;
  }

  /**
   * Feed one raw datachannel message. Responses match pending ids;
   * anything with `method` and no `id` is an unsolicited event.
   */
  handleMessage(data: string | Buffer): void {
    if (this.closed) return; // close() rejects all pending; late frames are junk
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // ignore malformed frames; never wedge on junk
    }
    const id = typeof msg["id"] === "number" ? msg["id"] : undefined;
    if (id !== undefined && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg["error"] !== undefined) {
        const err = msg["error"] as { code?: number; message?: string };
        entry.reject(
          new JetKvmError("RpcError", `${entry.method}: ${err.message ?? "unknown device error"}`, {
            deviceCode: err.code,
            method: entry.method,
          }),
        );
      } else {
        entry.resolve(msg["result"]);
      }
      return;
    }
    if (typeof msg["method"] === "string") {
      const event: RpcEvent = { method: msg["method"], params: msg["params"] };
      for (const h of [...this.handlers]) {
        try {
          h(event);
        } catch {
          // one bad subscriber never starves the rest
        }
      }
    }
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * One RPC round-trip. Rejects with:
   *  - RpcTimeout        — no answer within timeout
   *  - ConnectionLost    — channel closed while waiting
   *  - RpcError          — device returned {error:{code,message}}
   */
  call(method: string, params: Record<string, unknown> = {}, opts: RpcCallOptions = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    if (this.closed) {
      return Promise.reject(new JetKvmError("ConnectionLost", `${method}: channel closed (${this.closed})`));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      // Detach the abort listener on every settle path — a long-lived signal
      // reused across calls must not accumulate stale listeners.
      const detach = (): void => opts.signal?.removeEventListener("abort", onAbort);
      const settleResolve = (v: unknown): void => {
        detach();
        resolve(v);
      };
      const settleReject = (e: JetKvmError): void => {
        detach();
        reject(e);
      };
      const onAbort = (): void => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          settleReject(new JetKvmError("Aborted", `${method}: caller aborted`));
        }
      };
      const timer: Timer = setTimeout(() => {
        this.pending.delete(id);
        settleReject(new JetKvmError("RpcTimeout", `${method}: no device response in ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      const entry: Pending = { method, resolve: settleResolve, reject: settleReject, timer };
      this.pending.set(id, entry);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.sendText(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        settleReject(new JetKvmError("ConnectionLost", `${method}: send failed: ${String(err)}`));
      }
    });
  }

  /** Reject all pending calls; channel is gone. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new JetKvmError("ConnectionLost", `${entry.method}: ${reason}`));
    }
    this.pending.clear();
    this.handlers.clear();
  }
}
