/**
 * Extension factory resilience: a broken config must not unregister the tool
 * surface — the tools stay registered and surface the config error on every
 * call. Also exercises the full module graph (import-cycle canary).
 */
import { describe, expect, test } from "bun:test";
import jetkvmExtension from "../src/index.ts";
import { resetConfigCache } from "../src/config.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
    isError?: boolean;
  }>;
}

function fakePi(): { tools: RegisteredTool[]; pi: Parameters<typeof jetkvmExtension>[0] } {
  const tools: RegisteredTool[] = [];
  // Leaves carry a method-form .optional(): the factory re-wraps it as a
  // function on top of pi.zod (see index.ts).
  const leaf = (): { optional: () => unknown } => ({ optional: () => ({}) });
  const pi = {
    zod: {
      object: (shape: Record<string, unknown>) => ({ parse: (v: unknown) => v, ...({ shape } as object) }),
      string: leaf,
      number: leaf,
      boolean: leaf,
      enum: leaf,
      array: leaf,
    },
    registerTool: (def: RegisteredTool) => tools.push(def),
    registerCommand: () => {},
    on: () => {},
    setLabel: () => {},
    logger: { info: () => {}, warn: () => {} },
  };
  return { tools, pi: pi as unknown as Parameters<typeof jetkvmExtension>[0] };
}

describe("extension factory", () => {
  const tmp = "/tmp/omp-jetkvm-ext-test";

  test("broken YAML: 5 tools registered, each call surfaces the parse error", async () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/.omp`, { recursive: true });
    writeFileSync(`${tmp}/.omp/config.yml`, "jetkvm: [1, 2");
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(tmp);
    process.env.HOME = tmp;
    resetConfigCache();
    try {
      const { tools, pi } = fakePi();
      await jetkvmExtension(pi);
      expect(tools.map((t) => t.name).sort()).toEqual([
        "jetkvm_device",
        "jetkvm_keyboard",
        "jetkvm_mouse",
        "jetkvm_screenshot",
        "jetkvm_storage",
      ]);
      const r = await tools[0]!.execute("id", {});
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/config error/i);
    } finally {
      process.chdir(prevCwd);
      process.env.HOME = prevHome;
      resetConfigCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no devices configured: tools still registered, calls explain setup", async () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(tmp);
    process.env.HOME = tmp;
    resetConfigCache();
    try {
      const { tools, pi } = fakePi();
      await jetkvmExtension(pi);
      expect(tools.length).toBe(5);
      const shot = tools.find((t) => t.name === "jetkvm_screenshot")!;
      const r = await shot.execute("id", { action: "state" });
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/no JetKVM device is configured/);
    } finally {
      process.chdir(prevCwd);
      process.env.HOME = prevHome;
      resetConfigCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
