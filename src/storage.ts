/**
 * Storage / virtual media. DESIGN §4.4 + §2.4.
 *
 * Uploads are resumable (device keeps `<name>.incomplete`). serve_and_mount
 * runs a Range-capable HTTP server whose lifetime is bound to the mount.
 */
import type { BunFile } from "bun";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { JetKvmError, humanBytes, routeSourceAddress } from "./util.ts";
import type { DeviceSession } from "./connection.ts";
import type { PolicyConfig } from "./config.ts";

export type MountMode = "CDROM" | "Disk";

export interface VirtualMediaState {
  source?: "HTTP" | "Storage";
  mode?: MountMode;
  filename?: string;
  url?: string;
  size?: number;
}

function deviceCodeOf(err: unknown): number | undefined {
  if (err instanceof JetKvmError && err.details && typeof err.details === "object" && "deviceCode" in err.details) {
    const code = (err.details as Record<string, unknown>)["deviceCode"];
    if (typeof code === "number") return code;
  }
  return undefined;
}

function firmwareLacks(err: unknown): boolean {
  return err instanceof JetKvmError && deviceCodeOf(err) === -32601;
}

export async function listFiles(session: DeviceSession, signal?: AbortSignal): Promise<{ files: { filename: string; size: number; createdAt: string }[] }> {
  const r = (await session.call("listStorageFiles", {}, { retryOnReconnect: true, signal })) as { files?: unknown[] } | null;
  if (!r || !Array.isArray(r.files)) return { files: [] };
  return {
    files: r.files.map((f) => {
      const rec = (f ?? {}) as Record<string, unknown>;
      return {
        filename: String(rec["filename"] ?? "?"),
        size: Number(rec["size"] ?? 0),
        createdAt: String(rec["createdAt"] ?? "?"),
      };
    }),
  };
}

export async function getSpace(session: DeviceSession, signal?: AbortSignal): Promise<{ bytesUsed: number; bytesFree: number }> {
  return (await session.call("getStorageSpace", {}, { retryOnReconnect: true, signal })) as { bytesUsed: number; bytesFree: number };
}

export async function getMountState(session: DeviceSession, signal?: AbortSignal): Promise<VirtualMediaState | null> {
  return (await session.call("getVirtualMediaState", {}, { retryOnReconnect: true, signal })) as VirtualMediaState | null;
}
/** Mount/unmount drive USB-gadget reinit and can block for tens of seconds
 *  (observed live); storage mutations get their own generous timeout. */
const MOUNT_TIMEOUT_MS = 60_000;

/** Single-slot rule (DESIGN §8): clear any active mount before a new one. */
async function clearSlot(session: DeviceSession, policy: PolicyConfig): Promise<void> {
  const state = await getMountState(session);
  if (state === null || state === undefined) return;
  if (!policy.forceUnmountOnMount) {
    throw new JetKvmError(
      "VirtualMediaBusy",
      `another virtual media is already mounted (${state.filename ?? state.url ?? "?"}); unmount first or set jetkvm.policy.forceUnmountOnMount: true`,
      { mounted: state },
    );
  }
  await session.call("unmountImage", {}, { timeoutMs: MOUNT_TIMEOUT_MS });
}

