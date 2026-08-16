/**
 * HID input engine. DESIGN §2.4 (encodings) + §4.2/§4.3 (semantics).
 *
 * Keymap derived from the USB-IF *HID Usage Tables* specification (a public
 * standard) — never from any JetKVM source file (GPL discipline, DESIGN §8).
 *
 * Every mutation runs inside a transaction that guarantees the cleanup
 * invariant (§4.3): abort/error/timeout mid-transaction releases all held
 * keys and buttons before the call returns.
 */
import { JetKvmError, clamp, pixelToHid, sleep } from "./util.ts";
import type { DeviceSession } from "./connection.ts";

// ---------------------------------------------------------------------------
// USB HID usage IDs (HID Usage Tables §10, Keyboard/Keypad page 0x07)
// ---------------------------------------------------------------------------

export const MODIFIER_BITS = {
  leftCtrl: 0x01,
  leftShift: 0x02,
  leftAlt: 0x04,
  leftGui: 0x08,
  rightCtrl: 0x10,
  rightShift: 0x20,
  rightAlt: 0x40,
  rightGui: 0x80,
} as const;

/** Named keys → HID usage ID. Chord tokens and `press` accept these names. */
export const KEY_USAGE: Record<string, number> = {
  a: 0x04, b: 0x05, c: 0x06, d: 0x07, e: 0x08, f: 0x09, g: 0x0a, h: 0x0b, i: 0x0c,
  j: 0x0d, k: 0x0e, l: 0x0f, m: 0x10, n: 0x11, o: 0x12, p: 0x13, q: 0x14, r: 0x15,
  s: 0x16, t: 0x17, u: 0x18, v: 0x19, w: 0x1a, x: 0x1b, y: 0x1c, z: 0x1d,
  "1": 0x1e, "2": 0x1f, "3": 0x20, "4": 0x21, "5": 0x22, "6": 0x23, "7": 0x24,
  "8": 0x25, "9": 0x26, "0": 0x27,
  enter: 0x28, return: 0x28, esc: 0x29, escape: 0x29, backspace: 0x2a, bs: 0x2a,
  tab: 0x2b, space: 0x2c,
  minus: 0x2d, dash: 0x2d, equal: 0x2e, equals: 0x2e,
  lbracket: 0x2f, bracketleft: 0x2f, rbracket: 0x30, bracketright: 0x30,
  backslash: 0x31, semicolon: 0x33, apostrophe: 0x34, quote: 0x34,
  grave: 0x35, backtick: 0x35, comma: 0x36, period: 0x37, dot: 0x37, slash: 0x38,
  capslock: 0x39,
  f1: 0x3a, f2: 0x3b, f3: 0x3c, f4: 0x3d, f5: 0x3e, f6: 0x3f, f7: 0x40,
  f8: 0x41, f9: 0x42, f10: 0x43, f11: 0x44, f12: 0x45,
  printscreen: 0x46, prtsc: 0x46, sysrq: 0x46, scrolllock: 0x47, pause: 0x48,
  insert: 0x49, ins: 0x49, home: 0x4a, pageup: 0x4b, pgup: 0x4b,
  delete: 0x4c, del: 0x4c, end: 0x4d, pagedown: 0x4e, pgdn: 0x4e,
  right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
  numlock: 0x53, kpslash: 0x54, kpasterisk: 0x55, kpminus: 0x56, kpplus: 0x57,
  kpenter: 0x58, kp1: 0x59, kp2: 0x5a, kp3: 0x5b, kp4: 0x5c, kp5: 0x5d,
  kp6: 0x5e, kp7: 0x5f, kp8: 0x60, kp9: 0x61, kp0: 0x62, kpdot: 0x63,
  application: 0x65, menu: 0x65, compose: 0x65,
};

const MODIFIER_ALIASES: Record<string, number> = {
  ctrl: 0x01, control: 0x01, lctrl: 0x01, "left-ctrl": 0x01,
  shift: 0x02, lshift: 0x02, "left-shift": 0x02,
  alt: 0x04, lalt: 0x04, "left-alt": 0x04,
  win: 0x08, meta: 0x08, cmd: 0x08, super: 0x08, lwin: 0x08, lgui: 0x08,
  rctrl: 0x10, "right-ctrl": 0x10,
  rshift: 0x20, "right-shift": 0x20,
  ralt: 0x40, "right-alt": 0x40, altgr: 0x40,
  rwin: 0x80, rmeta: 0x80, rcmd: 0x80, rgui: 0x80,
};

