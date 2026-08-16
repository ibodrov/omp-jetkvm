/**
 * Screenshot engine contract + auto selection. DESIGN §3.2.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JetKvmError, timestampName } from "../util.ts";
import { findRecorderBin, RecorderEngine } from "./engine-recorder.ts";
import type { DeviceConfig, JetKvmConfig } from "../config.ts";

/** Write a capture's full-res bytes to the screenshot dir; returns the path. */
export function writeScreenshotFile(fullB64: string, mime: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = mime === "image/png" ? "png" : "jpg";
  const path = join(dir, `jetkvm_${timestampName()}.${ext}`);
  // Sync on purpose: the tool reports success with this path; a deferred
  // write could fail after the fact (or reject unhandled) on ENOSPC etc.
  writeFileSync(path, Buffer.from(fullB64, "base64"));
  return path;
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
  // Config values are not schema-validated at load; catch unknowns here so
  // a typo reports itself instead of silently falling through to "auto".
  const wanted: string = cfg.screenshot.engine;
  if (wanted !== "auto" && wanted !== "browser" && wanted !== "recorder") {
    throw new JetKvmError("ConfigError", `unknown screenshot engine "${wanted}" — use auto, browser, or recorder`);
  }
  if (wanted === "browser" || wanted === "auto") {
    const chromium = findChromium(cfg.screenshot.chromiumPath);
    if (chromium) {
      // Lazy + runtime-built specifier: omp's loader pre-walks literal
      // dynamic imports and forces ESM over the snapshot, which breaks
      // puppeteer-core's CJS deps (tslib & friends). A computed specifier
      // keeps the walk empty; the module loads natively at selection time.
      const browserEngineModule = "./engine-browser" + ".ts";
      const { BrowserEngine } = (await import(browserEngineModule)) as {
        BrowserEngine: new (path: string, dev: DeviceConfig, cfg: JetKvmConfig) => ScreenshotEngine;
      };
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
