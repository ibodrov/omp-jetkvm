import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a cancelled waiter still observes its already-started operation's rejection", async () => {
  const utility = resolve(import.meta.dir, "../src/util.ts");
  const child = Bun.spawn([process.execPath, "--eval", `
    import { abortable, JetKvmError } from ${JSON.stringify(utility)};
    const controller = new AbortController();
    controller.abort();
    const operation = Promise.withResolvers();
    const observed = { aborted: false, unhandled: false };
    process.on("unhandledRejection", () => { observed.unhandled = true; });
    process.once("beforeExit", () => { console.log(JSON.stringify(observed)); });
    try {
      await abortable(operation.promise, controller.signal, "cancelled waiter");
    } catch (error) {
      observed.aborted = error instanceof JetKvmError && error.code === "Aborted";
    }
    operation.reject(new Error("injected late operation failure"));
  `], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const observed: unknown = JSON.parse(stdout);
  if (typeof observed !== "object" || observed === null || !("aborted" in observed) || !("unhandled" in observed)) {
    throw new Error(`invalid isolated operation observation: ${stderr}`);
  }
  expect(observed).toEqual({ aborted: true, unhandled: false });
  expect(exitCode).toBe(0);
});
