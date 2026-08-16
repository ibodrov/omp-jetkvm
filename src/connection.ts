/**
 * AuthState + werift session + process-global ConnectionManager. DESIGN §3.1.
 *
 * One RTCPeerConnection per device, datachannel-only offer, JSON-RPC on `rpc`.
 * Lazy connect on first tool call; keepalive ping; idle teardown; 401 re-login
 * retry; reconnect with capped backoff for idempotent reads only — input never
 * auto-retries (replay danger).
 */
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { JsonRpcClient, type RpcEvent } from "./rpc.ts";
import { abortable, JetKvmError, clamp, redact, sdpCodec, sleep } from "./util.ts";
import { heldInputReleases } from "./input.ts";
import {
  type DeviceConfig,
  type JetKvmConfig,
  resolveDevice,
  resolvePassword,
  splitOrigin,
} from "./config.ts";
import {
  type CrossProcessClaim,
  acquireCrossProcessClaim,
  createDeviceLocks,
  peekCrossProcessClaim,
  type DeviceLocks,
} from "./concurrency.ts";

export type ConnectionState = "idle" | "connecting" | "connected";

export interface VideoState {
  ready?: boolean;
  streaming?: number;
  width?: number;
  height?: number;
  fps?: number;
}

// ---------------------------------------------------------------------------
// AuthState: login + cookie cache + 401-retry-once (authToken is a single
// server-side value; a human opening the UI rotates it under us).
// ---------------------------------------------------------------------------

export class AuthState {
  private cookie: string | null = null;
  private password: string | null = null;
  private passwordResolved = false;
  private lastRotationAt = 0;
  private loginPromise: Promise<void> | null = null;

  constructor(private readonly dev: DeviceConfig) {}

  get origin(): string {
    return splitOrigin(this.dev.host).origin;
  }

  get hostname(): string {
    return splitOrigin(this.dev.host).hostname;
  }

  private ensurePassword(): string | null {
    if (this.passwordResolved) return this.password;
    this.passwordResolved = true;
    this.password = resolvePassword(this.dev);
    return this.password;
  }

