/**
 * Input hold/release semantics across the tool ↔ transaction boundary:
 * mouse down must actually hold, up/release_all must release at the last
 * pointer position, teardown must drain parked holds, and connect backoff
 * must happen before the input mutex is taken.
 */
import { describe, expect, test } from "bun:test";
import { buildKeyboardTool, buildMouseTool, buildScreenshotTool, type ToolDefinitionLike, type ZodLike } from "../src/tools.ts";
import { ConnectionManager, DeviceSession, sharedAuthState } from "../src/connection.ts";
import { createDeviceLocks, type DeviceLocks } from "../src/concurrency.ts";
import { registerHeldRelease, runInputTransaction } from "../src/input.ts";
import type { JetKvmConfig } from "../src/config.ts";

const HOST = "10.243.0.1"; // never dialed: a fake session is injected below

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeSession() {
  const calls: RecordedCall[] = [];
  const order: string[] = [];
  const locks: DeviceLocks = createDeviceLocks(1_000);
  const realAcquire = locks.input.acquire.bind(locks.input);
  locks.input.acquire = (holder: string) => {
    order.push("acquire");
    return realAcquire(holder);
  };
  const session = {
    name: "default",
    auth: { hostname: HOST, origin: `http://${HOST}`, tokenRotatedRecently: () => false },
    locks,
    state: "idle",
    lastMouse: null as { x: number; y: number } | null,
    ensureClaim: () => {},
    async ensureConnected() {
      order.push("ensureConnected");
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "getVideoState") return { width: 1920, height: 1080 };
      if (method === "getKeyDownState") return { modifier: 0, keys: [0, 0, 0, 0, 0, 0] };
      return null;
    },
    async videoDims() {
      return { width: 1920, height: 1080 };
    },
  };
  // Inject into the process-global registry so ConnectionManager.session()
  // hands out the fake (same normalized-origin key it uses).
  const registryKey = Symbol.for("omp-jetkvm.registry");
  const g = globalThis as Record<symbol, { sessions: Map<string, DeviceSession> } | undefined>;
  if (!g[registryKey]) g[registryKey] = { sessions: new Map() };
  g[registryKey]!.sessions.set(`http://${HOST}`, session as unknown as DeviceSession);
  return { session: session as unknown as DeviceSession, calls, order, locks };
}
function fakeZ(): ZodLike {
  const leaf = (): unknown => ({ kind: "leaf" });
  return {
    object: (shape: Record<string, unknown>) => ({ parse: (v: unknown) => v, ...({ shape } as Record<string, unknown>) }),
    string: leaf,
    number: leaf,
    boolean: leaf,
    enum: () => ({ kind: "enum" }),
    array: () => ({ kind: "array" }),
    optional: (el: unknown) => el,
  } as unknown as ZodLike;
}

const cfg = { devices: { default: { host: HOST } } } as unknown as JetKvmConfig;

function mouseTool(): ToolDefinitionLike {
  return buildMouseTool(cfg, fakeZ());
}

function keyboardTool(): ToolDefinitionLike {
  return buildKeyboardTool(cfg, fakeZ());
}

async function run(def: ToolDefinitionLike, params: Record<string, unknown>) {
  return def.execute("toolcallid1234", params, new AbortController().signal, undefined, {});
}

describe("mouse down/up manual holds", () => {
  test("down holds the button — no auto-release at call end, mutex parked", async () => {
    const { calls, locks } = fakeSession();
    const r = await run(mouseTool(), { action: "down", x: 960, y: 540 });
    expect(r.isError).toBeFalsy();
    const mouse = calls.filter((c) => c.method === "absMouseReport").map((c) => c.params);
    // pixelToHid(960,1920)=16392, pixelToHid(540,1080)=16399; buttons stay down.
    expect(mouse).toEqual([{ x: 16392, y: 16399, buttons: 1 }]);
    expect(locks.input.holderInfo).toMatchObject({ held: true });
  });

  test("up releases everything at the given position and unparks the mutex", async () => {
    const { calls, locks } = fakeSession();
    await run(mouseTool(), { action: "down", x: 100, y: 100 });
    await run(mouseTool(), { action: "up", x: 200, y: 300 });
    const mouse = calls.filter((c) => c.method === "absMouseReport").map((c) => c.params);
    expect(mouse[mouse.length - 1]).toMatchObject({ buttons: 0 });
    expect(locks.input.holderInfo.held).toBe(false);
  });

  test("up without x/y releases at the last known pointer position, not the corner", async () => {
    const { calls } = fakeSession();
    await run(mouseTool(), { action: "down", x: 1280, y: 720 });
    await run(mouseTool(), { action: "up" });
    const last = calls.filter((c) => c.method === "absMouseReport").map((c) => c.params).pop();
    expect(last).toMatchObject({ buttons: 0 });
    expect(last?.x).toBeGreaterThan(0);
    expect(last?.y).toBeGreaterThan(0);
  });
});