/** US-layout char → (usage, needsShift). DESIGN §4.3. */
export const CHAR_USAGE: Record<string, { usage: number; shift: boolean }> = (() => {
  const map: Record<string, { usage: number; shift: boolean }> = {};
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(97 + i)] = { usage: 0x04 + i, shift: false };
    map[String.fromCharCode(65 + i)] = { usage: 0x04 + i, shift: true };
  }
  // Digit row: "1".."9" are 0x1e..0x26, "0" is 0x27.
  const digits = "1234567890";
  const shiftedSymbols = "!@#$%^&*()";
  for (let i = 0; i < 10; i++) {
    map[digits[i]!] = { usage: 0x1e + i, shift: false };
    map[shiftedSymbols[i]!] = { usage: 0x1e + i, shift: true };
  }
  const plain: Record<string, number> = {
    "-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31, ";": 0x33,
    "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38, " ": 0x2c,
  };
  const shifted: Record<string, string> = {
    _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
    "~": "`", "<": ",", ">": ".", "?": "/",
  };
  for (const [ch, usage] of Object.entries(plain)) map[ch] = { usage, shift: false };
  for (const [ch, base] of Object.entries(shifted)) map[ch] = { usage: plain[base]!, shift: true };
  map["\n"] = { usage: KEY_USAGE.enter!, shift: false };
  map["\t"] = { usage: KEY_USAGE.tab!, shift: false };
  return map;
})();

export interface Chord {
  modifierMask: number;
  usages: number[];
}

/** Parse "ctrl+alt+t" / "shift+a" / "enter" / "right-ctrl". Throws on unknown tokens. */
export function parseChord(spec: string): Chord {
  const tokens = spec
    .split("+")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new JetKvmError("BadChord", `empty chord: "${spec}"`);
  }
  let modifierMask = 0;
  const usages: number[] = [];
  const unknown: string[] = [];
  for (const tok of tokens) {
    const mod = MODIFIER_ALIASES[tok];
    if (mod !== undefined) {
      modifierMask |= mod;
      continue;
    }
    const usage = KEY_USAGE[tok];
    if (usage !== undefined) {
      usages.push(usage);
      continue;
    }
    // A single character also works ("a", "5", "/").
    const single = CHAR_USAGE[tok];
    if (single) {
      usages.push(single.usage);
      if (single.shift) modifierMask |= MODIFIER_ALIASES.shift!;
      continue;
    }
    unknown.push(tok);
  }
  if (unknown.length > 0) {
    throw new JetKvmError(
      "UnknownKey",
      `unknown key token(s) ${unknown.map((u) => `"${u}"`).join(", ")} in chord "${spec}" — use HID names (enter, tab, f1..f12, up/down/left/right, printscreen, ...) or single US characters`,
    );
  }
  // Bare modifiers (e.g. "right-ctrl" tap) are legal: modifiers down, hold, up.
  if (usages.length === 0 && modifierMask === 0) {
    throw new JetKvmError("BadChord", `chord "${spec}" is empty`);
  }
  return { modifierMask, usages };
}

/** Zero-pad usage ids to the 6-slot HID boot report. */
export function hidKeysPayload(usages: number[]): number[] {
  const keys = usages.slice(0, 6).map((u) => clamp(u, 0, 255));
  while (keys.length < 6) keys.push(0);
  return keys;
}

// ---------------------------------------------------------------------------
// Transaction context: everything an input op needs, plus held-state tracking
// so the cleanup invariant can release exactly what we pressed.
// ---------------------------------------------------------------------------

export interface InputTransaction {
  keyboardReport(modifierMask: number, usages: number[]): Promise<void>;
  mouseReport(x: number, y: number, buttons: number): Promise<void>;
  wheelReport(wheelY: number, wheelX?: number): Promise<void>;
  abortableSleep(ms: number): Promise<void>;
}

// Manual holds (keyboard down/hold_keys) outlive their tool call; their mutex
// releases are parked here until up/release_all drains them.
const HELD_RELEASES = new WeakMap<object, Array<() => void>>();

export function registerHeldRelease(session: object, release: () => void): void {
  const list = HELD_RELEASES.get(session) ?? [];
  list.push(release);
  HELD_RELEASES.set(session, list);
}

export function heldInputReleases(session: object): Array<() => void> {
  const list = HELD_RELEASES.get(session) ?? [];
  HELD_RELEASES.set(session, []);
  return list;
}

interface HeldState {
  modifierMask: number;
  keyUsages: number[];
  buttons: number;
  pointer: { x: number; y: number };
}

