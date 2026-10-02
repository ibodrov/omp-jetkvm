/**
 * Input hold/release semantics across the tool ↔ transaction boundary:
 * mouse down must actually hold, up/release_all must release at the last
 * pointer position, teardown must drain parked holds, and connect backoff
 * must happen before the input mutex is taken.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildKeyboardTool, buildMouseTool, buildScreenshotTool, type ToolDefinitionLike, type ZodLike } from "../src/tools.ts";
import { ConnectionManager, DeviceSession, sharedAuthState } from "../src/connection.ts";
import { createDeviceLocks, type DeviceLocks } from "../src/concurrency.ts";
import { heldInputReleases, registerHeldRelease, runInputTransaction } from "../src/input.ts";
import { JETKVM_CONFIG_DEFAULTS, type JetKvmConfig } from "../src/config.ts";
import { JetKvmError } from "../src/util.ts";

const HOST = "10.243.0.1"; // never dialed: a fake session is injected below

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

interface SimulatedInput {
  modifier: number;
  keys: number[];
  buttons: number;
  pointer: { x: number; y: number };
  videoAvailable: boolean;
  rejectKeyboardRelease: boolean;
  rejectMouseRelease: boolean;
}
interface ConnectionGate {
  waiting: Promise<void> | null;
  started: { promise: Promise<void>; resolve(): void } | null;
}

const fixtures: DeviceSession[] = [];
afterEach(() => {
  const key = Symbol.for("omp-jetkvm.registry");
  const globals = globalThis as Record<symbol, { sessions: Map<string, DeviceSession> } | undefined>;
  for (const fixture of fixtures) {
    for (const release of heldInputReleases(fixture)) release();
    if (globals[key]?.sessions.get(fixture.auth.origin) === fixture) globals[key]?.sessions.delete(fixture.auth.origin);
  }
  fixtures.length = 0;
});

function fakeSession() {
  const calls: RecordedCall[] = [];
  const locks: DeviceLocks = createDeviceLocks(1_000);
  const state: SimulatedInput = {
    modifier: 0, keys: [], buttons: 0, pointer: { x: 0, y: 0 },
    videoAvailable: true, rejectKeyboardRelease: false, rejectMouseRelease: false,
  };
  const connection: ConnectionGate = { waiting: null, started: null };
  const session = {
    name: "default",
    auth: { hostname: HOST, origin: `http://${HOST}`, tokenRotatedRecently: () => false },
    locks,
    state: "idle",
    lastMouse: null as { x: number; y: number } | null,
    ensureClaim: () => {},
    async ensureConnected() {
      connection.started?.resolve();
      if (connection.waiting) await connection.waiting;
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "getVideoState") return { width: state.videoAvailable ? 1920 : 0, height: state.videoAvailable ? 1080 : 0 };
      if (method === "getKeyDownState") return { modifier: state.modifier, keys: state.keys };
      if (method === "keyboardReport") {
        const modifier = params["modifier"];
        const keys = params["keys"];
        if (typeof modifier !== "number" || !Array.isArray(keys) || keys.some((key) => typeof key !== "number")) {
          throw new Error("invalid simulated keyboard report");
        }
        if (modifier === 0 && state.rejectKeyboardRelease) throw new JetKvmError("RpcError", "injected keyboard release rejection");
        state.modifier = modifier;
        state.keys = keys.filter((key): key is number => typeof key === "number" && key !== 0);
      }
      if (method === "absMouseReport") {
        const buttons = params["buttons"];
        const x = params["x"];
        const y = params["y"];
        if (typeof buttons !== "number" || typeof x !== "number" || typeof y !== "number") {
          throw new Error("invalid simulated mouse report");
        }
        if (buttons === 0 && state.rejectMouseRelease) throw new JetKvmError("RpcError", "injected mouse release rejection");
        state.buttons = buttons;
        state.pointer = { x, y };
      }
      return null;
    },
    async videoDims() {
      if (!state.videoAvailable) throw new JetKvmError("NoVideoSignal", "injected video loss");
      return { width: 1920, height: 1080 };
    },
  };
  // Inject into the process-global registry so ConnectionManager.session()
  // hands out the fake (same normalized-origin key it uses).
  const registryKey = Symbol.for("omp-jetkvm.registry");
  const g = globalThis as Record<symbol, { sessions: Map<string, DeviceSession> } | undefined>;
  if (!g[registryKey]) g[registryKey] = { sessions: new Map() };
  // Only the input session surface is needed by this fault-injection fixture.
  const fixture = session as unknown as DeviceSession;
  g[registryKey]!.sessions.set(`http://${HOST}`, fixture);
  fixtures.push(fixture);
  return { session: fixture, calls, locks, state, connection };
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

const cfg: JetKvmConfig = { ...structuredClone(JETKVM_CONFIG_DEFAULTS), devices: { default: { host: HOST } } };

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

describe("release safety", () => {
  test("explicit release position persists through later coordinate-free releases", async () => {
    const { session, state } = fakeSession();
    await run(mouseTool(), { action: "down", x: 100, y: 100 });
    await run(mouseTool(), { action: "up", x: 200, y: 300 });
    const releasedAt = { ...state.pointer };
    await run(keyboardTool(), { action: "release_all" });
    expect(state.pointer).toEqual(releasedAt);
    expect(session.lastMouse).toEqual(releasedAt);
    expect(state.buttons).toBe(0);
  });

  test("video loss cannot prevent releasing a held button", async () => {
    const { state, locks } = fakeSession();
    await run(mouseTool(), { action: "down", x: 100, y: 100 });
    const heldAt = { ...state.pointer };
    state.videoAvailable = false;
    const result = await run(mouseTool(), { action: "up", x: 200, y: 300 });
    expect(result.isError).toBeFalsy();
    expect(state.buttons).toBe(0);
    expect(state.pointer).toEqual(heldAt);
    expect(locks.input.holderInfo.held).toBe(false);
  });

  test("keyboard release rejection is reported while mouse release still runs", async () => {
    const { state, locks } = fakeSession();
    await run(keyboardTool(), { action: "down", keys: "ctrl" });
    state.buttons = 1;
    state.rejectKeyboardRelease = true;
    const result = await run(keyboardTool(), { action: "release_all" });
    expect(result).toMatchObject({ isError: true, details: { code: "InputReleaseFailed" } });
    expect(state.modifier).toBe(1);
    expect(state.buttons).toBe(0);
    expect(locks.input.holderInfo.held).toBe(false);
  });

  test("mouse release rejection is not reported as success", async () => {
    const { state, locks } = fakeSession();
    await run(mouseTool(), { action: "down", x: 100, y: 100 });
    state.rejectMouseRelease = true;
    const result = await run(mouseTool(), { action: "up" });
    expect(result).toMatchObject({ isError: true, details: { code: "InputReleaseFailed" } });
    expect(state.buttons).toBe(1);
    expect(state.modifier).toBe(0);
    expect(locks.input.holderInfo.held).toBe(false);
  });

  test("successful work cannot hide failed transaction cleanup", async () => {
    const { session, state, locks } = fakeSession();
    const pending = runInputTransaction(session, "cleanup-failure", async (tx) => {
      await tx.keyboardReport(1, []);
      await tx.mouseReport(10, 20, 1);
      state.rejectKeyboardRelease = true;
      state.rejectMouseRelease = true;
      return "work completed";
    });
    await expect(pending).rejects.toMatchObject({
      code: "InputReleaseFailed",
      details: { failedReports: [
        { report: "keyboard", code: "RpcError" },
        { report: "mouse", code: "RpcError" },
      ] },
    });
    expect(state.modifier).toBe(1);
    expect(state.buttons).toBe(1);
    expect(locks.input.holderInfo.held).toBe(false);
  });

  test("ambiguous manual hold reports its failed cleanup rather than only the lost response", async () => {
    const { session, state, locks } = fakeSession();
    const original = session.call.bind(session);
    session.call = async (method, params = {}, options = {}) => {
      const result = await original(method, params, options);
      if (method === "keyboardReport" && params["modifier"] === 1) {
        throw new JetKvmError("RpcTimeout", "injected lost hold acknowledgement");
      }
      return result;
    };
    state.rejectKeyboardRelease = true;
    const result = await run(keyboardTool(), { action: "down", keys: "ctrl" });
    expect(result).toMatchObject({ isError: true, details: { code: "InputReleaseFailed" } });
    expect(state.modifier).toBe(1);
    expect(locks.input.holderInfo.held).toBe(false);
  });
});


describe("connection recovery does not block the input queue", () => {
  test.each(["move", "down"])("%s leaves input available while its connection is pending", async (action) => {
    const { locks, connection } = fakeSession();
    const gate = Promise.withResolvers<void>();
    connection.waiting = gate.promise;
    connection.started = Promise.withResolvers<void>();
    const pending = run(mouseTool(), { action, x: 10, y: 10 });
    await connection.started.promise;
    try {
      expect(locks.input.holderInfo.held).toBe(false);
      const release = await locks.input.acquire("other-caller");
      release();
    } finally {
      gate.resolve();
    }
    const result = await pending;
    expect(result.isError).toBeFalsy();
    await run(keyboardTool(), { action: "release_all" });
    expect(locks.input.holderInfo.held).toBe(false);
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
  test("a failed keyboard cleanup still attempts mouse cleanup", async () => {
    const mouseReports: Record<string, unknown>[] = [];
    const locks = createDeviceLocks(1_000);
    let failKeyboardCleanup = true;
    const session = {
      auth: { tokenRotatedRecently: () => false },
      locks,
      lastMouse: null,
      async ensureConnected() {},
      ensureClaim() {},
      async call(method: string, params: Record<string, unknown> = {}) {
        if (method === "getKeyDownState") return { modifier: 0, keys: [0, 0, 0, 0, 0, 0] };
        if (method === "keyboardReport" && params["modifier"] === 0 && failKeyboardCleanup) {
          failKeyboardCleanup = false;
          throw new Error("keyboard cleanup response lost");
        }
        if (method === "absMouseReport") mouseReports.push(params);
        return null;
      },
    } as unknown as DeviceSession;

    const operationError = new Error("injected operation failure");
    await expect(
      runInputTransaction(session, "cleanup-test", async (tx) => {
        await tx.keyboardReport(1, []);
        await tx.mouseReport(10, 20, 1);
        throw operationError;
      }),
    ).rejects.toMatchObject({ code: "InputReleaseFailed", cause: operationError });
    expect(mouseReports).toContainEqual({ x: 10, y: 20, buttons: 1 });
    expect(mouseReports).toContainEqual({ x: 10, y: 20, buttons: 0 });
    expect(locks.input.holderInfo.held).toBe(false);
  });

});
describe("teardown drains parked holds", () => {
  test("dispose releases a parked manual hold's mutex", async () => {
    // Real DeviceSession: dispose() runs the production teardown path.
    const real = new DeviceSession("drain-test", { host: "10.243.0.99" }, cfg);
    const release = await real.locks.input.acquire("holder-x");
    registerHeldRelease(real, release);
    expect(real.locks.input.holderInfo.held).toBe(true);
    await real.dispose();
    expect(real.locks.input.holderInfo.held).toBe(false);
  });
});

describe("sharedAuthState", () => {
  test("one AuthState per device origin across lookups and sessions", async () => {
    const a = sharedAuthState({ host: HOST });
    const b = sharedAuthState({ host: `http://${HOST}/` });
    const c = sharedAuthState({ host: "10.243.0.2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const multi: JetKvmConfig = {
      ...cfg,
      devices: { one: { host: HOST }, two: { host: `http://${HOST}/` } },
    };
    const mgr = new ConnectionManager(multi);
    expect(mgr.session("one")).toBe(mgr.session("two"));
    await mgr.session("one").dispose();
  });
});
