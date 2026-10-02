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