export async function mountUrl(
  session: DeviceSession,
  policy: PolicyConfig,
  opts: { url: string; mode?: MountMode; signal?: AbortSignal },
): Promise<{ check: Record<string, unknown> }> {
  let check: Record<string, unknown> = {};
  try {
    check = (await session.call(
      "checkMountUrl",
      { url: opts.url },
      { timeoutMs: 15_000, signal: opts.signal },
    )) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof JetKvmError && err.code === "Aborted") throw err;
    // Firmware 0.5.8 quirk: checkMountUrl probes the URL (we see the GET)
    // but its handler errors internally (-32603). Treat as advisory only;
    // mountWithHTTP below is the real gate and works.
    check = { usable: null, note: `checkMountUrl RPC failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (check["usable"] === false) {
    throw new JetKvmError("MountUrlUnusable", `device cannot mount ${opts.url}: ${String(check["reason"] ?? "no reason given")}`, { check });
  }
  if (opts.signal?.aborted) throw new JetKvmError("Aborted", "mount URL operation aborted");
  await clearSlot(session, policy);
  try {
    await session.call("mountWithHTTP", { url: opts.url, mode: opts.mode ?? "CDROM" }, { timeoutMs: MOUNT_TIMEOUT_MS });
  } catch (err) {
    if (firmwareLacks(err)) {
      throw new JetKvmError("FirmwareLacksMethod", `device firmware lacks mountWithHTTP (${String(err)})`);
    }
    throw err;
  }
  return { check };
}


export async function mountFile(
  session: DeviceSession,
  policy: PolicyConfig,
  opts: { filename: string; mode?: MountMode },
): Promise<Record<string, unknown>> {
  await clearSlot(session, policy);
  await session.call("mountWithStorage", { filename: opts.filename, mode: opts.mode ?? "CDROM" }, { timeoutMs: MOUNT_TIMEOUT_MS });
  return (await getMountState(session)) as Record<string, unknown>;
}

export async function unmount(session: DeviceSession): Promise<Record<string, unknown>> {
  // Stop the server only after unmountImage is acknowledged. A timeout or
  // connection error is ambiguous: the media may still be mounted, and
  // killing its server in that state wedges the firmware storage handler.
  await session.call("unmountImage", {}, { timeoutMs: MOUNT_TIMEOUT_MS });
  stopServeServer(session);
  return { unmounted: true, state: await getMountState(session) };
}

export async function deleteFile(session: DeviceSession, filename: string): Promise<Record<string, unknown>> {
  const before = await getSpace(session);
  await session.call("deleteStorageFile", { filename });
  return { deleted: filename, bytesFreeBefore: before.bytesFree, state: await getMountState(session) };
}

// ---------------------------------------------------------------------------
// Resumable upload (DESIGN §4.4 flow)
// ---------------------------------------------------------------------------

export interface UploadProgress {
  bytesSent: number;
  totalBytes: number;
}

export interface UploadOptions {
  path: string;
  filename?: string;
  minFreeBytes?: number;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
}

export interface UploadResult {
  filename: string;
  totalBytes: number;
  resumedFrom: number;
  state: VirtualMediaState | null;
}

export async function uploadFile(session: DeviceSession, opts: UploadOptions): Promise<UploadResult> {
  const path = opts.path;
  if (!existsSync(path)) {
    throw new JetKvmError("FileNotFound", `no such file: ${path}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new JetKvmError("BadParams", `upload path is not a regular file: ${path}`);
  }
  const filename = opts.filename ?? basename(path);
  if (!filename || basename(filename) !== filename || filename === "." || filename === "..") {
    throw new JetKvmError("BadParams", "upload filename must be a plain non-empty filename");
  }
  const margin = opts.minFreeBytes ?? Math.max(stat.size * 0.05, 64 * 1024 * 1024);
  if (!Number.isFinite(margin) || margin < 0) {
    throw new JetKvmError("BadParams", "minFreeBytes must be a finite non-negative number");
  }
  const rawStart = await session.call(
    "startStorageFileUpload",
    { filename, size: stat.size },
    { signal: opts.signal },
  );
  if (typeof rawStart !== "object" || rawStart === null) {
    throw new JetKvmError(
      "UnexpectedResponse",
      `startStorageFileUpload returned a malformed result: ${JSON.stringify(rawStart).slice(0, 200)}`,
    );
  }
  const start = rawStart as Record<string, unknown>;
  if (
    typeof start["dataChannel"] !== "string" ||
    start["dataChannel"] === "" ||
    typeof start["alreadyUploadedBytes"] !== "number" ||
    !Number.isSafeInteger(start["alreadyUploadedBytes"]) ||
    start["alreadyUploadedBytes"] < 0 ||
    start["alreadyUploadedBytes"] > stat.size
  ) {
    throw new JetKvmError(
      "UnexpectedResponse",
      `startStorageFileUpload returned a malformed result: ${JSON.stringify(start).slice(0, 200)}`,
    );
  }
  const dataChannel = start["dataChannel"];
  const offset = start["alreadyUploadedBytes"];
  if (offset >= stat.size) {
    return { filename, totalBytes: stat.size, resumedFrom: offset, state: await getMountState(session) };
  }
  const space = await getSpace(session, opts.signal);
  const remaining = stat.size - offset;
  if (space.bytesFree < remaining + margin) {
    throw new JetKvmError(
      "StorageFull",
      `device has ${humanBytes(space.bytesFree)} free but the remaining upload is ${humanBytes(remaining)} (margin ${humanBytes(margin)}) — delete files or use serve_and_mount (no device storage needed)`,
    );
  }

  const file: BunFile = Bun.file(path);
  let sent = offset;
  let lastReport = 0;
  const counting = file.slice(offset).stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
        const now = Date.now();
        if (now - lastReport > 500) {
          lastReport = now;
          opts.onProgress?.({ bytesSent: sent, totalBytes: stat.size });
        }
      },
    }),
  );

  const resp = await session.auth.authedFetch(
    `/storage/upload?uploadId=${encodeURIComponent(dataChannel)}`,
    {
      method: "POST",
      // No Content-Type: raw remaining bytes (DESIGN §2.1).
      body: counting as unknown as RequestInit["body"],
      signal: opts.signal,
    },
    { retryOn401: false },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new JetKvmError(
      "UploadFailed",
      `upload POST failed: HTTP ${resp.status} ${text.slice(0, 200)} — the device keeps the .incomplete file; retrying resumes at byte ${sent}`,
      { bytesSent: sent, totalBytes: stat.size },
    );
  }
  opts.onProgress?.({ bytesSent: stat.size, totalBytes: stat.size });
  return { filename, totalBytes: stat.size, resumedFrom: offset, state: await getMountState(session) };
}