describe("screenshot state", () => {
  test("does not require a configured screenshot engine", async () => {
    fakeSession();
    const result = await run(buildScreenshotTool(cfg, fakeZ()), { action: "state" });
    expect(result.isError).toBeFalsy();
    expect(result.details?.videoState).toEqual({ width: 1920, height: 1080 });
  });
});

describe("keyboard release_all pointer handling", () => {
  test("releases mouse buttons at the last reported position", async () => {
    const { session, calls } = fakeSession();
    // Simulate a prior mouse move through a transaction (updates lastMouse).
    const mouse = mouseTool();
    await run(mouse, { action: "move", x: 1919, y: 1079 });
    expect(session.lastMouse).toEqual({ x: 32767, y: 32767 });
    await run(keyboardTool(), { action: "release_all" });
    const last = calls.filter((c) => c.method === "absMouseReport").map((c) => c.params).pop();
    expect(last).toEqual({ x: 32767, y: 32767, buttons: 0 }); // no corner teleport
  });
});

describe("connect-before-mutex ordering", () => {
  test("input transactions connect before acquiring the input mutex", async () => {
    const { order } = fakeSession();
    await run(mouseTool(), { action: "move", x: 10, y: 10 });
    expect(order.indexOf("ensureConnected")).toBeLessThan(order.indexOf("acquire"));
  });
  test("manual keyboard holds connect before acquiring the input mutex", async () => {
    const { order } = fakeSession();
    await run(keyboardTool(), { action: "down", keys: "right-ctrl" });
    await run(keyboardTool(), { action: "release_all" });
    expect(order.indexOf("ensureConnected")).toBeLessThan(order.indexOf("acquire"));
  });

});
describe("ambiguous input failures", () => {
  test("a lost key-down response still triggers a zero cleanup report", async () => {
    const reports: Record<string, unknown>[] = [];
    const locks = createDeviceLocks(1_000);
    const session = {
      auth: { tokenRotatedRecently: () => false },
      locks,
      lastMouse: null,
      async ensureConnected() {},
      ensureClaim() {},
      async call(method: string, params: Record<string, unknown> = {}) {
        if (method === "getKeyDownState") {
          return { modifier: 0, keys: [0, 0, 0, 0, 0, 0] };
        }
        if (method === "keyboardReport") {
          reports.push(params);
          if (params["modifier"] === 1) throw new Error("response lost");
        }
        return null;
      },
    } as unknown as DeviceSession;

    await expect(
      runInputTransaction(session, "failure-test", async (tx) => {
        await tx.keyboardReport(1, []);
      }),
    ).rejects.toThrow(/response lost/);
    expect(reports.map((report) => report["modifier"])).toEqual([1, 0]);
    expect(locks.input.holderInfo.held).toBe(false);
  });
});

describe("teardown drains parked holds", () => {
  test("dispose releases a parked manual hold's mutex", async () => {
    // Real DeviceSession: dispose() runs the production teardown path.
    const real = new DeviceSession("drain-test", { host: "10.243.0.99" }, {
      concurrency: { queueTimeoutMs: 1_000 },
    } as ConstructorParameters<typeof DeviceSession>[2]);
    const release = await real.locks.input.acquire("holder-x");
    registerHeldRelease(real, release);
    expect(real.locks.input.holderInfo.held).toBe(true);
    await real.dispose();
    expect(real.locks.input.holderInfo.held).toBe(false);
  });
});

describe("sharedAuthState", () => {
  test("one AuthState per device origin across lookups and sessions", () => {
    const a = sharedAuthState({ host: HOST });
    const b = sharedAuthState({ host: `http://${HOST}/` });
    const c = sharedAuthState({ host: "10.243.0.2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const multi: JetKvmConfig = {
      ...(cfg as JetKvmConfig),
      devices: { one: { host: HOST }, two: { host: `http://${HOST}/` } },
    } as JetKvmConfig;
    const mgr = new ConnectionManager(multi);
    expect(mgr.session("one")).toBe(mgr.session("two"));
  });
});
