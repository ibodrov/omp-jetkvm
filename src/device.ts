/**
 * Device-level operations: status, video, ATX power, WoL, USB. DESIGN §4.5.
 * Policy gates (allowPowerActions / allowUsbDisconnect) live in
 * intercept.ts; this module is mechanics.
 */
import { JetKvmError } from "./util.ts";
import type { DeviceSession } from "./connection.ts";

export interface DeviceStatus {
  device: Record<string, unknown> | null;
  isSetup: boolean | null;
  localVersion: unknown;
  networkState: unknown;
  videoState: unknown;
  atxState: unknown;
  usbState: unknown;
  keyboardLayout: unknown;
  virtualMedia: unknown;
}

export async function getDeviceStatus(session: DeviceSession, signal?: AbortSignal): Promise<DeviceStatus> {
  const devResp = await session.auth.authedFetch("/device", { signal });
  let setupResp: Response | null;
  try {
    setupResp = await fetch(`${session.auth.origin}/device/status`, {
      headers: { Connection: "close" },
      signal,
    });
  } catch {
    if (signal?.aborted) throw new JetKvmError("Aborted", "device status request aborted");
    setupResp = null;
  }
  // Individual RPC failures degrade to null — status must stay useful under
  // firmware drift (DESIGN goal 4). Fan out: this is a status card, and the
  // RPC client multiplexes concurrent calls by id.
  const safe = async (method: string): Promise<unknown> => {
    try {
      return await session.call(method, {}, { retryOnReconnect: true, signal });
    } catch (err) {
      if (err instanceof JetKvmError && err.code === "Aborted") throw err;
      return null;
    }
  };
  const [localVersion, networkState, videoState, atxState, usbState, keyboardLayout, virtualMedia] = await Promise.all([
    safe("getLocalVersion"),
    safe("getNetworkState"),
    safe("getVideoState"),
    safe("getATXState"),
    safe("getUSBState"),
    safe("getKeyboardLayout"),
    safe("getVirtualMediaState"),
  ]);
  return {
    device: devResp.ok ? ((await devResp.json()) as Record<string, unknown>) : null,
    isSetup: setupResp?.ok ? ((await setupResp.json()) as { isSetup?: boolean }).isSetup ?? null : null,
    localVersion,
    networkState,
    videoState,
    atxState,
    usbState,
    keyboardLayout,
    virtualMedia,
  };
}

export type AtxOp = "atx-short" | "atx-long" | "atx-reset";

const ATX_ACTIONS: Record<AtxOp, string> = {
  "atx-short": "power-short",
  "atx-long": "power-long",
  "atx-reset": "reset",
};

export async function atxPowerAction(session: DeviceSession, op: AtxOp): Promise<{ atxState: unknown }> {
  try {
    await session.call("setATXPowerAction", { action: ATX_ACTIONS[op] });
  } catch (err) {
    if (err instanceof JetKvmError && err.details && (err.details as { deviceCode?: number }).deviceCode === -32601) {
      throw new JetKvmError("FirmwareLacksMethod", `device firmware lacks setATXPowerAction — no ATX hardware or old firmware (${String(err.message)})`);
    }
    throw err;
  }
  const atxState = await session.call("getATXState", {}, { retryOnReconnect: true });
  return { atxState };
}

export async function wakeHost(session: DeviceSession, mac?: string): Promise<Record<string, unknown>> {
  if (mac) {
    await session.call("sendWOLMagicPacket", { macAddress: mac });
    return { sent: "sendWOLMagicPacket", macAddress: mac };
  }
  try {
    await session.call("wakeHost");
    return { sent: "wakeHost" };
  } catch (err) {
    if (err instanceof JetKvmError && (err.details as { deviceCode?: number } | undefined)?.deviceCode === -32601) {
      throw new JetKvmError(
        "FirmwareLacksMethod",
        "device firmware lacks wakeHost and no mac was given — pass mac: \"aa:bb:cc:dd:ee:ff\" to use sendWOLMagicPacket",
      );
    }
    throw err;
  }
}

export async function setUsbEmulation(session: DeviceSession, enabled: boolean): Promise<Record<string, unknown>> {
  await session.call("setUsbEmulationState", { enabled });
  const usbState = await session.call("getUSBState", {}, { retryOnReconnect: true });
  return { usbState };
}