// ---------------------------------------------------------------------------
// serve_and_mount: Range-capable local HTTP server bound to the mount
// ---------------------------------------------------------------------------

interface ServeEntry {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  since: number;
}

const SERVE_REGISTRY_KEY = Symbol.for("omp-jetkvm.serve");
const serveRegistry = (): Map<string, ServeEntry> => {
  const g = globalThis as Record<symbol, Map<string, ServeEntry> | undefined>;
  if (!g[SERVE_REGISTRY_KEY]) g[SERVE_REGISTRY_KEY] = new Map();
  return g[SERVE_REGISTRY_KEY]!;
};

/** Parse a single-range `Range: bytes=...` header. */
export function parseRange(header: string | null, total: number): { start: number; end: number } | "full" | "invalid" {
  if (!header) return "full";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, s, e] = m;
  if (s === "" && e === "") return "invalid";
  if (s === "") {
    // suffix range: last N bytes
    const n = Math.min(Number(e), total);
    if (n === 0) return "invalid";
    return { start: total - n, end: total - 1 };
  }
  const start = Number(s);
  if (start >= total) return "invalid";
  const end = e === "" ? total - 1 : Math.min(Number(e), total - 1);
  if (end < start) return "invalid";
  return { start, end };
}

export function stopServeServer(session: DeviceSession): void {
  const entry = serveRegistry().get(session.auth.hostname);
  if (entry) {
    entry.server.stop(true);
    serveRegistry().delete(session.auth.hostname);
  }
}

/**
 * Retire a previous serve server safely: when the media it serves is still
 * mounted, unmount FIRST (policy-aware) — a server death under an active
 * mount wedges the device's storage handler (README "Firmware quirks").
 * Policy refusal (VirtualMediaBusy) propagates and leaves the server alive.
 */
