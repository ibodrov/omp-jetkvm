/**
 * serve_and_mount retirement safety: a serve server must never die while the
 * media it serves is still mounted (the documented device wedge), and policy
 * refusal must leave the old server alive.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { deleteFile, mountFile, mountUrl, retireServeServer, serveAndMount, shutdownServe, stopServeServer, unmount, type VirtualMediaState } from "../src/storage.ts";
import type { DeviceSession } from "../src/connection.ts";
import type { PolicyConfig } from "../src/config.ts";
import { rmSync, writeFileSync } from "node:fs";

const HOSTNAME = "retire-test.local";
const ORIGIN = `http://${HOSTNAME}`;

const POLICY: PolicyConfig = { allowPowerActions: true, allowUsbDisconnect: false, forceUnmountOnMount: true };

interface RecordedCall {
  method: string;
}

function makeServeEntry(): { url: string; stop: () => void } {
  let stopped = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("x"),
  });
  return {
    url: `http://127.0.0.1:${server.port}/iso`,
    stop: () => {
      if (!stopped) {
        stopped = true;
        server.stop(true);
      }
    },
  };
}

function serveRegistryMap(): Map<string, unknown> {
  const key = Symbol.for("omp-jetkvm.serve");
  const g = globalThis as Record<symbol, Map<string, unknown> | undefined>;
  if (!g[key]) g[key] = new Map();
  return g[key]!;
}

function injectServeEntry(url: string, stop: () => void): void {
  serveRegistryMap().set(ORIGIN, { server: { stop }, url, since: Date.now() });
}

function serveEntryExists(): boolean {
  return serveRegistryMap().has(ORIGIN);
}
function fakeSession(mountedUrl: string | null | Error): { session: DeviceSession; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const session = {
    auth: { hostname: HOSTNAME, origin: ORIGIN },
    state: "connected",
    async call(method: string) {
      calls.push({ method });
      if (method === "getVirtualMediaState") {
        if (mountedUrl instanceof Error) throw mountedUrl;
        return mountedUrl ? { source: "HTTP", mode: "CDROM", url: mountedUrl } : null;
      }
      return null;
    },
  };
  return { session: session as unknown as DeviceSession, calls };
}

function mediaDevice(origin: string) {
  const model: { media: VirtualMediaState | null } = { media: null };
  const endpoint = {
    auth: { hostname: "127.0.0.1", origin },
    state: "connected",
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === "getVirtualMediaState") return model.media;
      if (method === "checkMountUrl") return { usable: true };
      if (method === "unmountImage") model.media = null;
      if (method === "mountWithStorage") {
        const filename = params["filename"];
        if (typeof filename !== "string") throw new Error("invalid storage mount");
        model.media = { source: "Storage", filename, mode: "CDROM" };
      }
      if (method === "mountWithHTTP") {
        const url = params["url"];
        if (typeof url !== "string") throw new Error("invalid HTTP mount");
        model.media = { source: "HTTP", url, mode: "CDROM" };
      }
      return null;
    },
  };
  // This fixture models the remote media slot, not the local transport.
  const session = endpoint as unknown as DeviceSession;
  return { session, model };
}

describe("retireServeServer", () => {
  beforeEach(() => {
    serveRegistryMap().delete(ORIGIN); // never inherit a previous test's entry
  });

  test("unmounts before stopping when the served media is still mounted", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session, calls } = fakeSession(entry.url);
    await retireServeServer(session, POLICY);
    expect(calls.map((c) => c.method)).toEqual(["getVirtualMediaState", "unmountImage"]);
    expect(serveEntryExists()).toBe(false);
  });

  test("foreign mount: stops the server without unmounting", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session, calls } = fakeSession("http://elsewhere/iso");
    await retireServeServer(session, POLICY);
    expect(calls.map((c) => c.method)).toEqual(["getVirtualMediaState"]);
    expect(serveEntryExists()).toBe(false);
  });

  test("device unreachable: keeps the server alive and reports uncertainty", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session } = fakeSession(new Error("rpc dead"));
    await expect(retireServeServer(session, POLICY)).rejects.toThrow(/keeping its server alive/);
    expect(serveEntryExists()).toBe(true);
    entry.stop();
    serveRegistryMap().delete(ORIGIN);
  });

  test("policy refusal propagates and leaves the server alive", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session, calls } = fakeSession(entry.url);
    await expect(
      retireServeServer(session, { ...POLICY, forceUnmountOnMount: false }),
    ).rejects.toThrow(/already mounted/);
    expect(calls.map((c) => c.method)).toEqual(["getVirtualMediaState"]);
    expect(serveEntryExists()).toBe(true); // no wedge: server still serving
    entry.stop();
    serveRegistryMap().delete(ORIGIN);
  });

  test("no previous entry: no-op", async () => {
    const { session, calls } = fakeSession(null);
    await retireServeServer(session, POLICY);
    expect(calls).toEqual([]);
  });
});

test("same-host devices retain independent mounted image servers", async () => {
  const first = mediaDevice("http://127.0.0.1:41001");
  const second = mediaDevice("http://127.0.0.1:41002");
  const path = `/tmp/omp-media-${crypto.randomUUID()}.img`;
  writeFileSync(path, "independent image", { mode: 0o600 });
  try {
    const a = await serveAndMount(first.session, POLICY, { path });
    const b = await serveAndMount(second.session, POLICY, { path });
    expect(first.model.media).toMatchObject({ source: "HTTP", url: a["serving"] });
    expect(second.model.media).toMatchObject({ source: "HTTP", url: b["serving"] });
    expect((await fetch(String(a["serving"]))).status).toBe(200);
    expect((await fetch(String(b["serving"]))).status).toBe(200);
  } finally {
    stopServeServer(first.session);
    stopServeServer(second.session);
    rmSync(path, { force: true });
  }
});

test("shutdown reconnects an idle session and unmounts before stopping", async () => {
  const entry = makeServeEntry();
  injectServeEntry(entry.url, entry.stop);
  const { session, calls } = fakeSession(entry.url);
  (session as unknown as { state: string }).state = "idle";
  await shutdownServe(session);
  expect(calls.map((call) => call.method)).toEqual(["getVirtualMediaState", "unmountImage"]);
  expect(serveEntryExists()).toBe(false);
  let serverStopped = false;
  try {
    await fetch(entry.url);
  } catch {
    serverStopped = true;
  }
  expect(serverStopped).toBe(true);
});
test("file replacement stops the obsolete HTTP server after mount succeeds", async () => {
  const { session, model } = mediaDevice("http://127.0.0.1:41003");
  const path = `/tmp/omp-media-${crypto.randomUUID()}.img`;
  writeFileSync(path, "obsolete image", { mode: 0o600 });
  try {
    const served = await serveAndMount(session, POLICY, { path });
    const url = String(served["serving"]);
    expect((await fetch(url)).status).toBe(200);
    await mountFile(session, POLICY, { filename: "replacement.iso" });
    expect(model.media).toEqual({ source: "Storage", filename: "replacement.iso", mode: "CDROM" });
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    stopServeServer(session);
    rmSync(path, { force: true });
  }
});

test("other URL replacement stops the previous HTTP server", async () => {
  const { session, model } = mediaDevice("http://127.0.0.1:41004");
  const other = makeServeEntry();
  const path = `/tmp/omp-media-${crypto.randomUUID()}.img`;
  writeFileSync(path, "obsolete image", { mode: 0o600 });
  try {
    const served = await serveAndMount(session, POLICY, { path });
    const url = String(served["serving"]);
    expect((await fetch(url)).status).toBe(200);
    await mountUrl(session, POLICY, { url: other.url });
    expect(model.media).toEqual({ source: "HTTP", url: other.url, mode: "CDROM" });
    await expect(fetch(url)).rejects.toThrow();
    expect((await fetch(other.url)).status).toBe(200);
  } finally {
    stopServeServer(session);
    other.stop();
    rmSync(path, { force: true });
  }
});

test("aborted retirement leaves mounted media and its server untouched", async () => {
  const entry = makeServeEntry();
  injectServeEntry(entry.url, entry.stop);
  const controller = new AbortController();
  const session = {
    auth: { hostname: HOSTNAME, origin: ORIGIN },
    async call(method: string) {
      if (method === "getVirtualMediaState") {
        controller.abort();
        return { source: "HTTP", url: entry.url };
      }
      throw new Error(`unexpected mutation: ${method}`);
    },
  } as unknown as DeviceSession;
  await expect(retireServeServer(session, POLICY, controller.signal)).rejects.toThrow(/aborted/);
  expect(serveEntryExists()).toBe(true);
  entry.stop();
  serveRegistryMap().delete(ORIGIN);
});

test("mount URL preflight transport failures are not treated as advisory", async () => {
  const session = {
    auth: { hostname: HOSTNAME },
    async call(method: string) {
      if (method === "checkMountUrl") throw new Error("device unreachable");
      throw new Error(`unexpected RPC ${method}`);
    },
  } as unknown as DeviceSession;
  await expect(mountUrl(session, POLICY, { url: "http://127.0.0.1/iso" })).rejects.toThrow(/device unreachable/);
});

test("cancelled mount URL preflight sends no mutation", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const session = {
    auth: { hostname: HOSTNAME, origin: ORIGIN },
    async call(method: string) {
      methods.push(method);
      controller.abort();
      return {};
    },
  } as unknown as DeviceSession;
  await expect(mountUrl(session, POLICY, { url: "http://127.0.0.1/iso", signal: controller.signal })).rejects.toThrow(/aborted/);
  expect(methods).toEqual(["checkMountUrl"]);
});

test("cancelled storage preflight sends no delete mutation", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const session = {
    auth: { hostname: HOSTNAME, origin: ORIGIN },
    async call(method: string, _params: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) {
      if (options.signal?.aborted) throw new Error("aborted before mutation");
      methods.push(method);
      if (method === "getStorageSpace") {
        controller.abort();
        return { bytesUsed: 0, bytesFree: 1_000 };
      }
      return null;
    },
  } as unknown as DeviceSession;
  await expect(deleteFile(session, "old.iso", controller.signal)).rejects.toThrow(/aborted/);
  expect(methods).toEqual(["getStorageSpace"]);
});

describe("unmount server safety", () => {
  test("an ambiguous unmount failure leaves the server running", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const session = {
      auth: { hostname: HOSTNAME, origin: ORIGIN },
      async call(method: string) {
        if (method === "unmountImage") throw new Error("response lost");
        return null;
      },
    } as unknown as DeviceSession;
    await expect(unmount(session)).rejects.toThrow(/response lost/);
    expect(serveEntryExists()).toBe(true);
    entry.stop();
    serveRegistryMap().delete(ORIGIN);
  });

  test("a lost mount response keeps a server that the device reports mounted", async () => {
    const path = "/tmp/omp-jetkvm-serve-response-lost.iso";
    writeFileSync(path, Buffer.alloc(4_096));
    let mountedUrl: string | null = null;
    const session = {
      auth: { hostname: "127.0.0.1", origin: "http://127.0.0.1" },
      state: "connected",
      async call(method: string, params: Record<string, unknown> = {}) {
        if (method === "getVirtualMediaState") {
          return mountedUrl ? { source: "HTTP", mode: "CDROM", url: mountedUrl } : null;
        }
        if (method === "checkMountUrl") return {};
        if (method === "mountWithHTTP") {
          mountedUrl = String(params["url"]);
          throw new Error("response lost");
        }
        return null;
      },
    } as unknown as DeviceSession;
    try {
      await expect(
        serveAndMount(session, POLICY, { path }),
      ).rejects.toThrow(/response lost/);
      expect(serveRegistryMap().has("http://127.0.0.1")).toBe(true);
    } finally {
      serveRegistryMap().delete("http://127.0.0.1");
    }
  });
});
