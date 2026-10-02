import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ClaimProbeResult {
  incompleteBlocked: boolean;
  malformedBlocked: boolean;
  replacementPreserved: boolean;
  thirdOwnerBlocked: boolean;
  released: boolean;
}

test("portable claims fail closed during publication and preserve replacement ownership", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-portable-claim-test-"));
  const module = resolve(import.meta.dir, "../src/concurrency.ts");
  const utility = resolve(import.meta.dir, "../src/util.ts");
  try {
    // Select the portable filesystem backend in an isolated process. This is
    // not a claim of native macOS validation; no global test state is changed.
    const child = Bun.spawn([process.execPath, "--eval", `
      import { closeSync, existsSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { acquireCrossProcessClaim, crossProcessClaimIsCurrent, peekCrossProcessClaim } from ${JSON.stringify(module)};
      import { JetKvmError } from ${JSON.stringify(utility)};
      Object.defineProperty(process, "platform", { value: "darwin" });
      const origin = "https://portable-claim-test.invalid:8443";
      const seed = acquireCrossProcessClaim(origin, { enabled: true });
      const metadata = seed.info;
      const publicationName = readdirSync(process.env.HOME, { recursive: true }).find(name => typeof name === "string" && name.endsWith(".json"));
      if (!publicationName) throw new Error("claim publication fixture unavailable");
      const path = join(process.env.HOME, publicationName);
      seed.release();
      const fd = openSync(path, "wx", 0o600);
      let incompleteBlocked = false;
      try {
        try { const unexpected = acquireCrossProcessClaim(origin, { enabled: true }); unexpected.release(); }
        catch (error) { incompleteBlocked = error instanceof JetKvmError && error.code === "DeviceBusy"; }
      } finally { closeSync(fd); if (existsSync(path)) unlinkSync(path); }
      writeFileSync(path, JSON.stringify({ ...metadata, startTicks: "invalid" }), { mode: 0o600 });
      let malformedBlocked = false;
      try {
        try { const unexpected = acquireCrossProcessClaim(origin, { enabled: true }); unexpected.release(); }
        catch (error) { malformedBlocked = error instanceof JetKvmError && error.code === "DeviceBusy"; }
      } finally { if (existsSync(path)) unlinkSync(path); }
      const first = acquireCrossProcessClaim(origin, { enabled: true });
      const replacement = acquireCrossProcessClaim(origin, { enabled: true, force: true });
      first.release();
      const replacementPreserved = crossProcessClaimIsCurrent(replacement) && peekCrossProcessClaim(origin)?.owner === replacement.info.owner;
      let thirdOwnerBlocked = false;
      try {
        try { const unexpected = acquireCrossProcessClaim(origin, { enabled: true }); unexpected.release(); }
        catch (error) { thirdOwnerBlocked = error instanceof JetKvmError && error.code === "DeviceBusy"; }
      } finally { replacement.release(); }
      const finalOwner = acquireCrossProcessClaim(origin, { enabled: true });
      finalOwner.release();
      console.log(JSON.stringify({ incompleteBlocked, malformedBlocked, replacementPreserved, thirdOwnerBlocked, released: peekCrossProcessClaim(origin) === null }));
    `], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`isolated claim probe failed: ${stderr}`);
    const observed: unknown = JSON.parse(stdout);
    if (typeof observed !== "object" || observed === null ||
      !("incompleteBlocked" in observed) || typeof observed.incompleteBlocked !== "boolean" ||
      !("malformedBlocked" in observed) || typeof observed.malformedBlocked !== "boolean" ||
      !("replacementPreserved" in observed) || typeof observed.replacementPreserved !== "boolean" ||
      !("thirdOwnerBlocked" in observed) || typeof observed.thirdOwnerBlocked !== "boolean" ||
      !("released" in observed) || typeof observed.released !== "boolean") throw new Error("invalid claim probe observation");
    const result = observed as ClaimProbeResult;
    expect(result).toEqual({ incompleteBlocked: true, malformedBlocked: true, replacementPreserved: true, thirdOwnerBlocked: true, released: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
