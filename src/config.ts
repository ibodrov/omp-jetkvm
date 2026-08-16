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
}

export interface ScreenshotConfig {
  engine: "auto" | "browser" | "recorder";
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

function configError(path: string, expected: string): never {
  throw new JetKvmError("ConfigError", `${path} must be ${expected}`);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  return isPlainObject(value) ? value : configError(path, "a mapping");
}

function expectString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && value.trim() === "")) {
    return configError(path, nonEmpty ? "a non-empty string" : "a string");
  }
  return value;
}

function expectNumber(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    return configError(path, `a finite number >= ${minimum}`);
  }
  return value;
}


function validateConfig(value: unknown): asserts value is JetKvmConfig {
  const root = expectObject(value, "jetkvm");
  const devices = expectObject(root["devices"], "jetkvm.devices");
  for (const [name, rawDevice] of Object.entries(devices)) {
    if (name.trim() === "") configError("jetkvm.devices", "a mapping with non-empty device names");
    const device = expectObject(rawDevice, `jetkvm.devices.${name}`);
    const host = expectString(device["host"], `jetkvm.devices.${name}.host`, true);
    splitOrigin(host);
    for (const key of ["password", "passwordEnv", "passwordFile"] as const) {
      if (device[key] !== undefined) expectString(device[key], `jetkvm.devices.${name}.${key}`);
    }
  }

  const screenshot = expectObject(root["screenshot"], "jetkvm.screenshot");
  const engine = expectString(screenshot["engine"], "jetkvm.screenshot.engine");
  if (engine !== "auto" && engine !== "browser" && engine !== "recorder") {
    configError("jetkvm.screenshot.engine", '"auto", "browser", or "recorder"');
  }
  for (const key of ["recorderPath", "chromiumPath", "screenshotDir"] as const) {
    expectString(screenshot[key], `jetkvm.screenshot.${key}`);
  }
  expectNumber(screenshot["maxModelWidth"], "jetkvm.screenshot.maxModelWidth", 1);
  expectNumber(screenshot["idleTimeoutMs"], "jetkvm.screenshot.idleTimeoutMs", 1);

  const session = expectObject(root["session"], "jetkvm.session");
  for (const key of ["rpcTimeoutMs", "idleTimeoutMs", "keepaliveMs"] as const) {
    expectNumber(session[key], `jetkvm.session.${key}`, 1);
  }

  const concurrency = expectObject(root["concurrency"], "jetkvm.concurrency");
  const crossProcess = expectString(concurrency["crossProcess"], "jetkvm.concurrency.crossProcess");
  if (crossProcess !== "lock" && crossProcess !== "none") {
    configError("jetkvm.concurrency.crossProcess", '"lock" or "none"');
  }
  expectNumber(concurrency["queueTimeoutMs"], "jetkvm.concurrency.queueTimeoutMs", 0);
  const policy = expectObject(root["policy"], "jetkvm.policy");
  for (const key of ["allowPowerActions", "allowUsbDisconnect", "forceUnmountOnMount"] as const) {
    if (typeof policy[key] !== "boolean") configError(`jetkvm.policy.${key}`, "a boolean");
  }
}

function candidatePaths(cwd: string): string[] {
  return [
    `${expandTilde("~/.omp/agent/config.yml")}`,
    `${cwd}/.omp/config.yml`,
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
      const reason = err instanceof Error ? err.message.split("\n", 1)[0] : "invalid YAML";
      throw new JetKvmError("ConfigParseError", `failed to parse ${path}: ${reason}`);
    }
    if (!isPlainObject(parsed)) continue;
    const jetkvm = parsed["jetkvm"];
    if (jetkvm === undefined) continue;
    if (!isPlainObject(jetkvm)) {
      throw new JetKvmError("ConfigError", `jetkvm key in ${path} must be a mapping`);
    }
    config = deepMerge(config, jetkvm);
  }
  validateConfig(config);
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
  if (host.trim() !== host || host === "") {
    throw new JetKvmError("ConfigError", "device host must be a non-empty string without surrounding whitespace");
  }
  const input = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new JetKvmError("ConfigError", `invalid device host "${host}"`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new JetKvmError("ConfigError", `device host "${host}" must use http or https`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new JetKvmError("ConfigError", `device host "${host}" must contain only a hostname and optional port`);
  }
  return { origin: url.origin, hostname: url.hostname, secure: url.protocol === "https:" };
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
