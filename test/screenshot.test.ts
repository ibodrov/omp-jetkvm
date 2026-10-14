import { describe, expect, test, vi } from "bun:test";
import { watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JETKVM_CONFIG_DEFAULTS, type DeviceConfig, type JetKvmConfig } from "../src/config.ts";
import { BrowserEngine } from "../src/screenshot/engine-browser.ts";
import { writeScreenshotFile } from "../src/screenshot/engine.ts";
import { RecorderEngine } from "../src/screenshot/engine-recorder.ts";
import type { CaptureOptions } from "../src/screenshot/engine.ts";
import { mkdtempSync, mkdirSync, chmodSync, statSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { Browser, Page } from "puppeteer-core";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

interface VoidGate {
  promise: Promise<void>;
  resolve(): void;
}

// Model decoded screens at the Chromium boundary, retaining the real engine's
// startup, reconnect, idle, cancellation, and teardown paths.
function browserFixture() {
  const cfg = structuredClone(JETKVM_CONFIG_DEFAULTS) as JetKvmConfig;
  cfg.screenshot.idleTimeoutMs = 1_000;
  const engine = new BrowserEngine("unused-fixture-chromium", { host: "http://idle-camera.example" }, cfg);
  const control = engine as unknown as {
    page: Page | null;
    browser: Browser | null;
    chromiumProc: ChildProcess | null;
    launchPage(): Promise<Page>;
    connectBridge(page: Page): Promise<void>;
  };
  const screens: Array<{
    closed: boolean;
    peer: number;
    closing: VoidGate;
    browserClosed: VoidGate;
    closeGate?: Promise<void>;
    frameGate?: Promise<void>;
    frameStarted: VoidGate;
    ageMs: number;
  }> = [];
  control.launchPage = async () => {
    const generation = screens.length + 1;
    const screen: (typeof screens)[number] = {
      closed: false, peer: 0, ageMs: 0,
      closing: Promise.withResolvers<void>(),
      browserClosed: Promise.withResolvers<void>(),
      frameStarted: Promise.withResolvers<void>(),
    };
    screens.push(screen);
    const page = {
      isClosed: () => screen.closed,
      reload: async () => {
        if (screen.closed) throw new Error("page closed");
        screen.peer++;
      },
      evaluate: async () => {
        if (screen.closed) throw new Error("page closed");
        return {
          fullB64: `screen-${generation}-peer-${screen.peer}`,
          modelB64: `screen-${generation}-peer-${screen.peer}`,
          width: 1920, height: 1080, ageMs: screen.ageMs,
        };
      },
      close: async () => {
        screen.closing.resolve();
        await screen.closeGate;
        screen.closed = true;
      },
    } as unknown as Page;
    control.page = page;
    control.browser = {
      close: async () => { screen.browserClosed.resolve(); },
    } as unknown as Browser;
    return page;
  };
  control.connectBridge = async () => {
    const screen = screens.at(-1)!;
    screen.frameStarted.resolve();
    await screen.frameGate;
    if (screen.closed) throw new Error("page closed during frame wait");
  };
  return { engine, screens, control };
}

const options: CaptureOptions = { format: "png", quality: 80, maxModelWidth: 800 };

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "omp-shot-test-"));
}

