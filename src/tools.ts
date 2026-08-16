/**
 * Tool surface: jetkvm_screenshot / _mouse / _keyboard / _storage / _device.
 * DESIGN §4. Registered from index.ts with pi.zod schemas.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JetKvmError, humanBytes, pixelToHid } from "./util.ts";
import type { JetKvmConfig } from "./config.ts";
import { resolveDevice } from "./config.ts";
import { ConnectionManager, type DeviceSession } from "./connection.ts";
import { registerHeldRelease, releaseAllInput } from "./input.ts";
import {
  clickAt,
  dragTo,
  hidKeysPayload,
  MOUSE_BUTTONS,
  parseChord,
  pressChord,
  runInputTransaction,
  scrollAt,
  typeText,
} from "./input.ts";
import {
  deleteFile,
  getMountState,
  getSpace,
  listFiles,
  mountFile,
  mountUrl,
  serveAndMount,
  serveSnapshot,
  unmount,
  uploadFile,
} from "./storage.ts";
import { atxPowerAction, getDeviceStatus, setUsbEmulation, wakeHost } from "./device.ts";
import { selectEngine, writeScreenshotFile, type ScreenshotEngine } from "./screenshot/engine.ts";

// Extension API types we depend on (kept structural to avoid importing the
// host package at build time — the host injects `pi`).
export interface ZodLike {
  object: (shape: Record<string, unknown>) => ZodObjectLike;
  string: (opts?: Record<string, unknown>) => unknown;
  number: (opts?: Record<string, unknown>) => unknown;
  boolean: (opts?: Record<string, unknown>) => unknown;
  enum: (values: readonly string[]) => unknown;
  array: (el: unknown) => unknown;
  optional: (el: unknown) => unknown;
}
export interface ZodObjectLike {
  parse: (v: unknown) => Record<string, unknown>;
}
export interface ToolExecuteCtx {
  cwd?: string;
  /** Live session model, when the host provides it (capability gating). */
  model?: { input?: string[] };
}
export interface ToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: ZodObjectLike;
  approval?: "read" | "write" | "exec";
  loadMode?: "discoverable" | "essential";
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((u: { content: { type: string; text: string }[] }) => void) | undefined,
    ctx: ToolExecuteCtx,
  ) => Promise<{
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}
export interface RegisterToolFn {
  (def: ToolDefinitionLike): void;
}

// Process-global engine cache: one warm engine per device host.
const ENGINES_KEY = Symbol.for("omp-jetkvm.engines");
function engineRegistry(): Map<string, ScreenshotEngine> {
  const g = globalThis as Record<symbol, Map<string, ScreenshotEngine> | undefined>;
  if (!g[ENGINES_KEY]) g[ENGINES_KEY] = new Map();
  return g[ENGINES_KEY]!;
}

export async function engineFor(cfg: JetKvmConfig, deviceName?: string): Promise<{ engine: ScreenshotEngine; session: DeviceSession }> {
  const dev = resolveDevice(cfg, deviceName);
  const mgr = new ConnectionManager(cfg);
  const session = mgr.session(deviceName);
  // Key includes the configured engine so browser/recorder configs coexist.
  const cacheKey = `${dev.host}::${cfg.screenshot.engine}`;
  let engine = engineRegistry().get(cacheKey);
  if (!engine) {
    engine = await selectEngine(cfg, dev);
    engineRegistry().set(cacheKey, engine);
  }
  return { engine, session };
}

function text(t: string): { type: string; text: string } {
  return { type: "text", text: t };
}

function err(errLike: unknown): { content: { type: string; text?: string }[]; details?: Record<string, unknown>; isError: boolean } {
  if (errLike instanceof JetKvmError) {
    return { content: [text(`${errLike.code}: ${errLike.message}`)], details: { code: errLike.code, ...(errLike.details ?? {}) }, isError: true };
  }
  // Stack goes to details (not model content) — native crashes stay debuggable.
  return {
    content: [text(`UnexpectedError: ${String(errLike)}`)],
    details: { code: "UnexpectedError", stack: errLike instanceof Error ? String(errLike.stack) : undefined },
    isError: true,
  };
}

