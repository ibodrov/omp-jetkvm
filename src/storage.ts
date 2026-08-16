/**
 * Storage / virtual media. DESIGN §4.4 + §2.4.
 *
 * Uploads are resumable (device keeps `<name>.incomplete`). serve_and_mount
 * runs a Range-capable HTTP server whose lifetime is bound to the mount.
 */
import type { BunFile } from "bun";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { JetKvmError, humanBytes, pickLanIp } from "./util.ts";
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

function firmwareLacks(err: unknown, method: string): boolean {
  return deviceCodeOf(err) === -32601 && err instanceof JetKvmError;
}

export async function listFiles(session: DeviceSession): Promise<{ files: { filename: string; size: number; createdAt: string }[] }> {
  const r = (await session.call("listStorageFiles", {}, { retryOnReconnect: true })) as { files?: unknown[] } | null;
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

export async function getSpace(session: DeviceSession): Promise<{ bytesUsed: number; bytesFree: number }> {
  return (await session.call("getStorageSpace", {}, { retryOnReconnect: true })) as { bytesUsed: number; bytesFree: number };
}

export async function getMountState(session: DeviceSession): Promise<VirtualMediaState | null> {
  return (await session.call("getVirtualMediaState", {}, { retryOnReconnect: true })) as VirtualMediaState | null;
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
  opts: { url: string; mode?: MountMode },
): Promise<{ check: Record<string, unknown> }> {
  let check: Record<string, unknown> = {};
  try {
    check = (await session.call("checkMountUrl", { url: opts.url }, { timeoutMs: 15_000 })) as Record<string, unknown>;
  } catch (err) {
    // Firmware 0.5.8 quirk: checkMountUrl probes the URL (we see the GET)
    // but its handler errors internally (-32603). Treat as advisory only;
    // mountWithHTTP below is the real gate and works.
    check = { usable: null, note: `checkMountUrl RPC failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (check["usable"] === false) {
    throw new JetKvmError("MountUrlUnusable", `device cannot mount ${opts.url}: ${String(check["reason"] ?? "no reason given")}`, { check });
  }
  await clearSlot(session, policy);
  try {
    await session.call("mountWithHTTP", { url: opts.url, mode: opts.mode ?? "CDROM" }, { timeoutMs: MOUNT_TIMEOUT_MS });
  } catch (err) {
    if (firmwareLacks(err, "mountWithHTTP")) {
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
  try {
    await session.call("unmountImage", {}, { timeoutMs: MOUNT_TIMEOUT_MS });
  } finally {
    // Server death while media stays mounted wedges the device's storage
    // handler (observed live); always stop serving when leaving unmount.
    stopServeServer(session);
  }
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
  const filename = opts.filename ?? basename(path);
  const space = await getSpace(session);
  const margin = opts.minFreeBytes ?? Math.max(stat.size * 0.05, 64 * 1024 * 1024);
  if (space.bytesFree < stat.size + margin) {
    throw new JetKvmError(
      "StorageFull",
      `device has ${humanBytes(space.bytesFree)} free but the file is ${humanBytes(stat.size)} (margin ${humanBytes(margin)}) — delete files or use serve_and_mount (no device storage needed)`,
    );
  }
  const start = (await session.call("startStorageFileUpload", { filename, size: stat.size })) as {
    alreadyUploadedBytes: number;
    dataChannel: string;
  };
  const offset = Math.max(0, Math.min(start.alreadyUploadedBytes, stat.size));
  if (offset >= stat.size) {
    return { filename, totalBytes: stat.size, resumedFrom: offset, state: await getMountState(session) };
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
    `/storage/upload?uploadId=${encodeURIComponent(start.dataChannel)}`,
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

export async function serveAndMount(
  session: DeviceSession,
  policy: PolicyConfig,
  opts: { path: string; mode?: MountMode; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const path = opts.path;
  if (!existsSync(path)) {
    throw new JetKvmError("FileNotFound", `no such file: ${path}`);
  }
  const size = statSync(path).size;
  const lanIp = pickLanIp();
  if (!lanIp) {
    throw new JetKvmError("NoLanAddress", "no non-internal IPv4 address found to advertise to the device");
  }
  stopServeServer(session);
  const file: BunFile = Bun.file(path);
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
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
  const url = `http://${lanIp}:${server.port}/iso`;
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
    stopServeServer(session);
    throw err;
  }
}

export function serveSnapshot(session: DeviceSession): Record<string, unknown> | null {
  const entry = serveRegistry().get(session.auth.hostname);
  return entry ? { url: entry.url, since: new Date(entry.since).toISOString() } : null;
}