describe("screenshot artifacts", () => {
  test("secures an existing directory and writes distinct private files", () => {
    const root = temporaryDirectory();
    const dir = join(root, "public");
    try {
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      const payloads = ["first payload", "second payload", "third payload"];
      const paths = payloads.map((value) => writeScreenshotFile(Buffer.from(value).toString("base64"), "image/png", dir));
      expect(new Set(paths).size).toBe(payloads.length);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(payloads);
      expect(paths.every((path) => (statSync(path).mode & 0o777) === 0o600)).toBe(true);
      expect(readdirSync(dir)).toHaveLength(payloads.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browser screenshot launch", () => {
  test("rejects an invalid Chromium executable without an uncaught child error", async () => {
    const cfg = structuredClone(JETKVM_CONFIG_DEFAULTS) as JetKvmConfig;
    cfg.screenshot.idleTimeoutMs = 60_000;
    const engine = new BrowserEngine("/definitely/missing/chromium-for-screenshot-test", {
      host: "http://camera.example",
    }, cfg);
    await expect(engine.capture(options)).rejects.toMatchObject({ code: "ChromiumLaunchFailed" });
    await engine.dispose();
  });
});

describe("browser screenshot lifecycle", () => {
  test("captures a new screen after releasing idle Chromium resources", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    try {
      expect((await engine.capture(options)).fullData).toBe("screen-1-peer-1");
      vi.advanceTimersByTime(1_000);
      await screens[0]!.browserClosed.promise;
      expect(screens[0]!.closed).toBe(true);
      expect((await engine.capture(options)).fullData).toBe("screen-2-peer-1");
    } finally {
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("a capture spanning the idle deadline keeps its page until completion", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    const frame = Promise.withResolvers<void>();
    try {
      await engine.capture(options);
      vi.advanceTimersByTime(900);
      screens[0]!.frameGate = frame.promise;
      screens[0]!.frameStarted = Promise.withResolvers<void>();
      const capture = engine.capture(options);
      await screens[0]!.frameStarted.promise;
      vi.advanceTimersByTime(2_000);
      expect(screens[0]!.closed).toBe(false);
      frame.resolve();
      expect((await capture).fullData).toBe("screen-1-peer-2");
      vi.advanceTimersByTime(999);
      expect(screens[0]!.closed).toBe(false);
      vi.advanceTimersByTime(1);
      await screens[0]!.browserClosed.promise;
      expect(screens[0]!.closed).toBe(true);
    } finally {
      frame.resolve();
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("a capture arriving during idle cleanup waits before opening a fresh page", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    const closing = Promise.withResolvers<void>();
    try {
      await engine.capture(options);
      screens[0]!.closeGate = closing.promise;
      vi.advanceTimersByTime(1_000);
      await screens[0]!.closing.promise;
      let settled = false;
      const capture = engine.capture(options).finally(() => { settled = true; });
      // Observe rejection immediately even in the failing-before run.
      void capture.catch(() => {});
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(screens).toHaveLength(1);
      closing.resolve();
      expect((await capture).fullData).toBe("screen-2-peer-1");
      expect(screens[0]!.closed).toBe(true);
      expect(screens[1]!.closed).toBe(false);
      expect((await engine.capture(options)).fullData).toBe("screen-2-peer-2");
    } finally {
      closing.resolve();
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("caller cancellation stays prompt while idle teardown is blocked", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    const closing = Promise.withResolvers<void>();
    const controller = new AbortController();
    try {
      await engine.capture(options);
      screens[0]!.closeGate = closing.promise;
      vi.advanceTimersByTime(1_000);
      await screens[0]!.closing.promise;
      const capture = engine.capture({ ...options, signal: controller.signal });
      controller.abort();
      await expect(capture).rejects.toMatchObject({ code: "Aborted" });
      vi.advanceTimersByTime(2_000);
      closing.resolve();
      expect((await engine.capture(options)).fullData).toBe("screen-2-peer-1");
      expect(screens[1]!.closed).toBe(false);
    } finally {
      closing.resolve();
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("idle cleanup drains canceled signaling without closing a later capture's page", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    const frame = Promise.withResolvers<void>();
    const controller = new AbortController();
    try {
      await engine.capture(options);
      screens[0]!.frameGate = frame.promise;
      screens[0]!.frameStarted = Promise.withResolvers<void>();
      const canceled = engine.capture({ ...options, signal: controller.signal });
      await screens[0]!.frameStarted.promise;
      controller.abort();
      await expect(canceled).rejects.toMatchObject({ code: "Aborted" });
      vi.advanceTimersByTime(1_000);
      expect(screens[0]!.closed).toBe(false);
      const next = engine.capture(options);
      frame.resolve();
      expect((await next).fullData).toBe("screen-1-peer-3");
      vi.advanceTimersByTime(1_000);
      await screens[0]!.browserClosed.promise;
      expect(screens[0]!.closed).toBe(true);
    } finally {
      frame.resolve();
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("terminal disposal during idle cleanup rejects waiting and future captures", async () => {
    vi.useFakeTimers();
    const { engine, screens } = browserFixture();
    const closing = Promise.withResolvers<void>();
    try {
      await engine.capture(options);
      screens[0]!.closeGate = closing.promise;
      vi.advanceTimersByTime(1_000);
      await screens[0]!.closing.promise;
      const capture = engine.capture(options);
      void capture.catch(() => {});
      const disposal = engine.dispose();
      closing.resolve();
      await disposal;
      await expect(capture).rejects.toMatchObject({ code: "Aborted" });
      await expect(engine.capture(options)).rejects.toMatchObject({ code: "Aborted" });
      expect(screens).toHaveLength(1);
    } finally {
      closing.resolve();
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test("terminal disposal does not publish pixels from an in-flight capture", async () => {
    const { engine, screens } = browserFixture();
    const frame = Promise.withResolvers<void>();
    try {
      await engine.capture(options);
      screens[0]!.frameGate = frame.promise;
      screens[0]!.frameStarted = Promise.withResolvers<void>();
      const capture = engine.capture(options);
      void capture.catch(() => {});
      await screens[0]!.frameStarted.promise;
      const disposal = engine.dispose();
      frame.resolve();
      await disposal;
      await expect(capture).rejects.toMatchObject({ code: "Aborted" });
      expect(screens[0]!.closed).toBe(true);
    } finally {
      frame.resolve();
      await engine.dispose();
    }
  });

  test("stale pixels are rejected and replaced by a freshly negotiated screen", async () => {
    const { engine, screens } = browserFixture();
    try {
      await engine.capture(options);
      screens[0]!.ageMs = 5_001;
      expect((await engine.capture(options)).fullData).toBe("screen-2-peer-1");
      expect(screens[0]!.closed).toBe(true);
    } finally {
      await engine.dispose();
    }
  });

  test("idle cleanup awaits a wedged Chromium's exit before a new capture", async () => {
    const { engine, screens, control } = browserFixture();
    const ready = Promise.withResolvers<void>();
    const terminating = Promise.withResolvers<void>();
    const child = spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => process.stdout.write("terminating\\n"));
      process.stdout.write("ready\\n");
      process.stdin.resume();
    `], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdout!.on("data", (data: Buffer) => {
      if (String(data).includes("ready")) ready.resolve();
      if (String(data).includes("terminating")) terminating.resolve();
    });
    child.once("error", ready.reject);
    try {
      await ready.promise;
      vi.useFakeTimers();
      await engine.capture(options);
      control.chromiumProc = child;
      vi.advanceTimersByTime(1_000);
      await terminating.promise;
      const capture = engine.capture(options);
      void capture.catch(() => {});
      await Promise.resolve();
      expect(screens).toHaveLength(1);
      vi.advanceTimersByTime(2_000);
      expect((await capture).fullData).toBe("screen-2-peer-1");
      expect(child.signalCode).toBe("SIGKILL");
      expect(screens[1]!.closed).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test.each(["SIGTERM", "SIGKILL"] as const)("idle cleanup recovers when %s returns false without an exit event", async (failedSignal) => {
    vi.useFakeTimers();
    const { engine, screens, control } = browserFixture();
    const attempted = Promise.withResolvers<void>();
    // Model a process disappearing at the signaling boundary, not an actual PID.
    const child = Object.assign(new EventEmitter(), {
      pid: 12345, exitCode: null, signalCode: null,
      kill(signal: NodeJS.Signals) {
        attempted.resolve();
        return signal !== failedSignal;
      },
    });
    try {
      await engine.capture(options);
      control.chromiumProc = child as unknown as ChildProcess;
      vi.advanceTimersByTime(1_000);
      await attempted.promise;
      const capture = engine.capture(options);
      void capture.catch(() => {});
      if (failedSignal === "SIGKILL") vi.advanceTimersByTime(2_000);
      expect((await capture).fullData).toBe("screen-2-peer-1");
      expect(screens[0]!.closed).toBe(true);
      expect(screens[1]!.closed).toBe(false);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      child.emit("exit");
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  test.each([
    ["SIGTERM", "throw"], ["SIGKILL", "throw"],
    ["SIGTERM", "emit"], ["SIGKILL", "emit"],
  ] as const)("terminal disposal surfaces %s %s failure instead of hanging", async (failedSignal, mode) => {
    vi.useFakeTimers();
    const { engine, control } = browserFixture();
    const attempted = Promise.withResolvers<void>();
    const failure = new Error("injected signaling failure");
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 12345, exitCode: null, signalCode: null,
      kill(signal: NodeJS.Signals) {
        attempted.resolve();
        if (signal !== failedSignal) return true;
        if (mode === "throw") throw failure;
        events.emit("error", failure);
        return false;
      },
    });
    try {
      await engine.capture(options);
      control.chromiumProc = child as unknown as ChildProcess;
      const disposal = engine.dispose();
      void disposal.catch(() => {});
      await attempted.promise;
      if (failedSignal === "SIGKILL") vi.advanceTimersByTime(2_000);
      await expect(disposal).rejects.toBe(failure);
      await expect(engine.capture(options)).rejects.toMatchObject({ code: "Aborted" });
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      child.emit("exit");
      await engine.dispose();
      vi.useRealTimers();
    }
  });
});

describe("recorder screenshot process", () => {
  test("authenticates with normalized HTTPS origin and effective credential", async () => {
    const root = temporaryDirectory();
    const executable = join(root, "recorder");
    const passwordFile = join(root, "fallback-password");
    writeFileSync(passwordFile, "file-password", { mode: 0o600 });
    writeFileSync(executable, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in --host) host="$2"; shift 2;; --password-file) pwd="$2"; shift 2;; --screenshot-output) out="$2"; shift 2;; *) shift;; esac\ndone\n[ "$host" = 'https://camera.example:8443' ] && [ \"$(cat \"$pwd\")\" = 'preferred-secret' ] && [ \"$(stat -c %a \"$pwd\")\" = '600' ] || { echo 'authentication failed' >&2; exit 9; }\nprintf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=' | base64 -d > \"$out\"\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const dev = {
      name: "test", host: "https://camera.example:8443/", password: "preferred-secret",
      passwordEnv: "OMP_TEST_MISSING_PASSWORD", passwordFile,
    } as DeviceConfig;
    try {
      const engine = new RecorderEngine(executable, dev);
      const result = await engine.capture(options);
      expect(result.fullMime).toBe("image/png");
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      const wrongEngine = new RecorderEngine(executable, { ...dev, password: "rejected-secret" });
      let failure: unknown;
      try {
        await wrongEngine.capture(options);
      } catch (err) {
        failure = err;
      }
      expect(failure).toMatchObject({ code: "RecorderFailed" });
      expect(String(failure)).not.toContain("rejected-secret");
      await wrongEngine.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dispose kills and settles a pending capture", async () => {
    const root = temporaryDirectory();
    const executable = join(root, "recorder");
    const started = join(root, "started");
    writeFileSync(executable, `#!/bin/sh\ntouch '${started}'\nexec sleep 60\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const engine = new RecorderEngine(executable, {
      name: "test", host: "http://camera.example", password: "secret", passwordEnv: "", passwordFile: "",
    } as DeviceConfig);
    try {
      const watcherAbort = new AbortController();
      const watcher = watch(root, { signal: watcherAbort.signal });
      const capture = engine.capture(options);
      if (!existsSync(started)) {
        for await (const _ of watcher) if (existsSync(started)) break;
      }
      watcherAbort.abort();
      await engine.dispose();
      await expect(capture).rejects.toMatchObject({ code: "Aborted" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds a recorder that never writes output", async () => {
    const root = temporaryDirectory();
    const executable = join(root, "recorder");
    const started = join(root, "started");
    writeFileSync(executable, `#!/bin/sh\ntouch '${started}'\nexec sleep 60\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const engine = new RecorderEngine(executable, {
      host: "http://camera.example", password: "secret",
    } as DeviceConfig);
    const watcherAbort = new AbortController();
    const watcher = watch(root, { signal: watcherAbort.signal });
    vi.useFakeTimers();
    try {
      const capture = engine.capture(options);
      if (!existsSync(started)) {
        for await (const _ of watcher) if (existsSync(started)) break;
      }
      watcherAbort.abort();
      vi.advanceTimersByTime(30_000);
      await expect(capture).rejects.toMatchObject({ code: "RecorderTimeout" });
      await engine.dispose();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