export async function disposeEngines(): Promise<void> {
  for (const [, e] of engineRegistry()) await e.dispose();
  engineRegistry().clear();
}

function screenshotDir(cfg: JetKvmConfig): string {
  return cfg.screenshot.screenshotDir || join(tmpdir(), "omp-jetkvm");
}

// ---------------------------------------------------------------------------

export function buildScreenshotTool(cfg: JetKvmConfig, z: ZodLike): ToolDefinitionLike {
  return {
    name: "jetkvm_screenshot",
    label: "JetKVM screenshot",
    description:
      "Capture the remote host screen via the JetKVM. Returns an image for the model plus a full-resolution file on disk (details.path). Use action 'state' for a cheap liveness/coordinate check without capturing. Coordinates for jetkvm_mouse are in this image's pixel space (see details.coordinateSpace). `quality` applies to the inline model copy; the full-res file always encodes at quality >= 85 to stay archival.",
    approval: "read",
    loadMode: "discoverable",
    parameters: z.object({
      device: z.optional(z.string()),
      action: z.enum(["capture", "state"]),
      waitMs: z.optional(z.number()),
      format: z.optional(z.enum(["jpeg", "png"])),
      quality: z.optional(z.number()),
      maxModelWidth: z.optional(z.number()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const deviceName = (params["device"] as string | undefined) ?? undefined;
        const action = (params["action"] as string) ?? "capture";
        const { engine, session } = await engineFor(cfg, deviceName);
        if (action === "state") {
          const vs = await session.call("getVideoState", {}, { retryOnReconnect: true, signal });
          return {
            content: [text(`video state: ${JSON.stringify(vs)}`)],
            details: { videoState: vs, device: session.name },
          };
        }
        const waitMs = (params["waitMs"] as number | undefined) ?? 0;
        const format = (params["format"] as "jpeg" | "png" | undefined) ?? "jpeg";
        const quality = (params["quality"] as number | undefined) ?? 75;
        const maxModelWidth = (params["maxModelWidth"] as number | undefined) ?? cfg.screenshot.maxModelWidth;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        onUpdate?.({ content: [text(`capturing via ${engine.name} engine...`)] });
        const cap = await engine.capture({ format, quality, maxModelWidth, signal });
        const dir = screenshotDir(cfg);
        mkdirSync(dir, { recursive: true });
        const path = writeScreenshotFile(cap.fullData, cap.fullMime, dir);
        const bytes = Math.round((cap.fullData.length * 3) / 4);
        const dims = { width: cap.width, height: cap.height };
        session.videoState = { ...session.videoState, width: cap.width, height: cap.height };
        // Inline image only for vision-capable models: a non-vision session
        // would drop it ("[image omitted]") while the fat base64 block still
        // bloats context and exercises image-handling paths for nothing.
        const modelInput = ctx.model?.input;
        const visionCapable = modelInput === undefined || modelInput.includes("image");
        const summary = `jetkvm screenshot (${engine.name}): ${cap.width}x${cap.height}; full-res ${cap.fullMime} (${humanBytes(bytes)}) at ${path}. Mouse coordinates: 0..${cap.width - 1} x 0..${cap.height - 1}.`;
        return {
          content: visionCapable
            ? [{ type: "image", data: cap.modelData, mimeType: cap.modelMime }, text(summary)]
            : [text(`${summary} (inline image skipped: session model lacks image input — use inspect_image on the path to see the screen)`)],
          details: {
            path,
            engine: engine.name,
            width: cap.width,
            height: cap.height,
            mimeType: cap.fullMime,
            bytes,
            coordinateSpace: dims,
            videoState: session.videoState,
            device: session.name,
          },
        };
      } catch (e) {
        return err(e);
      }
    },
  };
}

export function buildMouseTool(cfg: JetKvmConfig, z: ZodLike): ToolDefinitionLike {
  return {
    name: "jetkvm_mouse",
    label: "JetKVM mouse",
    description:
      "Mouse input on the remote host. Coordinates are stream pixels — the same space as the screenshot (details.coordinateSpace). Actions: move, click (left/middle/right, modifiers, double via double_click), right_click, drag (x1,y1 -> x2,y2), scroll (dy notches, +up/-down), down/up. down holds the button (like keyboard down) until up / release_all — releases ALL held input; up's x/y are optional and default to the last pointer position.",
    approval: "write",
    loadMode: "discoverable",
    parameters: z.object({
      device: z.optional(z.string()),
      action: z.enum(["move", "click", "double_click", "right_click", "drag", "scroll", "down", "up"]),
      x: z.optional(z.number()),
      y: z.optional(z.number()),
      x1: z.optional(z.number()),
      y1: z.optional(z.number()),
      x2: z.optional(z.number()),
      y2: z.optional(z.number()),
      steps: z.optional(z.number()),
      dy: z.optional(z.number()),
      dx: z.optional(z.number()),
      button: z.optional(z.enum(["left", "middle", "right"])),
      modifiers: z.optional(z.array(z.string())),
      force: z.optional(z.boolean()),
    }),
    async execute(toolCallId, params, signal) {
      try {
        const deviceName = (params["device"] as string | undefined) ?? undefined;
        const session = new ConnectionManager(cfg).session(deviceName);
        const action = params["action"] as string;
        const holder = `omp:${toolCallId.slice(0, 12)}`;
        const x = params["x"] as number | undefined;
        const y = params["y"] as number | undefined;

        // down: manual hold — the transaction cleanup invariant must not
        // release it at call end (that made "down" a slow click). Park the
        // mutex release until up / release_all, exactly like keyboard
        // down/hold_keys.
        if (action === "down") {
          if (x === undefined || y === undefined) throw new JetKvmError("BadParams", "down needs x and y");
          await session.ensureConnected();
          const release = await session.locks.input.acquire(holder);
          try {
            // Claim inside the try: an InputBusy timeout must not leave a
            // cross-process claim behind for a hold that never happened.
            session.ensureClaim(params["force"] as boolean | undefined);
            const dims = await session.videoDims();
            const button = (params["button"] as keyof typeof MOUSE_BUTTONS) ?? "left";
            const hx = pixelToHid(x, dims.width);
            const hy = pixelToHid(y, dims.height);
            await session.call("absMouseReport", { x: hx, y: hy, buttons: MOUSE_BUTTONS[button] });
            session.lastMouse = { x: hx, y: hy };
            registerHeldRelease(session, release);
            return {
              content: [text(`holding ${button} button at ${x},${y} — release with action up / release_all`)],
              details: { button, device: session.name },
            };
          } catch (e) {
            release();
            return err(e);
          }
        }

        // up: escape hatch like keyboard release_all — deliberately NOT under
        // the input mutex (a parked hold would deadlock it). Releases all
        // held input; the mouse report goes to x,y when given, else the last
        // known pointer position (never a corner teleport).
        if (action === "up") {
          const at =
            x !== undefined && y !== undefined
              ? await session.videoDims().then((dims) => ({ x: pixelToHid(x, dims.width), y: pixelToHid(y, dims.height) }))
              : undefined;
          await releaseAllInput(session, at);
          return { content: [text("released all held input (keys and buttons)")], details: { device: session.name } };
        }

        const { result, warnings } = await runInputTransaction(
          session,
          holder,
          async (tx) => {
            switch (action) {
              case "move": {
                if (x === undefined || y === undefined) throw new JetKvmError("BadParams", "move needs x and y");
                const dims = await session.videoDims();
                await tx.mouseReport(pixelToHid(x, dims.width), pixelToHid(y, dims.height), 0);
                return { moved: { x, y }, coordinateSpace: dims };
              }
              case "click":
              case "double_click": {
                if (x === undefined || y === undefined) throw new JetKvmError("BadParams", `${action} needs x and y`);
                await clickAt(tx, session, {
                  x,
                  y,
                  button: (params["button"] as "left" | "middle" | "right") ?? "left",
                  modifiers: params["modifiers"] as string[] | undefined,
                  double: action === "double_click",
                });
                return { clicked: { x, y, button: params["button"] ?? "left", double: action === "double_click" } };
              }
              case "right_click": {
                if (x === undefined || y === undefined) throw new JetKvmError("BadParams", "right_click needs x and y");
                await clickAt(tx, session, { x, y, button: "right" });
                return { clicked: { x, y, button: "right" } };
              }
              case "drag": {
                const x1 = params["x1"] as number | undefined;
                const y1 = params["y1"] as number | undefined;
                const x2 = params["x2"] as number | undefined;
                const y2 = params["y2"] as number | undefined;
                if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
                  throw new JetKvmError("BadParams", "drag needs x1,y1,x2,y2");
                }
                await dragTo(tx, session, { x1, y1, x2, y2, steps: params["steps"] as number | undefined });
                return { dragged: { x1, y1, x2, y2 } };
              }
              case "scroll": {
                if (x === undefined || y === undefined) throw new JetKvmError("BadParams", "scroll needs x and y");
                const dy = (params["dy"] as number | undefined) ?? 0;
                await scrollAt(tx, session, { x, y, dy, dx: params["dx"] as number | undefined });
                return { scrolled: { x, y, dy, dx: params["dx"] ?? 0 } };
              }
              default:
                throw new JetKvmError("BadParams", `unknown mouse action "${action}"`);
            }
          },
          { signal, force: params["force"] as boolean | undefined },
        );
        return {
          content: [text(`jetkvm mouse ${action} ok${warnings.length ? ` (warnings: ${warnings.join("; ")})` : ""}`)],
          details: { ...result, warnings, device: session.name },
        };
      } catch (e) {
        return err(e);
      }
    },
  };
}

