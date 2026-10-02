/**
 * Engine `recorder`: one-shot `recorder-for-jetkvm --screenshot` subprocess.
 * DESIGN §3.2. PNG output; the model copy is the PNG itself (this engine
 * cannot downscale without a decoder — maxModelWidth is honored by the
 * browser engine only; documented in README).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JetKvmError } from "../util.ts";
import type { DeviceConfig } from "../config.ts";
import { resolvePassword, splitOrigin } from "../config.ts";
import type { CaptureOptions, CaptureResult, ScreenshotEngine } from "./engine.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Explicit config path, else PATH lookup. No machine-specific guesses. */
export function findRecorderBin(explicitPath: string): string | null {
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }
  return Bun.which("recorder-for-jetkvm") ?? null;
}

export class RecorderEngine implements ScreenshotEngine {
  readonly name = "recorder";
  private readonly bin: string;
  private readonly children = new Set<ChildProcess>();
  private readonly captures = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(bin: string, private readonly dev: DeviceConfig) {
    this.bin = bin;
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    if (this.disposed || opts.signal?.aborted) {
      throw new JetKvmError("Aborted", "recorder screenshot aborted");
    }
    const task = this.captureImpl(opts);
    this.captures.add(task);
    try {
      return await task;
    } finally {
      this.captures.delete(task);
    }
  }

  private async captureImpl(opts: CaptureOptions): Promise<CaptureResult> {
    const dir = mkdtempSync(join(tmpdir(), "omp-jetkvm-"));
    const outPath = join(dir, "frame.png");
    try {
      const password = resolvePassword(this.dev);
      if (password === null) {
        throw new JetKvmError("AuthFailed", "recorder engine needs a device password (password/passwordEnv/passwordFile)");
      }
      const pwdFile = join(dir, "pwd");
      writeFileSync(pwdFile, password, { mode: 0o600, flag: "wx" });
      const { origin } = splitOrigin(this.dev.host);
      const args = [
        "--host", origin,
        "--password-file", pwdFile,
        "--screenshot",
        "--screenshot-output", outPath,
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.bin, args, { stdio: ["ignore", "ignore", "ignore"] });
        this.children.add(child);
        let settled = false;
        const finish = (error?: JetKvmError): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          opts.signal?.removeEventListener("abort", onAbort);
          this.children.delete(child);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = (): void => {
          child.kill("SIGKILL");
          finish(new JetKvmError("Aborted", "recorder screenshot aborted"));
        };
        const deadline = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new JetKvmError("RecorderTimeout", "recorder screenshot timed out"));
        }, 30_000);
        child.once("error", () => finish(new JetKvmError("RecorderFailed", "failed to start recorder")));
        child.once("close", (code) => finish(
          this.disposed || opts.signal?.aborted
            ? new JetKvmError("Aborted", "recorder screenshot aborted")
            : code === 0 ? undefined : new JetKvmError("RecorderFailed", `recorder exited ${String(code)}`),
        ));
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        if (this.disposed || opts.signal?.aborted) onAbort();
      });
      if (!existsSync(outPath)) {
        throw new JetKvmError("RecorderFailed", "recorder produced no screenshot");
      }
      const png = readFileSync(outPath);
      if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new JetKvmError("RecorderFailed", "recorder produced a malformed PNG");
      }
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const b64 = png.toString("base64");
      return {
        modelData: b64,
        modelMime: "image/png",
        fullData: b64,
        fullMime: "image/png",
        width,
        height,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const child of this.children) child.kill("SIGKILL");
    await Promise.allSettled([...this.captures]);
  }
}