  private async performLogin(): Promise<void> {
    const password = this.ensurePassword();
    const resp = await fetch(`${this.origin}/auth/login-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ password: password ?? "" }),
    });
    if (resp.status === 401) {
      throw new JetKvmError("AuthFailed", `login rejected for ${this.hostname} — check the configured password`);
    }
    if (resp.status === 429) {
      const retry = resp.headers.get("Retry-After");
      throw new JetKvmError("AuthRateLimited", `device is rate-limiting logins; retry after ${retry ?? "60"}s`, {
        retryAfterSec: retry,
      });
    }
    if (!resp.ok) {
      throw new JetKvmError("AuthError", `login failed: HTTP ${resp.status}`);
    }
    const setCookies = resp.headers.getSetCookie();
    const token = setCookies
      .map((cookie) => cookie.split(";")[0]!)
      .find((cookie) => cookie.startsWith("authToken="));
    // No authToken cookie => noPassword mode; endpoints work without it.
    // Cookie expiry is not tracked: the device rotates the token on any other
    // login, so a 401 (handled by authedFetch's single retry) is the real
    // expiry signal — not a timer.
    this.cookie = token ?? "";
  }

  /** Coalesce concurrent initial logins and 401 recovery into one rotation. */
  login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    const pending = this.performLogin();
    this.loginPromise = pending;
    pending.then(
      () => {
        if (this.loginPromise === pending) this.loginPromise = null;
      },
      () => {
        if (this.loginPromise === pending) this.loginPromise = null;
      },
    );
    return pending;
  }

  /** Token-rotation heuristic (DESIGN §3.4 tier 3): did a 401-relogin happen? */
  tokenRotatedRecently(atMs: number): boolean {
    return this.lastRotationAt > atMs;
  }

  /**
   * Authenticated fetch with the single-retry-401 contract.
   * On 401: re-login once (token was rotated), retry. Never more.
   */
  async authedFetch(path: string, init: RequestInit = {}, opts: { retryOn401?: boolean } = {}): Promise<Response> {
    if (this.cookie === null) {
      await abortable(this.login(), init.signal ?? undefined, "authenticated request aborted");
    }
    const doFetch = async (cookie: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      // The device aggressively resets pooled connections (observed as
      // stackless ECONNREFUSED escaping Bun's keep-alive pool inside the omp
      // process and killing the session). One-shot sockets only.
      headers.set("Connection", "close");
      if (cookie) headers.set("Cookie", cookie);
      try {
        return await fetch(`${this.origin}${path}`, { ...init, headers });
      } catch (err) {
        if (init.signal?.aborted) {
          throw new JetKvmError("Aborted", "authenticated request aborted");
        }
        throw err;
      }
    };

    const attemptedCookie = this.cookie;
    const resp = await doFetch(attemptedCookie);
    if (resp.status !== 401 || opts.retryOn401 === false) return resp;

    // Another concurrent request may already have replaced the rejected
    // cookie. Only the request that still sees its attempted cookie performs
    // the login; every other request reuses that new token.
    if (this.cookie === attemptedCookie) {
      await abortable(this.login(), init.signal ?? undefined, "authenticated request aborted");
    }
    this.lastRotationAt = Date.now();
    return doFetch(this.cookie);
  }
}

// ---------------------------------------------------------------------------
// Process-global auth registry: one AuthState per device origin. The device
// keeps a single server-side token that every login rotates; two AuthState
// instances for one host (control session + browser engine) would invalidate
// each other's cookie on every login and ping-pong 401 → re-login (and trip
// the login rate limiter).
// ---------------------------------------------------------------------------

const AUTH_REGISTRY_KEY = Symbol.for("omp-jetkvm.auth");

function authRegistry(): Map<string, AuthState> {
  const g = globalThis as Record<symbol, Map<string, AuthState> | undefined>;
  if (!g[AUTH_REGISTRY_KEY]) g[AUTH_REGISTRY_KEY] = new Map();
  return g[AUTH_REGISTRY_KEY]!;
}

/** The process-wide AuthState for a device origin (first config wins). */
export function sharedAuthState(dev: DeviceConfig): AuthState {
  const key = splitOrigin(dev.host).origin;
  let auth = authRegistry().get(key);
  if (!auth) {
    auth = new AuthState(dev);
    authRegistry().set(key, auth);
  }
  return auth;
}

// DeviceSession
// ---------------------------------------------------------------------------

export interface SessionCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Only idempotent reads may retry across a reconnect. */
  retryOnReconnect?: boolean;
}

export class DeviceSession {
  readonly auth: AuthState;
  readonly locks: DeviceLocks;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private rpc: JsonRpcClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private keepaliveTimer: Timer | null = null;
  private claim: CrossProcessClaim | null = null;
  private backoffAttempt = 0;

  state: ConnectionState = "idle";
  lastActivity = 0;
  connectedAt = 0;
  lastError: string | null = null;
  videoState: VideoState = {};
  atxState: { power?: boolean; hdd?: boolean } = {};
  usbState: unknown = null;
  foreignInputWarnings: string[] = [];
  /** Last mouse position we reported (HID space) — release paths use it
   *  instead of (0,0) so releasing buttons never teleports the cursor. */
  lastMouse: { x: number; y: number } | null = null;
  constructor(
    readonly name: string,
    readonly dev: DeviceConfig,
    private readonly cfg: JetKvmConfig,
  ) {
    this.auth = sharedAuthState(dev);
    this.locks = createDeviceLocks(cfg.concurrency.queueTimeoutMs);
  }
  get rpcClient(): JsonRpcClient | null {
    return this.rpc;
  }

  get claimInfo() {
    return this.claim?.info ?? peekCrossProcessClaim(this.auth.hostname);
  }

  /** Tier-2 cross-process claim, acquired on first mutating call (DESIGN §3.4). */
  ensureClaim(force?: boolean): void {
    if (this.claim) return;
    if (this.cfg.concurrency.crossProcess !== "lock") return;
    this.claim = acquireCrossProcessClaim(this.auth.hostname, { enabled: true, force });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const { keepaliveMs, idleTimeoutMs } = this.cfg.session;
    this.keepaliveTimer = setInterval(() => {
      // Extension-docs isolation rule: raw timer callbacks own their try/catch.
      void this.tickHealth(keepaliveMs, idleTimeoutMs).catch((err) => {
        this.lastError = String(err);
      });
    }, keepaliveMs);
    this.keepaliveTimer?.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private async tickHealth(keepaliveMs: number, idleTimeoutMs: number): Promise<void> {
    const now = Date.now();
    if (this.state !== "connected") return;
    if (now - this.lastActivity > idleTimeoutMs) {
      await this.teardown("idle timeout");
      return;
    }
    if (now - this.lastActivity > keepaliveMs) {
      try {
        await this.rpc?.call("ping", {}, { timeoutMs: Math.min(5_000, keepaliveMs) });
      } catch {
        await this.teardown("keepalive ping failed");
      }
    }
  }

  private handleEvent(event: RpcEvent): void {
    this.lastActivity = Date.now();
    switch (event.method) {
      case "videoInputState":
        this.videoState = { ...this.videoState, ...(event.params as VideoState) };
        break;
      case "atxState":
        this.atxState = event.params as { power?: boolean; hdd?: boolean };
        break;
      case "usbState":
        this.usbState = event.params;
        break;
      default:
        break;
    }
  }

  private async teardown(reason: string): Promise<void> {
    this.state = "idle";
    this.rpc?.close(reason);
    this.rpc = null;
    // A dropped channel must not leave the input mutex locked by a parked
    // manual hold (keyboard down/hold_keys, mouse down) — drain them.
    for (const rel of heldInputReleases(this)) rel();
    try {
      this.dc?.close();
    } catch {
      // already closed
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.pc = null;
    this.stopKeepalive();
    this.claim?.release();
    this.claim = null;
  }

  async ensureConnected(signal?: AbortSignal): Promise<JsonRpcClient> {
    if (signal?.aborted) {
      throw new JetKvmError("Aborted", "connection attempt aborted");
    }
    if (this.state === "connected" && this.rpc && this.dc?.readyState === "open") {
      return this.rpc;
    }
    let pending = this.connectPromise;
    if (!pending) {
      pending = this.connect();
      this.connectPromise = pending;
      pending.then(
        () => {
          if (this.connectPromise === pending) this.connectPromise = null;
        },
        () => {
          if (this.connectPromise === pending) this.connectPromise = null;
        },
      );
    }
    await abortable(pending, signal, "connection attempt aborted");
    if (!this.rpc) throw new JetKvmError("ConnectionLost", "connection attempt finished without a channel");
    return this.rpc;
  }

  private async connect(): Promise<void> {
    // Capped exponential backoff between *automatic* reconnect attempts.
    if (this.backoffAttempt > 0) {
      await sleep(clamp(500 * 2 ** (this.backoffAttempt - 1), 500, 30_000));
    }
    this.state = "connecting";
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel("rpc");
    const opened = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new JetKvmError("ConnectionTimeout", "rpc datachannel did not open in 10s")),
        10_000,
      );
      dc.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      dc.onclose = () => {
        clearTimeout(t);
        reject(new JetKvmError("ConnectionLost", "rpc datachannel closed during connect"));
      };
    });
    // A slow signaling request can let the open timeout reject before the
    // code reaches `await opened`; attach a handler now to avoid an unhandled
    // rejection while preserving the later await's error.
    void opened.catch(() => {});
    const rpc = new JsonRpcClient((text) => dc.send(text), this.cfg.session.rpcTimeoutMs);
    dc.onMessage.subscribe((data) => {
      this.lastActivity = Date.now();
      rpc.handleMessage(data);
    });
    const unsubscribe = rpc.onEvent((e) => this.handleEvent(e));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const t0 = Date.now();
      while (pc.iceGatheringState !== "complete" && Date.now() - t0 < 5_000) {
        await sleep(100);
      }
      const local = pc.localDescription ?? offer;
      const resp = await this.auth.authedFetch("/webrtc/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sd: sdpCodec.encode(local as { type: string; sdp: string }) }),
      });
      if (!resp.ok) {
        throw new JetKvmError("SignalingFailed", `POST /webrtc/session -> HTTP ${resp.status}`);
      }
      const { sd } = (await resp.json()) as { sd: string };
      const answer = sdpCodec.decode(sd);
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await opened;
      await rpc.call("ping", {}, { timeoutMs: 5_000 });

      this.pc = pc;
      this.dc = dc;
      this.rpc = rpc;
      this.state = "connected";
      this.connectedAt = Date.now();
      this.lastActivity = Date.now();
      this.backoffAttempt = 0;
      this.lastError = null;
      this.startKeepalive();

      // Prime the video coordinate space; events keep it fresh afterwards.
      try {
        const vs = (await rpc.call("getVideoState")) as VideoState;
        this.videoState = { ...this.videoState, ...vs };
      } catch {
        // device may lack it; videoInputState events still update us
      }
      // Track dc close after successful connect.
      dc.onclose = () => {
        if (this.state === "connected") {
          this.backoffAttempt = 1;
          this.lastError = "datachannel closed";
          void this.teardown("datachannel closed");
        }
      };
    } catch (err) {
      unsubscribe();
      try {
        dc.close();
      } catch {
        // ignore
      }
      try {
        pc.close();
      } catch {
        // ignore
      }
      rpc.close("connect failed");
      this.state = "idle";
      this.backoffAttempt = Math.min(this.backoffAttempt + 1, 7);
      this.lastError = redact(String(err), this.dev.password);
      throw err instanceof JetKvmError
        ? err
        : new JetKvmError("ConnectionFailed", redact(String(err), this.dev.password));
    }
  }

  /**
   * RPC call with reconnect-once for idempotent reads. Input callers never set
   * retryOnReconnect — replaying HID events is worse than failing.
   */
  async call(method: string, params: Record<string, unknown> = {}, opts: SessionCallOptions = {}): Promise<unknown> {
    let client = await this.ensureConnected(opts.signal);
    try {
      return await client.call(method, params, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    } catch (err) {
      if (!(err instanceof JetKvmError)) throw err;
      if (!opts.retryOnReconnect) throw err;
      if (err.code !== "ConnectionLost" && err.code !== "RpcTimeout") throw err;
      await this.teardown(`reconnect after ${err.code}`);
      this.backoffAttempt = 0;
      client = await this.ensureConnected(opts.signal);
      return client.call(method, params, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }
  }

  /** Current pointer extent (stream pixels) for coordinate mapping. */
  async videoDims(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    if (this.videoState.width && this.videoState.height) {
      return { width: this.videoState.width, height: this.videoState.height };
    }
    const vs = (await this.call("getVideoState", {}, { retryOnReconnect: true, signal })) as VideoState;
    this.videoState = { ...this.videoState, ...vs };
    if (!vs.width || !vs.height) {
      throw new JetKvmError(
        "NoVideoSignal",
        "device reports no video dimensions — is the host powered on? (see jetkvm_device power)",
      );
    }
    return { width: vs.width, height: vs.height };
  }

  /** Force a rebuild (used by `/jetkvm reconnect`). */
  async reconnect(): Promise<void> {
    await this.teardown("user-ordered reconnect");
    await this.ensureConnected();
  }

  async dispose(): Promise<void> {
    await this.teardown("disposed");
  }

  snapshot(): Record<string, unknown> {
    return {
      device: this.name,
      host: this.auth.origin,
      state: this.state,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastActivity: this.connectedAt ? new Date(this.lastActivity).toISOString() : null,
      lastError: this.lastError,
      videoState: this.videoState,
      atxState: this.atxState,
      claim: this.claimInfo ? { pid: this.claimInfo.pid, since: new Date(this.claimInfo.since).toISOString() } : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Process-global manager: main session + subagents share one connection.
// ---------------------------------------------------------------------------

interface JetKvmRegistry {
  sessions: Map<string, DeviceSession>;
}

const REGISTRY_KEY = Symbol.for("omp-jetkvm.registry");

function registry(): JetKvmRegistry {
  const g = globalThis as Record<symbol, JetKvmRegistry | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { sessions: new Map() };
  return g[REGISTRY_KEY]!;
}

export class ConnectionManager {
  constructor(private readonly cfg: JetKvmConfig) {}

  session(deviceName?: string): DeviceSession {
    const dev = resolveDevice(this.cfg, deviceName);
    const key = splitOrigin(dev.host).origin;
    const existing = registry().sessions.get(key);
    if (existing) return existing;
    const name = deviceName ?? "default";
    const session = new DeviceSession(name, dev, this.cfg);
    registry().sessions.set(key, session);
    return session;
  }

  static peekSessions(): DeviceSession[] {
    return [...registry().sessions.values()];
  }

  static async disposeAll(): Promise<void> {
    const sessions = registry().sessions;
    for (const [, s] of sessions) await s.dispose();
    sessions.clear();
  }
}