export function buildKeyboardTool(cfg: JetKvmConfig, z: ZodLike): ToolDefinitionLike {
  return {
    name: "jetkvm_keyboard",
    label: "JetKVM keyboard",
    description:
      'Keyboard input on the remote host. type: US-layout text ("\n"=enter, "\t"=tab); text is validated before typing — unmappable characters fail the whole call without typing a prefix, and "\r\n" collapses to a single enter. press: chord notation "ctrl+alt+t", "enter", "shift+a", "win+r", "right-ctrl". down/up + hold_keys/release_all for manual holds (caller must release; up/release_all also releases held mouse buttons at the last pointer position). Long text is slow (~25ms/char).',
    approval: "write",
    loadMode: "discoverable",
    parameters: z.object({
      device: z.optional(z.string()),
      action: z.enum(["type", "press", "down", "up", "hold_keys", "release_all"]),
      text: z.optional(z.string()),
      keys: z.optional(z.string()),
      durationMs: z.optional(z.number()),
      keystrokeDelayMs: z.optional(z.number()),
      settleMs: z.optional(z.number()),
      force: z.optional(z.boolean()),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      try {
        const deviceName = (params["device"] as string | undefined) ?? undefined;
        const session = new ConnectionManager(cfg).session(deviceName);
        const action = params["action"] as string;
        const holder = `omp:${toolCallId.slice(0, 12)}`;

        if (action === "down" || action === "hold_keys") {
          // Manual hold mode: no auto-cleanup (caller must release_all / up).
          // Connect before taking the mutex (backoff sleeps must not hold
          // the input lock — see runInputTransaction).
          const release = await session.locks.input.acquire(holder);
          try {
            // Claim inside the try: an InputBusy timeout must not leave a
            // cross-process claim behind for a hold that never happened.
            session.ensureClaim(params["force"] as boolean | undefined);
            const chord = parseChord(String(params["keys"] ?? ""));
            if (chord.usages.length === 0) {
              // modifier-only hold: just the mask
              await session.call("keyboardReport", { modifier: chord.modifierMask, keys: hidKeysPayload([]) });
            } else {
              await session.call("keyboardReport", { modifier: chord.modifierMask, keys: hidKeysPayload(chord.usages) });
            }
            registerHeldRelease(session, release);
            return {
              content: [text(`holding "${params["keys"]}" — release with action up / release_all`)],
              details: { held: params["keys"], device: session.name },
            };
          } catch (e) {
            release();
            return err(e);
          }
        }

        // Deliberately NOT under the input mutex: a held down/hold_keys parks
        // the mutex release, so acquiring here would deadlock until queue
        // timeout. This is the documented escape hatch — it can stomp a
        // concurrent transaction's held state, which is what "release ALL"
        // means. The mouse release goes to the last known pointer position,
        // so it never teleports the cursor to the corner.
        if (action === "up" || action === "release_all") {
          await releaseAllInput(session);
          return { content: [text("released all keys and buttons")], details: { device: session.name } };
        }


        const { warnings } = await runInputTransaction(
          session,
          holder,
          async (tx) => {
            if (action === "type") {
              const textStr = String(params["text"] ?? "");
              if (textStr.length > 500) {
                onUpdate?.({ content: [text(`typing ${textStr.length} chars at ~25ms/char ≈ ${Math.round((textStr.length * 50) / 1000)}s`)] });
              }
              const r = await typeText(tx, {
                text: textStr,
                keystrokeDelayMs: params["keystrokeDelayMs"] as number | undefined,
                settleMs: params["settleMs"] as number | undefined,
              });
              return { typed: r.chars };
            }
            if (action === "press") {
              const chord = parseChord(String(params["keys"] ?? ""));
              await pressChord(tx, chord, (params["durationMs"] as number | undefined) ?? 60);
              return { pressed: params["keys"] };
            }
            throw new JetKvmError("BadParams", `unknown keyboard action "${action}"`);
          },
          { signal, force: params["force"] as boolean | undefined },
        );
        const detail = warnings.length ? ` (warnings: ${warnings.join("; ")})` : "";
        return {
          content: [text(`jetkvm keyboard ${action} ok${detail}`)],
          details: { action, device: session.name, warnings },
        };
      } catch (e) {
        return err(e);
      }
    },
  };
}

export function buildStorageTool(cfg: JetKvmConfig, z: ZodLike): ToolDefinitionLike {
  return {
    name: "jetkvm_storage",
    label: "JetKVM storage",
    description:
      "Virtual media on the JetKVM. state/space/list_files are read-only. mount_url mounts a device-reachable HTTP URL; serve_and_mount serves a local file via the interface facing the device (needs the server alive while mounted); upload_and_mount copies into device flash then mounts (durable for unattended installs); upload stores without mounting (reserves a free-space margin: max(5% of file, 64 MiB) — tune with minFreeBytes); mount_file mounts an uploaded file; unmount clears the single media slot; check_url pre-flights a mount URL; delete_file removes a device file.",
    approval: "write",
    loadMode: "discoverable",
    parameters: z.object({
      device: z.optional(z.string()),
      action: z.enum([
        "state", "space", "list_files", "delete_file", "check_url", "mount_url",
        "serve_and_mount", "upload_and_mount", "upload", "mount_file", "unmount",
      ]),
      url: z.optional(z.string()),
      path: z.optional(z.string()),
      filename: z.optional(z.string()),
      mode: z.optional(z.enum(["CDROM", "Disk"])),
      minFreeBytes: z.optional(z.number()),
      force: z.optional(z.boolean()),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      try {
        const deviceName = (params["device"] as string | undefined) ?? undefined;
        const session = new ConnectionManager(cfg).session(deviceName);
        const action = params["action"] as string;
        const mode = params["mode"] as "CDROM" | "Disk" | undefined;
        const holder = `omp:${toolCallId.slice(0, 12)}`;

        // Read-only actions: no locks.
        switch (action) {
          case "state": {
            const state = await getMountState(session);
            return { content: [text(`virtual media: ${state === null ? "nothing mounted" : JSON.stringify(state)}`)], details: { state, serve: serveSnapshot(session) } };
          }
          case "space": {
            const space = await getSpace(session);
            return { content: [text(`storage: ${humanBytes(space.bytesFree)} free of ${humanBytes(space.bytesUsed + space.bytesFree)}`)], details: space };
          }
          case "list_files": {
            const { files } = await listFiles(session);
            const lines = files.map((f) => `  ${f.filename}  ${humanBytes(f.size)}  ${f.createdAt}`);
            return {
              content: [text(files.length ? `device files:\n${lines.join("\n")}` : "no files on device storage")],
              details: { files },
            };
          }
          case "check_url": {
            const check = (await session.call("checkMountUrl", { url: String(params["url"] ?? "") }, { timeoutMs: 15_000, signal })) as Record<string, unknown>;
            return { content: [text(`mount URL check: ${JSON.stringify(check)}`)], details: { check } };
          }
          default:
            break;
        }

        // Mutations: storage mutex + cross-process claim. Connect first (a
        // reconnect backoff must not hold the storage lock), mutex next,
        // claim inside the try: a StorageBusy timeout must not leave a
        // cross-process claim behind.
        await session.ensureConnected();
        const release = await session.locks.storage.acquire(holder);
        try {
          session.ensureClaim(params["force"] as boolean | undefined);
          switch (action) {
            case "delete_file": {
              const filename = String(params["filename"] ?? "");
              if (!filename) throw new JetKvmError("BadParams", "delete_file needs filename");
              const r = await deleteFile(session, filename);
              return { content: [text(`deleted ${filename}`)], details: r };
            }
            case "mount_url": {
              const url = String(params["url"] ?? "");
              if (!url) throw new JetKvmError("BadParams", "mount_url needs url");
              const r = await mountUrl(session, cfg.policy, { url, mode });
              return { content: [text(`mounted ${url} (${mode ?? "CDROM"})`)], details: { ...r, state: await getMountState(session) } };
            }
            case "serve_and_mount": {
              const path = String(params["path"] ?? "");
              if (!path) throw new JetKvmError("BadParams", "serve_and_mount needs path");
              const r = await serveAndMount(session, cfg.policy, { path, mode, signal });
              return { content: [text(`serving ${r["serving"]} and mounted (${mode ?? "CDROM"})`)], details: { ...r, state: await getMountState(session) } };
            }
            case "upload": {
              const path = String(params["path"] ?? "");
              if (!path) throw new JetKvmError("BadParams", "upload needs path");
              const r = await uploadFile(session, {
                path,
                filename: params["filename"] as string | undefined,
                minFreeBytes: params["minFreeBytes"] as number | undefined,
                signal,
                onProgress: (p) => onUpdate?.({ content: [text(`uploading: ${humanBytes(p.bytesSent)} / ${humanBytes(p.totalBytes)}`)] }),
              });
              return { content: [text(`uploaded ${r.filename} (${humanBytes(r.totalBytes)}, resumed from ${r.resumedFrom})`)], details: { ...r } };
            }
            case "upload_and_mount": {
              const path = String(params["path"] ?? "");
              if (!path) throw new JetKvmError("BadParams", "upload_and_mount needs path");
              const up = await uploadFile(session, {
                path,
                filename: params["filename"] as string | undefined,
                minFreeBytes: params["minFreeBytes"] as number | undefined,
                signal,
                onProgress: (p) => onUpdate?.({ content: [text(`uploading: ${humanBytes(p.bytesSent)} / ${humanBytes(p.totalBytes)}`)] }),
              });
              const mounted = await mountFile(session, cfg.policy, { filename: up.filename, mode });
              return { content: [text(`uploaded and mounted ${up.filename} (${mode ?? "CDROM"})`)], details: { ...up, mounted } };
            }
            case "mount_file": {
              const filename = String(params["filename"] ?? "");
              if (!filename) throw new JetKvmError("BadParams", "mount_file needs filename");
              const mounted = await mountFile(session, cfg.policy, { filename, mode });
              return { content: [text(`mounted ${filename} (${mode ?? "CDROM"})`)], details: { mounted } };
            }
            case "unmount": {
              const r = await unmount(session);
              return { content: [text("unmounted")], details: r };
            }
            default:
              throw new JetKvmError("BadParams", `unknown storage action "${action}"`);
          }
        } finally {
          release();
        }
      } catch (e) {
        return err(e);
      }
    },
  };
}

export function buildDeviceTool(cfg: JetKvmConfig, z: ZodLike): ToolDefinitionLike {
  return {
    name: "jetkvm_device",
    label: "JetKVM device",
    description:
      "Device-level control. status: aggregated info (HTTP + RPC). video: getVideoState. power: op atx-short|atx-long|atx-reset (200ms/5s press, reset) or read via atx-state; wake: Wake-on-LAN (mac optional); usb: emulation state incl. getUsbDevices; keyboard_layout: read/set device keyboard layout. Power/USB-disconnect are policy-gated (jetkvm.policy).",
    approval: "read",
    loadMode: "discoverable",
    parameters: z.object({
      device: z.optional(z.string()),
      action: z.enum(["status", "video", "power", "wake", "usb", "keyboard_layout"]),
      op: z.optional(z.enum(["atx-short", "atx-long", "atx-reset", "atx-state", "dc-state"])),
      mac: z.optional(z.string()),
      enabled: z.optional(z.boolean()),
      layout: z.optional(z.string()),
      force: z.optional(z.boolean()),
    }),
    async execute(toolCallId, params, signal) {
      try {
        const deviceName = (params["device"] as string | undefined) ?? undefined;
        const session = new ConnectionManager(cfg).session(deviceName);
        const action = params["action"] as string;
        switch (action) {
          case "status": {
            const status = await getDeviceStatus(session);
            const atx = status.atxState as { power?: boolean } | null;
            return {
              content: [text(`device ${session.auth.hostname}: fw ${JSON.stringify(status.localVersion)}; ${atx?.power === true ? "host POWERED ON" : atx?.power === false ? "host powered off" : "host power unknown"}; video ${JSON.stringify(status.videoState)}; layout ${JSON.stringify(status.keyboardLayout)}; media ${JSON.stringify(status.virtualMedia)}`)],
              details: { ...status, device: session.name },
            };
          }
          case "video": {
            const vs = await session.call("getVideoState", {}, { retryOnReconnect: true, signal });
            return { content: [text(`video state: ${JSON.stringify(vs)}`)], details: { videoState: vs } };
          }
          case "power": {
            const op = params["op"] as string | undefined;
            if (op === undefined) throw new JetKvmError("BadParams", "power needs op: atx-short | atx-long | atx-reset | atx-state | dc-state");
            if (op === "atx-state") {
              const atx = await session.call("getATXState", {}, { retryOnReconnect: true });
              return { content: [text(`ATX state: ${JSON.stringify(atx)}`)], details: { atxState: atx } };
            }
            if (op === "dc-state") {
              const dc = await session.call("getDCPowerState", {}, { retryOnReconnect: true });
              return { content: [text(`DC power state: ${JSON.stringify(dc)}`)], details: { dcState: dc } };
            }
            session.ensureClaim(params["force"] as boolean | undefined);
            const r = await atxPowerAction(session, op as "atx-short" | "atx-long" | "atx-reset");
            return { content: [text(`ATX ${op} sent; state now ${JSON.stringify(r.atxState)}`)], details: r };
          }
          case "wake": {
            const mac = params["mac"] as string | undefined;
            const r = await wakeHost(session, mac);
            return { content: [text(`wake sent: ${JSON.stringify(r)}`)], details: r };
          }
          case "usb": {
            const enabled = params["enabled"] as boolean | undefined;
            if (enabled === undefined) {
              const state = await session.call("getUSBState", {}, { retryOnReconnect: true });
              let devices: unknown = null;
              try {
                devices = await session.call("getUsbDevices", {}, { retryOnReconnect: true });
              } catch {
                devices = null;
              }
              return { content: [text(`USB emulation: ${JSON.stringify(state)}; devices: ${JSON.stringify(devices)}`)], details: { usbState: state, devices } };
            }
            session.ensureClaim(params["force"] as boolean | undefined);
            const r = await setUsbEmulation(session, enabled);
            return { content: [text(`USB emulation set to ${enabled}; state: ${JSON.stringify(r.usbState)}`)], details: r };
          }
          case "keyboard_layout": {
            const layout = params["layout"] as string | undefined;
            if (layout === undefined) {
              const cur = await session.call("getKeyboardLayout", {}, { retryOnReconnect: true });
              return { content: [text(`device keyboard layout: ${JSON.stringify(cur)}`)], details: { layout: cur } };
            }
            await session.call("setKeyboardLayout", { layout });
            return { content: [text(`device keyboard layout set to ${layout}`)], details: { layout } };
          }
          default:
            throw new JetKvmError("BadParams", `unknown device action "${action}"`);
        }
      } catch (e) {
        return err(e);
      }
    },
  };
}
