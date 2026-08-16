/**
 * omp-jetkvm extension entry point.
 * Registers 5 tools + /jetkvm command + policy interceptors (DESIGN §4, §6).
 *
 * Loading strategy — IMPORTANT, do not "simplify" the dynamic imports below
 * into literals: omp's extension loader pre-walks every literal import
 * specifier in the entry's source (static AND dynamic, including `import
 * type`) and re-serves that graph through Bun onLoad hooks that force ESM.
 * That breaks node_modules CommonJS without interop defaults (tslib, pulled
 * in via werift's crypto deps) with "Missing 'default' export". Building the
 * specifiers at runtime keeps the walked graph empty; the modules then load
 * through Bun's native resolver during the factory, where CJS interop works.
 *
 * Consequently this file must contain NO literal `from "./..."` or
 * `import("./...")` references to sibling modules — including type-only
 * ones. Needed types are declared locally below.
 */

interface ToolDefinitionShape {
  name: string;
}

interface JetKvmConfigShape {
  devices: Record<string, { host?: string }>;
  screenshot: { engine: string; chromiumPath: string; recorderPath: string };
  policy: PolicyShape;
}

interface PolicyShape {
  allowPowerActions: boolean;
  allowReboot: boolean;
  allowUsbDisconnect: boolean;
  forceUnmountOnMount: boolean;
}

interface DeviceSessionShape {
  auth: { hostname: string };
  reconnect(): Promise<void>;
  snapshot(): Record<string, unknown>;
}

interface ConnectionManagerStatic {
  new (cfg: JetKvmConfigShape): ConnectionManagerShape;
  peekSessions(): DeviceSessionShape[];
  disposeAll(): Promise<void>;
}

interface ConnectionManagerShape {
  session(name?: string): DeviceSessionShape;
  peekSessions(): DeviceSessionShape[];
  disposeAll(): Promise<void>;
}

interface ZodSchemaLike {
  optional(): ZodSchemaLike;
}

interface ZodObjectLike {
  parse: (v: unknown) => Record<string, unknown>;
}

interface ZodFacadeLike {
  object: (shape: Record<string, unknown>) => ZodObjectLike;
  string: () => ZodSchemaLike;
  number: () => ZodSchemaLike;
  boolean: () => ZodSchemaLike;
  enum: (values: readonly string[]) => unknown;
  array: (el: unknown) => unknown;
}

interface PiLike {
  zod: ZodFacadeLike;
  registerTool: (def: ToolDefinitionShape) => void;
  registerCommand: (
    name: string,
    def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void },
  ) => void;
  on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
  setLabel: (label: string) => void;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** See the header: specifiers are assembled at runtime on purpose. */
function moduleSpecifier(name: string): string {
  return `./${name}.ts`;
}