export async function retireServeServer(session: DeviceSession, policy: PolicyConfig): Promise<void> {
  const entry = serveRegistry().get(session.auth.hostname);
  if (!entry) return;
  let state: VirtualMediaState | null;
  try {
    state = await getMountState(session);
  } catch (err) {
    // Unknown is not equivalent to unmounted. Keep serving rather than risk
    // wedging a device that still range-reads this URL.
    throw new JetKvmError(
      "VirtualMediaStateUnknown",
      `cannot verify whether ${entry.url} is still mounted; keeping its server alive`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (state?.url && state.url === entry.url) {
    await clearSlot(session, policy);
  }
  stopServeServer(session);
}

/**
 * session_shutdown path: best-effort unmount-then-stop, never throws. Force
 * unmount here — the alternative is the server dying under an active mount,
 * which is the documented device wedge.
 */
export async function shutdownServe(session: DeviceSession): Promise<void> {
  try {
    if (session.state === "connected") {
      await retireServeServer(session, {
        allowPowerActions: true,
        allowUsbDisconnect: false,
        forceUnmountOnMount: true,
      });
    }
  } catch {
    // device gone: process exit stops the server regardless
  }
  stopServeServer(session);
}

export async function serveAndMount(
  session: DeviceSession,
  policy: PolicyConfig,
  opts: { path: string; mode?: MountMode; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const path = opts.path;
  if (!existsSync(path)) {
    throw new JetKvmError("FileNotFound", `no such file: ${path}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new JetKvmError("BadParams", `serve_and_mount path is not a regular file: ${path}`);
  }
  const size = stat.size;
  // Bind + advertise on the interface that actually faces the device: the
  // kernel's chosen source address for the route to it (multi-homed, VPN and
  // loopback-test setups all resolve correctly; no packets sent). Anything
  // else is a guess the device may not be able to route back to.
  const bindIp = await routeSourceAddress(session.auth.hostname, { signal: opts.signal });
  if (!bindIp) {
    if (opts.signal?.aborted) {
      throw new JetKvmError("Aborted", "serve_and_mount aborted while resolving the route");
    }
    throw new JetKvmError(
      "NoRouteToDevice",
      `no usable local address on the route to ${session.auth.hostname} — cannot serve virtual media; check connectivity or use upload_and_mount instead`,
    );
  }
  // Unmount any media our previous server is still serving before stopping
  // it (retireServeServer); a fresh server dying under a live mount is the
  // documented wedge.
  await retireServeServer(session, policy);
  const file: BunFile = Bun.file(path);
  const server = Bun.serve({
    hostname: bindIp,
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      if (url.pathname !== "/iso") {
        return new Response("not found", { status: 404 });
      }
      const range = parseRange(req.headers.get("range"), size);
      if (req.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Length": String(size), "Accept-Ranges": "bytes" },
        });
      }
      if (range === "invalid") {
        return new Response("bad range", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      if (range === "full") {
        return new Response(file, {
          status: 200,
          headers: { "Content-Length": String(size), "Accept-Ranges": "bytes" },
        });
      }
      const len = range.end - range.start + 1;
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(len),
          "Accept-Ranges": "bytes",
        },
      });
    },
  });
  const url = `http://${bindIp}:${server.port}/iso`;
  serveRegistry().set(session.auth.hostname, { server, url, since: Date.now() });
  try {
    const { check } = await mountUrl(session, policy, { url, mode: opts.mode });
    return {
      serving: url,
      file: basename(path),
      size,
      mountCheck: check,
      note: "the HTTP server lives as long as the media stays mounted; it stops on unmount or session end",
    };
  } catch (err) {
    // mountWithHTTP can succeed device-side while its response is lost. Stop
    // the fresh server only when a follow-up state read proves this URL is not
    // mounted; unknown or matching state must keep the server alive.
    try {
      const state = await getMountState(session);
      if (state?.url !== url) stopServeServer(session);
    } catch {
      // state unknown: keep serving
    }
    throw err;
  }
}

export function serveSnapshot(session: DeviceSession): Record<string, unknown> | null {
  const entry = serveRegistry().get(session.auth.hostname);
  return entry ? { url: entry.url, since: new Date(entry.since).toISOString() } : null;
}
