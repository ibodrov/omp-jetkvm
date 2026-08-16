/**
 * serve_and_mount retirement safety: a serve server must never die while the
 * media it serves is still mounted (the documented device wedge), and policy
 * refusal must leave the old server alive.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { retireServeServer, serveAndMount, stopServeServer, unmount } from "../src/storage.ts";
import type { DeviceSession } from "../src/connection.ts";
import type { PolicyConfig } from "../src/config.ts";
import { rmSync, writeFileSync } from "node:fs";

const POLICY: PolicyConfig = { allowPowerActions: true, allowUsbDisconnect: false, forceUnmountOnMount: true };
const HOSTNAME = "retire-test.local";

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
  serveRegistryMap().set(HOSTNAME, { server: { stop }, url, since: Date.now() });
}

function serveEntryExists(): boolean {
  return serveRegistryMap().has(HOSTNAME);
}
function fakeSession(mountedUrl: string | null | Error): { session: DeviceSession; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const session = {
    auth: { hostname: HOSTNAME },
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
describe("retireServeServer", () => {
  beforeEach(() => {
    serveRegistryMap().delete(HOSTNAME); // never inherit a previous test's entry
  });

  test("unmounts before stopping when the served media is still mounted", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session, calls } = fakeSession(entry.url);
    await retireServeServer(session, POLICY);
    // clearSlot re-reads the mount state before unmounting.
    expect(calls.map((c) => c.method)).toEqual(["getVirtualMediaState", "getVirtualMediaState", "unmountImage"]);
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
    serveRegistryMap().delete(HOSTNAME);
  });

  test("policy refusal propagates and leaves the server alive", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const { session, calls } = fakeSession(entry.url);
    await expect(
      retireServeServer(session, { ...POLICY, forceUnmountOnMount: false }),
    ).rejects.toThrow(/already mounted/);
    // clearSlot re-reads the mount state before refusing.
    expect(calls.map((c) => c.method)).toEqual(["getVirtualMediaState", "getVirtualMediaState"]);
    expect(serveEntryExists()).toBe(true); // no wedge: server still serving
    entry.stop();
    serveRegistryMap().delete(HOSTNAME);
  });

  test("no previous entry: no-op", async () => {
    const { session, calls } = fakeSession(null);
    await retireServeServer(session, POLICY);
    expect(calls).toEqual([]);
  });
});

describe("unmount server safety", () => {
  test("an ambiguous unmount failure leaves the server running", async () => {
    const entry = makeServeEntry();
    injectServeEntry(entry.url, entry.stop);
    const session = {
      auth: { hostname: HOSTNAME },
      async call(method: string) {
        if (method === "unmountImage") throw new Error("response lost");
        return null;
      },
    } as unknown as DeviceSession;
    await expect(unmount(session)).rejects.toThrow(/response lost/);
    expect(serveEntryExists()).toBe(true);
    entry.stop();
    serveRegistryMap().delete(HOSTNAME);
  });

  test("a lost mount response keeps a server that the device reports mounted", async () => {
    const path = "/tmp/omp-jetkvm-serve-response-lost.iso";
    writeFileSync(path, Buffer.alloc(4_096));
    let mountedUrl: string | null = null;
    const session = {
      auth: { hostname: "127.0.0.1" },
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
      expect(serveRegistryMap().has("127.0.0.1")).toBe(true);
    } finally {
      stopServeServer(session);
      rmSync(path, { force: true });
    }
  });
});