export default async function jetkvmExtension(pi: PiLike): Promise<void> {
  const [configMod, connectionMod, interceptMod, toolsMod, storageMod, engineMod, recorderMod] = await Promise.all(
    ["config", "connection", "intercept", "tools", "storage", "screenshot/engine", "screenshot/engine-recorder"].map(
      (name) => import(moduleSpecifier(name)),
    ),
  );
  const loadJetKvmConfig = configMod.loadJetKvmConfig as (cwd: string) => JetKvmConfigShape;
  const ConnectionManager = connectionMod.ConnectionManager as unknown as ConnectionManagerStatic;
  const policyGate = interceptMod.policyGate as (
    policy: PolicyShape,
    event: { toolName: string; input: Record<string, unknown> },
  ) => unknown;
  const buildScreenshotTool = toolsMod.buildScreenshotTool as (cfg: JetKvmConfigShape, z: unknown) => ToolDefinitionShape;
  const buildMouseTool = toolsMod.buildMouseTool as (cfg: JetKvmConfigShape, z: unknown) => ToolDefinitionShape;
  const buildKeyboardTool = toolsMod.buildKeyboardTool as (cfg: JetKvmConfigShape, z: unknown) => ToolDefinitionShape;
  const buildStorageTool = toolsMod.buildStorageTool as (cfg: JetKvmConfigShape, z: unknown) => ToolDefinitionShape;
  const buildDeviceTool = toolsMod.buildDeviceTool as (cfg: JetKvmConfigShape, z: unknown) => ToolDefinitionShape;
  const disposeEngines = toolsMod.disposeEngines as () => Promise<void>;
  const serveSnapshot = storageMod.serveSnapshot as (session: DeviceSessionShape) => Record<string, unknown> | null;
  const stopServeServer = storageMod.stopServeServer as (session: DeviceSessionShape) => void;
  const findChromium = engineMod.findChromium as (explicit: string) => string | null;
  const findRecorderBin = recorderMod.findRecorderBin as (explicit: string) => string | null;

  pi.setLabel("JetKVM");

  // omptype's zod facade has method-form .optional(); expose function form.
  const z = {
    ...pi.zod,
    optional: (leaf: unknown): unknown => (leaf as ZodSchemaLike).optional(),
  };

  const cfg = loadJetKvmConfig(process.cwd());
  const deviceNames = Object.keys(cfg.devices).filter((k) => cfg.devices[k]?.host);

  if (deviceNames.length === 0) {
    pi.logger?.warn(
      "omp-jetkvm: no devices configured — add jetkvm.devices.<name>.host to .omp/config.yml or ~/.omp/agent/config.yml; tools will report setup instructions until then",
    );
  }

  pi.registerTool(buildScreenshotTool(cfg, z));
  pi.registerTool(buildMouseTool(cfg, z));
  pi.registerTool(buildKeyboardTool(cfg, z));
  pi.registerTool(buildStorageTool(cfg, z));
  pi.registerTool(buildDeviceTool(cfg, z));

  pi.registerCommand("jetkvm", {
    description: "JetKVM status card (args: reconnect)",
    handler: async (args) => {
      const trimmed = args.trim();
      if (trimmed === "reconnect") {
        for (const session of ConnectionManager.peekSessions()) {
          await session.reconnect();
        }
        return;
      }
      const lines: string[] = [];
      lines.push(deviceNames.length ? `devices: ${deviceNames.join(", ")}` : "devices: none configured");
      const chromium = findChromium(cfg.screenshot.chromiumPath);
      const recorder = findRecorderBin(cfg.screenshot.recorderPath);
      lines.push(
        `screenshot engine: ${cfg.screenshot.engine === "auto" ? (chromium ? `browser (${chromium})` : recorder ? `recorder (${recorder})` : "auto → NONE AVAILABLE") : cfg.screenshot.engine}`,
      );
      for (const session of ConnectionManager.peekSessions()) {
        const snap = session.snapshot();
        const video = snap["videoState"] as { width?: number; height?: number; ready?: boolean } | undefined;
        lines.push(
          `${String(snap["device"])} (${String(snap["host"])}): ${String(snap["state"])}` +
            (video?.width ? ` · video ${video.width}x${video.height}${video.ready === false ? " (no signal)" : ""}` : "") +
            (snap["claim"] ? ` · input claim pid ${String((snap["claim"] as { pid: number }).pid)}` : ""),
        );
        const serve = serveSnapshot(session);
        if (serve) lines.push(`  serve_and_mount: ${String(serve["url"])} since ${String(serve["since"])}`);
        if (snap["lastError"]) lines.push(`  lastError: ${String(snap["lastError"])}`);
      }
      if (ConnectionManager.peekSessions().length === 0) {
        lines.push("no live sessions (connect on first tool call)");
      }
      pi.logger?.info(lines.join("\n"));
    },
  });

  pi.on("tool_call", (event) => policyGate(cfg.policy, event as Parameters<typeof policyGate>[1]));

  pi.on("session_shutdown", async () => {
    for (const session of ConnectionManager.peekSessions()) {
      stopServeServer(session);
    }
    await ConnectionManager.disposeAll();
    await disposeEngines();
  });
}
