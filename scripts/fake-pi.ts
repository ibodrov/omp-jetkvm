/**
 * Load the extension factory with a minimal fake `pi`, then execute tools
 * directly against the live device — integration check without a full omp
 * session. Usage: bun scripts/fake-pi.ts <toolName> '<json params>'
 */
import jetkvmExtension from "../src/index.ts";
import type { ToolDefinitionLike, ZodLike } from "../src/tools.ts";

type Host = Parameters<typeof jetkvmExtension>[0];
type EventHandler = Parameters<Host["on"]>[1];

// The CLI supplies parsed JSON directly; leaves only need the host's
// method-form optional() so the real extension can register its schemas.
function fakeZ(): ZodLike {
  const leaf = (): { optional(): unknown } => ({ optional: leaf });
  return {
    object: () => ({
      parse: (v: unknown) => {
        if (typeof v !== "object" || v === null) throw new Error("params must be object");
        return v as Record<string, unknown>;
      },
    }),
    string: leaf,
    number: leaf,
    boolean: leaf,
    enum: leaf,
    array: leaf,
    optional: leaf,
  };
}

async function main(): Promise<number> {
  const tools = new Map<string, ToolDefinitionLike>();
  const handlers = new Map<string, EventHandler[]>();
  const ctx = { cwd: process.cwd() };
  try {
    await jetkvmExtension({
      zod: fakeZ(),
      registerTool: (tool) => { tools.set(tool.name, tool); },
      registerCommand: () => {},
      on: (event, handler) => {
        const listeners = handlers.get(event) ?? [];
        listeners.push(handler);
        handlers.set(event, listeners);
      },
      setLabel: () => {},
      logger: { info: console.error, warn: console.error },
    });

    const toolName = process.argv[2] ?? "";
    const tool = tools.get(toolName);
    if (!tool) {
      console.error(`unknown tool ${toolName}; available: ${[...tools.keys()].join(", ")}`);
      return 2;
    }
    const params = process.argv[3] ? JSON.parse(process.argv[3]) as Record<string, unknown> : {};
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({ toolName, input: params }, ctx);
      if (typeof result === "object" && result !== null && "block" in result && result.block === true) {
        console.error(`blocked: ${"reason" in result ? String(result.reason) : "tool call rejected"}`);
        return 1;
      }
    }

    const t0 = Date.now();
    const result = await tool.execute(
      `call-${Date.now()}`,
      params,
      new AbortController().signal,
      (u) => console.error("[update]", u.content.map((c) => c.text).join(" ")),
      ctx,
    );
    console.log(`[result in ${Date.now() - t0}ms] isError=${result.isError === true}`);
    for (const block of result.content) {
      if (block.type === "text") console.log(block.text);
      else if (block.type === "image") console.log(`[image ${block.mimeType} b64len=${(block.data ?? "").length}]`);
    }
    console.log("[details]", JSON.stringify(result.details, null, 2));
    return result.isError ? 1 : 0;
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  }
}

process.exit(await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}));
