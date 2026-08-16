import { AsyncMutex } from "../src/concurrency.ts";
import { JetKvmError } from "../src/util.ts";
import { describe, expect, test } from "bun:test";
import { parseRange } from "../src/storage.ts";
import { policyGate } from "../src/intercept.ts";
import { loadJetKvmConfig, resetConfigCache, resolveDevice, splitOrigin } from "../src/config.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const policy = { allowPowerActions: true, allowReboot: false, allowUsbDisconnect: false, forceUnmountOnMount: true };

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
    expect(cfg.policy.allowReboot).toBe(false);
    expect(cfg.concurrency.crossProcess).toBe("lock");
    const dev = resolveDevice(cfg, "lab");
    expect(dev.host).toBe("10.0.0.9");
    rmSync(tmp, { recursive: true, force: true });
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
