/**
 * Load the extension factory with a minimal fake `pi`, then execute tools
 * directly against the live device — integration check without a full omp
 * session. Usage: bun scripts/fake-pi.ts <toolName> '<json params>'
 */
import {
  buildDeviceTool,
  buildKeyboardTool,
  buildMouseTool,
  buildScreenshotTool,
  buildStorageTool,
  type ZodLike,
} from "../src/tools.ts";
import { loadJetKvmConfig } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";
import { disposeEngines } from "../src/tools.ts";

// A ZodLike implementation that only records shape and echoes parse.
function fakeZ(): ZodLike {
  const leaf = (opts?: Record<string, unknown>): unknown => ({ kind: "leaf", opts });
  return {
    object: (shape: Record<string, unknown>) => ({
      parse: (v: unknown) => {
        if (typeof v !== "object" || v === null) throw new Error("params must be object");
        return v as Record<string, unknown>;
      },
      ...({ shape } as Record<string, unknown>),
    }),
    string: leaf,
    number: leaf,
    boolean: leaf,
    enum: (values: readonly string[]) => ({ kind: "enum", values }),
    array: (el: unknown) => ({ kind: "array", el }),
    optional: (el: unknown) => ({ kind: "optional", el }),
  } as unknown as ZodLike;
}

const cfg = loadJetKvmConfig(process.cwd());
const z = fakeZ();
const tools = [
  buildScreenshotTool(cfg, z),
  buildMouseTool(cfg, z),
  buildKeyboardTool(cfg, z),
  buildStorageTool(cfg, z),
  buildDeviceTool(cfg, z),
];

const toolName = process.argv[2];
const params = process.argv[3] ? (JSON.parse(process.argv[3]) as Record<string, unknown>) : {};
const tool = tools.find((t) => t.name === toolName);
if (!tool) {
  console.error(`unknown tool ${toolName}; available: ${tools.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const t0 = Date.now();
const result = await tool.execute(
  `call-${Date.now()}`,
  params,
  new AbortController().signal,
  (u) => console.error("[update]", u.content.map((c) => c.text).join(" ")),
  {},
);
console.log(`[result in ${Date.now() - t0}ms] isError=${result.isError === true}`);
for (const block of result.content) {
  if (block.type === "text") console.log(block.text);
  else if (block.type === "image") console.log(`[image ${block.mimeType} b64len=${(block.data ?? "").length}]`);
}
console.log("[details]", JSON.stringify(result.details, null, 2));
await ConnectionManager.disposeAll();
await disposeEngines();
process.exit(0);
