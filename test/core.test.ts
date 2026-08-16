import { acquireCrossProcessClaim, AsyncMutex, holderIsLive, peekCrossProcessClaim } from "../src/concurrency.ts";
import { JetKvmError } from "../src/util.ts";
import { describe, expect, test } from "bun:test";
import { parseRange } from "../src/storage.ts";
import { policyGate } from "../src/intercept.ts";
import { loadJetKvmConfig, resetConfigCache, resolveDevice, splitOrigin } from "../src/config.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeScreenshotFile } from "../src/screenshot/engine.ts";
describe("AsyncMutex", () => {
  test("serializes holders", async () => {
    const m = new AsyncMutex("input", 1_000);
    const order: string[] = [];
    const r1 = await m.acquire("a");
    expect(m.holderInfo).toMatchObject({ held: true, holder: "a" });
    const p2 = m.acquire("b").then((r) => {
      order.push("b-acquired");
      return r;
    });
    r1();
    const r2 = await p2;
    expect(order).toEqual(["b-acquired"]);
    r2();
  });

  test("contention fails fast with holder info", async () => {
    // The queue timeout IS the mechanism under test; awaiting its rejection
    // (a real signal) is the deterministic observable. 30ms real cost.
    const m = new AsyncMutex("storage", 30);
    const release = await m.acquire("holder-1");
    await expect(m.acquire("holder-2")).rejects.toThrow(/storage transaction could not start.*holder-1/);
    release();
  });


  test("release passes lock to the next waiter (FIFO)", async () => {
    const m = new AsyncMutex("input", 5_000);
    const r1 = await m.acquire("one");
    const p2 = m.acquire("two");
    const p3 = m.acquire("three");
    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();
    expect(m.holderInfo.held).toBe(false);
  });
  test("pre-aborted waiters fail without entering the queue", async () => {
    const mutex = new AsyncMutex("input", 1_000);
    const controller = new AbortController();
    controller.abort();
    await expect(mutex.acquire("cancelled", controller.signal)).rejects.toThrow(/aborted/);
    expect(mutex.holderInfo.held).toBe(false);
  });

});

describe("parseRange (serve_and_mount)", () => {
  test("null header = full", () => {
    expect(parseRange(null, 100)).toBe("full");
  });
  test("explicit range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });
  test("suffix range = last N bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-2000", 1000)).toEqual({ start: 0, end: 999 });
  });
  test("clamped end", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  test("invalid forms", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=", 1000)).toBe("invalid");
    expect(parseRange("chunks=1-2", 1000)).toBe("invalid");
  });
});

describe("policyGate (intercept)", () => {
  const policy = { allowPowerActions: true, allowUsbDisconnect: false, forceUnmountOnMount: true };

  test("non-jetkvm tools pass untouched", () => {
    expect(policyGate(policy, { toolName: "bash", input: {} })).toBeUndefined();
  });
  test("power action gated by allowPowerActions", () => {
    const r = policyGate({ ...policy, allowPowerActions: false }, { toolName: "jetkvm_device", input: { action: "power", op: "atx-short" } });
    expect(r).toMatchObject({ block: true });
  });
  test("power reads always allowed", () => {
    expect(policyGate({ ...policy, allowPowerActions: false }, { toolName: "jetkvm_device", input: { action: "power", op: "atx-state" } })).toBeUndefined();
  });
  test("usb disconnect gated", () => {
    expect(policyGate(policy, { toolName: "jetkvm_device", input: { action: "usb", enabled: false } })).toMatchObject({ block: true });
    expect(policyGate(policy, { toolName: "jetkvm_device", input: { action: "usb", enabled: true } })).toBeUndefined();
    expect(policyGate(policy, { toolName: "jetkvm_device", input: { action: "usb" } })).toBeUndefined();
  });
  test("delete_file without filename blocked", () => {
    expect(policyGate(policy, { toolName: "jetkvm_storage", input: { action: "delete_file" } })).toMatchObject({ block: true });
    expect(policyGate(policy, { toolName: "jetkvm_storage", input: { action: "delete_file", filename: "x.iso" } })).toBeUndefined();
  });
});

