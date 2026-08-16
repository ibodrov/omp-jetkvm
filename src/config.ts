/**
 * Configuration: schema, defaults, YAML loading.
 * Reads `<project>/.omp/config.yml` (wins) and `~/.omp/agent/config.yml`,
 * key `jetkvm:`. DESIGN §5.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { expandTilde, JetKvmError } from "./util.ts";

export interface DeviceConfig {
  /** IP, hostname, or mDNS name; optional scheme (default http). */
  host: string;
  password?: string;
  passwordEnv?: string;
  passwordFile?: string;
  noTlsVerify?: boolean;
}

export interface ScreenshotConfig {
  engine: "auto" | "browser" | "recorder" | "wasm";
  recorderPath: string;
  chromiumPath: string;
  screenshotDir: string;
  maxModelWidth: number;
  idleTimeoutMs: number;
}

export interface SessionConfig {
  rpcTimeoutMs: number;
  idleTimeoutMs: number;
  keepaliveMs: number;
}

export interface ConcurrencyConfig {
  crossProcess: "lock" | "none";
  queueTimeoutMs: number;
}

export interface PolicyConfig {
  allowPowerActions: boolean;
  allowUsbDisconnect: boolean;
  forceUnmountOnMount: boolean;
}

export interface JetKvmConfig {
  devices: Record<string, DeviceConfig>;
  screenshot: ScreenshotConfig;
  session: SessionConfig;
  concurrency: ConcurrencyConfig;
  policy: PolicyConfig;
}

const DEFAULTS: JetKvmConfig = {
  devices: {},
  screenshot: {
    engine: "auto",
    recorderPath: "",
    chromiumPath: "",
    screenshotDir: "",
    maxModelWidth: 1024,
    idleTimeoutMs: 600_000,
  },
  session: { rpcTimeoutMs: 10_000, idleTimeoutMs: 600_000, keepaliveMs: 20_000 },
  concurrency: { crossProcess: "lock", queueTimeoutMs: 5_000 },
  policy: {
    allowPowerActions: true,
    allowUsbDisconnect: false,
    forceUnmountOnMount: true,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(overlay)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

function candidatePaths(cwd: string): string[] {
  return [
    `${cwd}/.omp/config.yml`,
    `${expandTilde("~/.omp/agent/config.yml")}`,
  ];
}

let cached: { key: string; config: JetKvmConfig } | null = null;

/**
 * Load the `jetkvm:` config key, merged user → project (project wins).
 * Cached per (path, mtime) so tool calls don't re-parse on every invocation.
 * Returns the merged config even when no `jetkvm:` key exists (empty devices)
 * so callers can decide how to surface "not configured".
 */
export function loadJetKvmConfig(cwd: string): JetKvmConfig {
  let config: JetKvmConfig = structuredClone(DEFAULTS);
  const stamp: string[] = [];
  for (const path of candidatePaths(cwd)) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    stamp.push(`${path}:${stat.mtimeMs}`);
  }
  const key = stamp.join("|");
  if (cached && cached.key === key) return cached.config;

  for (const path of candidatePaths(cwd)) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new JetKvmError("ConfigParseError", `failed to parse ${path}: ${String(err)}`);
    }
    if (!isPlainObject(parsed)) continue;
    const jetkvm = parsed["jetkvm"];
    if (jetkvm === undefined) continue;
    if (!isPlainObject(jetkvm)) {
      throw new JetKvmError("ConfigError", `jetkvm key in ${path} must be a mapping`);
    }
    config = deepMerge(config, jetkvm);
  }
  cached = { key, config };
  return config;
}

/** Reset the cache (tests). */
export function resetConfigCache(): void {
  cached = null;
}

/** Resolve a device by name; `undefined` means "the default device". */
export function resolveDevice(cfg: JetKvmConfig, device?: string): DeviceConfig {
  const name = device ?? "default";
  const dev = cfg.devices[name];
  if (!dev || !dev.host) {
    const configured = Object.keys(cfg.devices).filter((k) => cfg.devices[k]?.host);
    throw new JetKvmError(
      "DeviceNotConfigured",
      configured.length === 0
        ? "no JetKVM device is configured — add a `jetkvm.devices.<name>.host` entry to .omp/config.yml or ~/.omp/agent/config.yml, then reload"
        : `device "${name}" is not configured — available: ${configured.join(", ")}`,
    );
  }
  return dev;
}

/** Normalize a device host into origin + hostname. */
export function splitOrigin(host: string): { origin: string; hostname: string; secure: boolean } {
  const secure = host.startsWith("https://");
  const raw = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { origin: `${secure ? "https" : "http"}://${raw}`, hostname: raw.split(":")[0]!, secure };
}

/** Resolve the device password: `password` → `passwordEnv` → `passwordFile`. */
export function resolvePassword(dev: DeviceConfig): string | null {
  if (dev.password && dev.password.length > 0) return dev.password;
  if (dev.passwordEnv) {
    const v = process.env[dev.passwordEnv];
    if (v && v.length > 0) return v;
  }
  if (dev.passwordFile) {
    const path = expandTilde(dev.passwordFile);
    if (existsSync(path)) {
      const v = readFileSync(path, "utf8").trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}
