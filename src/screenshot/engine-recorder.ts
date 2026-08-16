/**
 * Engine `recorder`: one-shot `recorder-for-jetkvm --screenshot` subprocess.
 * DESIGN §3.2. PNG output; the model copy is the PNG itself (this engine
 * cannot downscale without a decoder — maxModelWidth is honored by the
 * browser engine only; documented in README).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JetKvmError } from "../util.ts";
import type { DeviceConfig } from "../config.ts";
import { resolvePassword } from "../config.ts";
import type { CaptureOptions, CaptureResult, ScreenshotEngine } from "./engine.ts";

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

  constructor(bin: string, private readonly dev: DeviceConfig) {
    this.bin = bin;
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    const dir = mkdtempSync(join(tmpdir(), "omp-jetkvm-"));
    const outPath = join(dir, "frame.png");
    // The recorder takes a password *file*; materialize one only when the
    // config didn't provide one (0600, deleted after).
    try {
      let pwdFile: string | null = null;
      if (this.dev.passwordFile && existsSync(this.dev.passwordFile)) {
        pwdFile = this.dev.passwordFile;
      } else {
        const pw = resolvePassword(this.dev);
        if (pw === null) {
          throw new JetKvmError("AuthFailed", "recorder engine needs a device password (password/passwordEnv/passwordFile)");
        }
        pwdFile = join(dir, "pwd");
        writeFileSync(pwdFile, pw, { mode: 0o600 });
      }
      const hostArg = this.dev.host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const args = [
        "--host", hostArg,
        "--password-file", pwdFile,
        "--screenshot",
        "--screenshot-output", outPath,
      ];
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(0);
          else reject(new JetKvmError("RecorderFailed", `recorder exited ${code}: ${stderr.slice(-400)}`));
        });
        opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      });
      if (exitCode !== 0 || !existsSync(outPath)) {
        throw new JetKvmError("RecorderFailed", "recorder produced no screenshot");
      }
      const png = readFileSync(outPath);
      // PNG dimensions from IHDR (bytes 16..24), big-endian.
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
    // stateless one-shot engine
  }
}