describe("config", () => {
  const tmp = "/tmp/omp-jetkvm-test";

  test("loads jetkvm key from project config with defaults", () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/.omp`, { recursive: true });
    writeFileSync(
      `${tmp}/.omp/config.yml`,
      ["jetkvm:", "  devices:", "    lab:", `      host: 10.0.0.9`, "  session:", "    rpcTimeoutMs: 2500"].join("\n"),
    );
    const cfg = loadJetKvmConfig(tmp);
    expect(cfg.devices["lab"]?.host).toBe("10.0.0.9");
    expect(cfg.session.rpcTimeoutMs).toBe(2500);
    expect(cfg.session.idleTimeoutMs).toBe(600_000);
    expect(cfg.policy.forceUnmountOnMount).toBe(true);
    expect(cfg.concurrency.crossProcess).toBe("lock");
    const dev = resolveDevice(cfg, "lab");
    expect(dev.host).toBe("10.0.0.9");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("project config overrides user config", () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/.omp/agent`, { recursive: true });
    writeFileSync(
      `${tmp}/.omp/agent/config.yml`,
      ["jetkvm:", "  devices:", "    default:", "      host: 10.0.0.1", "  session:", "    rpcTimeoutMs: 1000"].join("\n"),
    );
    writeFileSync(
      `${tmp}/.omp/config.yml`,
      ["jetkvm:", "  devices:", "    default:", "      host: 10.0.0.2", "  session:", "    rpcTimeoutMs: 2000"].join("\n"),
    );
    const previousHome = process.env.HOME;
    process.env.HOME = tmp;
    resetConfigCache();
    try {
      const cfg = loadJetKvmConfig(tmp);
      expect(cfg.devices["default"]?.host).toBe("10.0.0.2");
      expect(cfg.session.rpcTimeoutMs).toBe(2000);
    } finally {
      process.env.HOME = previousHome;
      resetConfigCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("invalid nested config fails at load time", () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/.omp`, { recursive: true });
    writeFileSync(`${tmp}/.omp/config.yml`, ["jetkvm:", "  screenshot: null"].join("\n"));
    const previousHome = process.env.HOME;
    process.env.HOME = tmp;
    resetConfigCache();
    try {
      expect(() => loadJetKvmConfig(tmp)).toThrow(/jetkvm\.screenshot must be a mapping/);
    } finally {
      process.env.HOME = previousHome;
      resetConfigCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveDevice names the problem when unconfigured", () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    // Isolate from this machine's real user config (~/.omp/agent/config.yml).
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      resetConfigCache();
      const cfg = loadJetKvmConfig(tmp);
      expect(() => resolveDevice(cfg, "default")).toThrow(/no JetKVM device is configured/);
    } finally {
      process.env.HOME = prevHome;
      resetConfigCache();
    }
  });

  test("splitOrigin handles scheme-less hosts and ports", () => {
    expect(splitOrigin("192.168.1.100")).toEqual({ origin: "http://192.168.1.100", hostname: "192.168.1.100", secure: false });
    expect(splitOrigin("https://kvm.example.com:8443/")).toEqual({ origin: "https://kvm.example.com:8443", hostname: "kvm.example.com", secure: true });
  });
});

describe("JetKvmError shape", () => {
  test("carries code + details", () => {
    const e = new JetKvmError("InputBusy", "held", { holder: "x" });
    expect(e.code).toBe("InputBusy");
    expect(e.details).toEqual({ holder: "x" });
    expect(e.name).toBe("JetKvmError");
  });
});

describe("cross-process claim liveness (pid reuse)", () => {
  test("a live claim is recognized via pid + start time", () => {
    const claim = acquireCrossProcessClaim("claim-test.local", { enabled: true });
    expect(holderIsLive(claim.info)).toBe(true);
    claim.release();
    expect(peekCrossProcessClaim("claim-test.local")).toBeNull();
  });

  test("a second live claim is rejected synchronously", () => {
    const first = acquireCrossProcessClaim("claim-contention-test.local", { enabled: true });
    try {
      expect(() =>
        acquireCrossProcessClaim("claim-contention-test.local", { enabled: true }),
      ).toThrow(/claimed/);
    } finally {
      first.release();
    }
  });

  test("same pid but wrong start time reads as dead (pid was recycled)", () => {
    expect(holderIsLive({ pid: process.pid, since: 0, startTicks: 999_999_999 })).toBe(false);
  });
  test("no start time recorded falls back to plain pid liveness", () => {
    expect(holderIsLive({ pid: process.pid, since: 0 })).toBe(true);
    expect(holderIsLive({ pid: 4_000_000, since: 0 })).toBe(false);
  });
});

describe("writeScreenshotFile", () => {
  test("fails synchronously on an unwritable path (no deferred rejection)", () => {
    // /dev/null/foo is ENOTDIR — the write must throw here, not after return.
    expect(() => writeScreenshotFile("AAAA", "image/jpeg", "/dev/null/omp-jetkvm")).toThrow();
  });
});
