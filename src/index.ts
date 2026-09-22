/**
 * omp-jetkvm extension entry point.
 * Loading strategy — IMPORTANT, keep every import below a literal specifier
 * (static or `import("./…")` literals are fine; computed strings are not):
 * omp ≥ 18 loads plugins inside a compiled Bun runtime in which bare
 * `node_modules` resolution from runtime-loaded modules is broken
 * ("Cannot find package 'yaml' …"). The loader instead pre-walks the entry's
 * literal import graph and rewrites bare dependencies (yaml, werift,
 * puppeteer-core) to absolute paths, bridging transitive CommonJS through its
 * graph bridge. omp ≤ 17 had the opposite constraint — its graph re-serve
 * forced ESM onto CommonJS deps (werift → tslib) and broke them, which is
 * why this file used to assemble specifiers at runtime. That escape hatch no
 * longer exists; the remaining CommonJS edge cases are handled by the
 * dependency patches in patches/ (tslib, tsyringe, @peculiar/x509).
 */
import { loadJetKvmConfig, JETKVM_CONFIG_DEFAULTS } from "./config.ts";
import { ConnectionManager } from "./connection.ts";
import { policyGate } from "./intercept.ts";
import {
	buildScreenshotTool,
	buildMouseTool,
	buildKeyboardTool,
	buildStorageTool,
	buildDeviceTool,
	disposeEngines,
} from "./tools.ts";
import { serveSnapshot, shutdownServe } from "./storage.ts";
import { findChromium } from "./screenshot/engine.ts";
import { findRecorderBin } from "./screenshot/engine-recorder.ts";
import type { JetKvmConfig } from "./config.ts";
import type { ToolCallEventLike } from "./intercept.ts";
import type { ToolDefinitionLike, ZodLike } from "./tools.ts";

/** Structural stand-in for the host-injected ExtensionAPI surface we use. */
interface PiLike {
	zod: ZodLike;
	registerTool: (def: ToolDefinitionLike) => void;
	registerCommand: (
		name: string,
		def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void },
	) => void;
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	setLabel: (label: string) => void;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** A broken config must not unregister the tool surface: register stubs that
 * surface the config error on every call (agent-visible, fixable). */
function errorTool(def: ToolDefinitionLike, message: string): ToolDefinitionLike {
	return {
		...def,
		async execute() {
			return { content: [{ type: "text", text: message }], isError: true };
		},
	};
}

export default async function jetkvmExtension(pi: PiLike): Promise<void> {
	pi.setLabel("JetKVM");

	// omptype's zod facade has method-form .optional(); expose function form.
	const z = {
		...pi.zod,
		optional: (leaf: unknown): unknown => (leaf as { optional(): unknown }).optional(),
	} as ZodLike;

	let cfg: JetKvmConfig;
	let cfgError: string | null = null;
	try {
		cfg = loadJetKvmConfig(process.cwd());
	} catch (err) {
		// Parse/validation failures must not take the whole tool surface down;
		// register tools that explain the problem on every call instead.
		cfg = structuredClone(JETKVM_CONFIG_DEFAULTS);
		cfgError = `omp-jetkvm config error: ${err instanceof Error ? err.message : String(err)}`;
		pi.logger?.warn(cfgError);
	}
	const deviceNames = Object.keys(cfg.devices).filter((k) => cfg.devices[k]?.host);
	if (deviceNames.length === 0) {
		pi.logger?.warn(
			"omp-jetkvm: no devices configured — add jetkvm.devices.<name>.host to .omp/config.yml or ~/.omp/agent/config.yml; tools will report setup instructions until then",
		);
	}

	const toolDefs = [
		buildScreenshotTool(cfg, z),
		buildMouseTool(cfg, z),
		buildKeyboardTool(cfg, z),
		buildStorageTool(cfg, z),
		buildDeviceTool(cfg, z),
	];
	for (const def of toolDefs) {
		pi.registerTool(cfgError ? errorTool(def, `${cfgError} — fix the config and restart the session`) : def);
	}

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
			if (cfgError) lines.push(cfgError);
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

	pi.on("tool_call", (event) => policyGate(cfg.policy, event as ToolCallEventLike));

	pi.on("session_shutdown", async () => {
		for (const session of ConnectionManager.peekSessions()) {
			await shutdownServe(session);
		}
		await ConnectionManager.disposeAll();
		await disposeEngines();
	});
}
