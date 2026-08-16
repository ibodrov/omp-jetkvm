/**
 * Small shared utilities: cookie jar helpers, base64 SDP codec, sleep, clamp.
 * No device knowledge lives here.
 */
import { join } from "node:path";
import os from "node:os";

export class JetKvmError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JetKvmError";
  }
}

/** Expand a leading `~` to the user home directory. */
export function expandTilde(p: string): string {
  const home = process.env.HOME ?? os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** SDP transport codec: the device exchanges `{sd: base64(JSON(RTCSessionDescription))}`. */
export const sdpCodec = {
  encode(desc: { type: string; sdp: string }): string {
    return Buffer.from(JSON.stringify(desc), "utf8").toString("base64");
  },
  decode(sd: string): { type: string; sdp: string } {
    const parsed = JSON.parse(Buffer.from(sd, "base64").toString("utf8"));
    if (typeof parsed?.type !== "string" || typeof parsed?.sdp !== "string") {
      throw new JetKvmError("BadSdp", "device returned a malformed session description");
    }
    return parsed;
  },
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Map a pixel coordinate in stream space to HID absolute space (0..32767).
 * DESIGN §3.3: `hid = round(clamp(x, 0, W-1) / (W-1) * 32767)` per axis.
 */
export function pixelToHid(v: number, extent: number): number {
  const max = Math.max(1, extent - 1);
  return Math.round((clamp(Math.round(v), 0, max) / max) * 32767);
}

/** Never let credential material reach logs or tool results. */
export function redact(text: string, secret?: string): string {
  if (!secret || secret.length < 3) return text;
  return text.split(secret).join("<redacted>");
}

/** Format a Date as `YYYYMMDD_HHMMSS_mmm` (screenshot file names). */
export function timestampName(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`
  );
}

/** Readable byte sizes for status cards. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** First non-internal IPv4 address of this machine (for serve_and_mount URLs). */
export function pickLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}
