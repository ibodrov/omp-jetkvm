import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The failure is process-fatal by definition, so reproduce it in a child Bun
 * process. Its cwd deliberately excludes this repo's defensive bunfig preload.
 */
test("remote peer reboot cannot crash the extension process", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-jetkvm-reboot-"));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "helpers/remote-reboot-probe.ts")],
      cwd,
      env: { ...process.env, DEBUG: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout: stdout.trim(), stderr }).toEqual({
      exitCode: 0,
      stdout: "survived remote reboot",
      stderr: "",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);
