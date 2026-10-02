/**
 * Screenshot engine contract + auto selection. DESIGN §3.2.
 */
import { chmodSync, closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, statSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JetKvmError } from "../util.ts";
import { findRecorderBin, RecorderEngine } from "./engine-recorder.ts";
import type { DeviceConfig, JetKvmConfig } from "../config.ts";
import { BrowserEngine } from "./engine-browser.ts";

export function writeScreenshotFile(fullB64: string, mime: string, dir: string): string {
  let directory: Stats;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    directory = lstatSync(dir);
  } catch (err) {
    throw new JetKvmError("ScreenshotStorageFailed", `cannot prepare screenshot directory: ${String(err)}`);
  }
  if (directory.isSymbolicLink() || !directory.isDirectory() ||
      (typeof process.getuid === "function" && directory.uid !== process.getuid())) {
    throw new JetKvmError("ScreenshotStorageFailed", "screenshot directory must be a real directory owned by this user");
  }
  chmodSync(dir, 0o700);
  const verified = statSync(dir);
  if ((verified.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && verified.uid !== process.getuid())) {
    throw new JetKvmError("ScreenshotStorageFailed", "screenshot directory is not private");
  }
  const ext = mime === "image/png" ? "png" : "jpg";
  const bytes = Buffer.from(fullB64, "base64");
  for (;;) {
    const path = join(dir, `jetkvm_${Date.now()}_${randomUUID()}.${ext}`);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    return path;
  }
}

export interface CaptureOptions {
  format: "jpeg" | "png";
  /** JPEG quality 0–100 (browser engine). */
  quality: number;
  /** Max inline width for the model copy (browser engine). */
  maxModelWidth: number;
  signal?: AbortSignal;
}

export interface CaptureResult {
  /** Base64 of the model-sized inline copy. */
  modelData: string;
  modelMime: string;
  /** Base64 of the full-resolution artifact (written to disk by the tool). */
  fullData: string;
  fullMime: string;
  width: number;
  height: number;
}

export interface ScreenshotEngine {
  readonly name: string;
  capture(opts: CaptureOptions): Promise<CaptureResult>;
  dispose(): Promise<void>;
}

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-unstable",
  "/usr/bin/microsoft-edge",
];

const CHROMIUM_BIN_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "google-chrome-unstable",
  "microsoft-edge",
];

export function findChromium(explicitPath: string): string | null {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : null;
  for (const env of ["CHROME_PATH", "CHROMIUM_PATH", "OMP_JETKVM_CHROMIUM"]) {
    const v = process.env[env];
    if (v && existsSync(v)) return v;
  }
  // PATH lookup before absolute guesses — covers macOS/Homebrew/custom prefixes.
  for (const name of CHROMIUM_BIN_NAMES) {
    const p = Bun.which(name);
    if (p) return p;
  }
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function selectEngine(cfg: JetKvmConfig, dev: DeviceConfig): Promise<ScreenshotEngine> {
  // Also validate direct in-memory callers that bypass config loading.
  const wanted: string = cfg.screenshot.engine;
  if (wanted !== "auto" && wanted !== "browser" && wanted !== "recorder") {
    throw new JetKvmError("ConfigError", `unknown screenshot engine "${wanted}" — use auto, browser, or recorder`);
  }
  if (wanted === "browser" || wanted === "auto") {
    const chromium = findChromium(cfg.screenshot.chromiumPath);
    if (chromium) {
      return new BrowserEngine(chromium, dev, cfg);
    }
    if (wanted === "browser") {
      throw new JetKvmError(
        "NoChromium",
        'no Chromium found — set jetkvm.screenshot.chromiumPath or CHROME_PATH, or switch engine to "recorder"',
      );
    }
  }
  const recorderBin = findRecorderBin(cfg.screenshot.recorderPath);
  if (recorderBin) {
    return new RecorderEngine(recorderBin, dev);
  }
  if (wanted === "recorder") {
    throw new JetKvmError("NoRecorder", "recorder-for-jetkvm binary not found — set jetkvm.screenshot.recorderPath");
  }
  throw new JetKvmError(
    "NoScreenshotEngine",
    'no screenshot engine available: install Chromium (browser engine) or recorder-for-jetkvm (recorder engine), or configure screenshot.engine/chromiumPath/recorderPath explicitly',
  );
}