/** DOM-style button mask (DESIGN §2.4): left 1, right 2, middle 4. */
export const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 } as const;

async function foreignInputCheck(session: DeviceSession, held: HeldState, warnings: string[]): Promise<void> {
  if (held.modifierMask !== 0 || held.buttons !== 0) return; // holding things; baseline meaningless
  try {
    const down = (await session.call("getKeyDownState", {}, { timeoutMs: 3_000 })) as {
      modifier?: number;
      keys?: number[];
    };
    const foreignKeys = (down.keys ?? []).filter((k) => k !== 0);
    if (foreignKeys.length > 0 || (down.modifier ?? 0) !== 0) {
      warnings.push(
        `foreign input suspected: device reports held keys [${foreignKeys.join(", ")}] / modifier ${down.modifier ?? 0} that this session did not press`,
      );
    }
  } catch {
    // method may be absent; heuristic only
  }
}

/**
 * Run one atomic input transaction under the per-device input mutex with the
 * cross-process claim, guaranteeing the cleanup invariant on every exit path.
 */
export async function runInputTransaction<T>(
  session: DeviceSession,
  holder: string,
  fn: (tx: InputTransaction) => Promise<T>,
  opts: { signal?: AbortSignal; force?: boolean } = {},
): Promise<{ result: T; warnings: string[] }> {
  session.ensureClaim(opts.force);
  const release = await session.locks.input.acquire(holder);
  const held: HeldState = { modifierMask: 0, keyUsages: [], buttons: 0, pointer: { x: 0, y: 0 } };
  const warnings: string[] = [];
  const startedAt = Date.now();

  const abortableSleep = async (ms: number): Promise<void> => {
    if (opts.signal?.aborted) throw new JetKvmError("Aborted", "input transaction aborted");
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        if (!opts.signal) return;
        opts.signal.addEventListener(
          "abort",
          () => reject(new JetKvmError("Aborted", "input transaction aborted")),
          { once: true },
        );
      }),
    ]);
  };

  const tx: InputTransaction = {
    async keyboardReport(modifierMask, usages) {
      await session.call("keyboardReport", { modifier: modifierMask, keys: hidKeysPayload(usages) });
      held.modifierMask = modifierMask;
      held.keyUsages = usages.filter((u) => u !== 0);
    },
    async mouseReport(x, y, buttons) {
      await session.call("absMouseReport", { x, y, buttons });
      held.buttons = buttons;
      held.pointer = { x, y };
    },
    async wheelReport(wheelY, wheelX = 0) {
      await session.call("wheelReport", { wheelY, wheelX });
    },
    abortableSleep,
  };

  try {
    await foreignInputCheck(session, held, warnings);
    if (session.auth.tokenRotatedRecently(startedAt - 60_000)) {
      warnings.push("auth token rotated recently — another client (browser UI?) may be active");
    }
    const result = await fn(tx);
    return { result, warnings };
  } finally {
    // Cleanup invariant: release exactly what we hold, best-effort, before unlock.
    try {
      if (held.modifierMask !== 0 || held.keyUsages.length > 0) {
        await session.call("keyboardReport", { modifier: 0, keys: hidKeysPayload([]) });
      }
      if (held.buttons !== 0) {
        await session.call("absMouseReport", { x: held.pointer.x, y: held.pointer.y, buttons: 0 });
      }
    } catch {
      // connection already gone; device-side HID times held keys out on disconnect
    }
    release();
  }
}

// ---------------------------------------------------------------------------
// Higher-level operations (used by the tools)
// ---------------------------------------------------------------------------

export interface TypeOptions {
  text: string;
  keystrokeDelayMs?: number;
  settleMs?: number;
}

export async function typeText(tx: InputTransaction, opts: TypeOptions): Promise<{ chars: number; skipped: string[] }> {
  const delay = opts.keystrokeDelayMs ?? 25;
  const skipped: string[] = [];
  let chars = 0;
  for (const ch of opts.text) {
    const mapped = CHAR_USAGE[ch];
    if (!mapped) {
      skipped.push(ch);
      continue;
    }
    const mask = mapped.shift ? MODIFIER_ALIASES.shift! : 0;
    await tx.keyboardReport(mask, [mapped.usage]);
    await tx.abortableSleep(delay);
    await tx.keyboardReport(0, []);
    await tx.abortableSleep(delay);
    chars++;
  }
  await tx.abortableSleep(opts.settleMs ?? 120);
  return { chars, skipped };
}

