/**
 * Concurrency & device ownership. DESIGN §3.4.
 *
 * Tier 1: per-device async mutexes for input transactions and storage mutations.
 * Tier 2: cross-process claim so two omp sessions on one machine don't both drive HID.
 *         Linux: abstract unix socket bind (kernel releases on process death — the
 *         flock property, without Node lacking flock). Other platforms: O_EXCL lockfile
 *         with liveness-checked staleness.
 * Tier 3 (cross-machine) is detection-only; see input.ts / status reporting.
 */
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import os from "node:os";
import { JetKvmError } from "./util.ts";

interface Waiter {
  holder: string;
  grant: () => void;
  timer: Timer;
  detachAbort: () => void;
}

/**
 * FIFO async mutex. Contention fails fast with <kind>Busy after queueTimeoutMs —
 * we never silently interleave two agents' HID transactions.
 */
export class AsyncMutex {
  private locked = false;
  private currentHolder = "";
  private heldSince = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly kind: "input" | "storage",
    private readonly queueTimeoutMs: number,
  ) {}

  acquire(holder: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new JetKvmError("Aborted", `${this.kind} transaction aborted while waiting for the lock`));
    }
    if (!this.locked && this.queue.length === 0) {
      this.lockNow(holder);
      return Promise.resolve(this.releaseBind());
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: Waiter;
      const remove = (): boolean => {
        const idx = this.queue.indexOf(waiter);
        if (idx < 0) return false;
        this.queue.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.detachAbort();
        return true;
      };
      const onAbort = (): void => {
        if (remove()) {
          reject(new JetKvmError("Aborted", `${this.kind} transaction aborted while waiting for the lock`));
        }
      };
      waiter = {
        holder,
        grant: () => {
          waiter.detachAbort();
          resolve(this.releaseBind());
        },
        timer: setTimeout(() => {
          if (!remove()) return;
          reject(
            new JetKvmError(`${this.kind === "input" ? "Input" : "Storage"}Busy`, `${this.kind} transaction could not start: held by ${this.currentHolder} since ${new Date(this.heldSince).toISOString()}`, {
              holder: this.currentHolder,
              since: this.heldSince,
              kind: this.kind,
            }),
          );
        }, this.queueTimeoutMs),
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private lockNow(holder: string): void {
    this.locked = true;
    this.currentHolder = holder;
    this.heldSince = Date.now();
  }

  private releaseBind(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        this.lockNow(next.holder);
        next.grant();
      } else {
        this.locked = false;
        this.currentHolder = "";
      }
    };
  }

  get holderInfo(): { held: boolean; holder: string; since: number } {
    return { held: this.locked, holder: this.currentHolder, since: this.heldSince };
  }
}

export interface DeviceLocks {
  input: AsyncMutex;
  storage: AsyncMutex;
}

export function createDeviceLocks(queueTimeoutMs: number): DeviceLocks {
  return { input: new AsyncMutex("input", queueTimeoutMs), storage: new AsyncMutex("storage", queueTimeoutMs) };
}

// ---------------------------------------------------------------------------
// Cross-process claim
// ---------------------------------------------------------------------------

export interface ClaimInfo {
  pid: number;
  since: number;
  /** Process start time (Linux /proc stat field 22) — defeats pid reuse. */
  startTicks?: number | null;
}

export interface CrossProcessClaim {
  release(): void;
  readonly info: ClaimInfo;
}

/** /proc/<pid>/stat field 22 (starttime in clock ticks), or null off-Linux. */
function pidStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces/parens — fields restart after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const t = Number(fields[19]);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Holder liveness: pid alive AND (when recorded) the same process instance.
 * Without startTicks, a recycled pid masquerades as the holder forever.
 */
export function holderIsLive(info: ClaimInfo): boolean {
  if (!pidAlive(info.pid)) return false;
  if (info.startTicks === undefined || info.startTicks === null) return true;
  return pidStartTicks(info.pid) === info.startTicks;
}

function claimDir(): string {
  const dir = `${os.homedir()}/.cache/omp-jetkvm`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function infoFilePath(hostname: string): string {
  // Hostnames can contain chars we don't want in filenames (mDNS dots are fine).
  const safe = hostname.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${claimDir()}/${safe}.json`;
}

function readInfo(hostname: string): ClaimInfo | null {
  try {
    const path = infoFilePath(hostname);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ClaimInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim exclusive *mutating* access to a device across processes on this machine.
 * `force` steals an existing claim whose owning pid is alive (user-ordered override).
 * Throws DeviceBusy when someone else holds a live claim.
 */
export function acquireCrossProcessClaim(hostname: string, opts: { enabled: boolean; force?: boolean }): CrossProcessClaim {
  const info: ClaimInfo = { pid: process.pid, since: Date.now(), startTicks: pidStartTicks(process.pid) };
  if (!opts.enabled) {
    return { info, release() {} };
  }

  const path = infoFilePath(hostname);
  if (process.platform === "linux") {
    const abstractName = `\0omp-jetkvm:${hostname}`;
    let listener: { stop(closeActiveConnections?: boolean): void };
    try {
      // Bun.listen binds synchronously. node:net.Server.listen reports
      // EADDRINUSE asynchronously, which would let two callers both believe
      // they acquired the claim before crashing on an unhandled error.
      listener = Bun.listen({
        unix: abstractName,
        socket: {
          open(socket) {
            socket.end();
          },
          data() {},
        },
      });
    } catch (err) {
      const existing = readInfo(hostname);
      const holder = existing && holderIsLive(existing) ? existing : null;
      if (holder && !opts.force) {
        throw new JetKvmError("DeviceBusy", `device ${hostname} input is claimed by omp pid ${holder.pid} since ${new Date(holder.since).toISOString()} — retry with force: true to steal, or set jetkvm.concurrency.crossProcess: none`, {
          holderPid: holder.pid,
          since: holder.since,
        });
      }
      if (holder) {
        throw new JetKvmError("DeviceBusy", `cannot force-steal a live cross-process claim (pid ${holder.pid} holds the kernel socket); stop that process or set crossProcess: none`, { holderPid: holder.pid });
      }
      throw new JetKvmError("DeviceBusy", `device ${hostname} is claimed by another process on this machine (no live claim record; pid unknown)`, {
        hostname,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      writeFileSync(path, JSON.stringify(info));
    } catch (err) {
      listener.stop(true);
      throw err;
    }
    let released = false;
    return {
      info,
      release() {
        if (released) return;
        released = true;
        // Remove the sidecar while the kernel socket is still held. Stopping
        // first lets a new owner create its sidecar before this owner unlinks
        // it, erasing the new holder's diagnostics.
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        listener.stop(true);
      },
    };
  }

  // Non-Linux: O_EXCL lockfile + pid liveness.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify(info));
      closeSync(fd);
      return {
        info,
        release() {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readInfo(hostname);
      const holder = existing && holderIsLive(existing) ? existing : null;
      if (holder && !opts.force) {
        throw new JetKvmError("DeviceBusy", `device ${hostname} input is claimed by omp pid ${holder.pid} since ${new Date(holder.since).toISOString()} — retry with force: true to steal`, {
          holderPid: holder.pid,
          since: holder.since,
        });
      }
      try {
        unlinkSync(path);
      } catch {
        // best effort
      }
    }
  }
  throw new JetKvmError("DeviceBusy", `could not acquire cross-process claim for ${hostname}`, { hostname });
}

/** Read-only peek at the current claim, if any (for the /jetkvm status card). */
export function peekCrossProcessClaim(hostname: string): ClaimInfo | null {
  const info = readInfo(hostname);
  return info && holderIsLive(info) ? info : null;
}