export async function pressChord(tx: InputTransaction, chord: Chord, durationMs = 60): Promise<void> {
  const hold = Math.max(40, durationMs); // never shorter than 40ms (auto-repeat, DESIGN §4.3)
  // Modifiers down, staggered 10ms each.
  const orderedBits = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
  for (const bit of orderedBits) {
    if (chord.modifierMask & bit) {
      await tx.keyboardReport(chord.modifierMask & (bit | (bit - 1)), []);
      await tx.abortableSleep(10);
    }
  }
  if (chord.modifierMask !== 0) await tx.keyboardReport(chord.modifierMask, []);
  for (const usage of chord.usages) {
    await tx.keyboardReport(chord.modifierMask, [usage]);
    await tx.abortableSleep(hold);
    await tx.keyboardReport(chord.modifierMask, []);
    await tx.abortableSleep(10);
  }
  if (chord.modifierMask !== 0) {
    await tx.abortableSleep(10);
    await tx.keyboardReport(0, []);
  }
}

export interface ClickOptions {
  x: number;
  y: number;
  button?: keyof typeof MOUSE_BUTTONS;
  modifiers?: string[];
  double?: boolean;
}

export async function clickAt(tx: InputTransaction, session: DeviceSession, opts: ClickOptions): Promise<void> {
  const dims = await session.videoDims();
  const hx = pixelToHid(opts.x, dims.width);
  const hy = pixelToHid(opts.y, dims.height);
  const bit = MOUSE_BUTTONS[opts.button ?? "left"];
  let modMask = 0;
  for (const m of opts.modifiers ?? []) {
    const alias = MODIFIER_ALIASES[m.toLowerCase()];
    if (alias === undefined) {
      throw new JetKvmError("UnknownKey", `unknown modifier "${m}"`);
    }
    modMask |= alias;
  }
  await tx.mouseReport(hx, hy, 0);
  await tx.abortableSleep(20);
  const cycles = opts.double ? 2 : 1;
  for (let i = 0; i < cycles; i++) {
    if (modMask !== 0) {
      await tx.keyboardReport(modMask, []);
      await tx.abortableSleep(10);
    }
    await tx.mouseReport(hx, hy, bit);
    await tx.abortableSleep(30);
    await tx.mouseReport(hx, hy, 0);
    if (modMask !== 0) {
      await tx.abortableSleep(10);
      await tx.keyboardReport(0, []);
    }
    if (cycles > 1) await tx.abortableSleep(60);
  }
}

export interface DragOptions {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  steps?: number;
}

export async function dragTo(tx: InputTransaction, session: DeviceSession, opts: DragOptions): Promise<void> {
  const dims = await session.videoDims();
  const steps = Math.max(2, opts.steps ?? 12);
  const h1x = pixelToHid(opts.x1, dims.width);
  const h1y = pixelToHid(opts.y1, dims.height);
  const h2x = pixelToHid(opts.x2, dims.width);
  const h2y = pixelToHid(opts.y2, dims.height);
  await tx.mouseReport(h1x, h1y, 0);
  await tx.abortableSleep(30);
  await tx.mouseReport(h1x, h1y, MOUSE_BUTTONS.left);
  await tx.abortableSleep(30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(h1x + (h2x - h1x) * t);
    const y = Math.round(h1y + (h2y - h1y) * t);
    await tx.mouseReport(x, y, MOUSE_BUTTONS.left);
    await tx.abortableSleep(16);
  }
  await tx.abortableSleep(30);
  await tx.mouseReport(h2x, h2y, 0);
}

export async function scrollAt(
  tx: InputTransaction,
  session: DeviceSession,
  opts: { x: number; y: number; dy: number; dx?: number },
): Promise<void> {
  const dims = await session.videoDims();
  await tx.mouseReport(pixelToHid(opts.x, dims.width), pixelToHid(opts.y, dims.height), 0);
  await tx.abortableSleep(20);
  const dyTotal = clamp(Math.round(opts.dy), -127, 127);
  const dxTotal = clamp(Math.round(opts.dx ?? 0), -127, 127);
  // One notch per wheelReport, paced; positive = up/right (DESIGN §2.4).
  const notches = Math.max(Math.abs(dyTotal), Math.abs(dxTotal));
  for (let i = 0; i < notches; i++) {
    const dy = Math.sign(dyTotal) * (i < Math.abs(dyTotal) ? 1 : 0);
    const dx = Math.sign(dxTotal) * (i < Math.abs(dxTotal) ? 1 : 0);
    if (dy === 0 && dx === 0) break;
    await tx.wheelReport(dy, dx);
    await tx.abortableSleep(20);
  }
}
