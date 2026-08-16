/**
 * tool_call policy gates. DESIGN §4.5: config-level kill switches on top of
 * omp's approval flow. These block *before* execution (fail-closed).
 */
import type { PolicyConfig } from "./config.ts";

export interface ToolCallEventLike {
  toolName: string;
  input: Record<string, unknown>;
}

export interface BlockResult {
  block: true;
  reason: string;
}
export type InterceptorResult = BlockResult | { block: false; reason?: string } | void;

export function policyGate(policy: PolicyConfig, event: ToolCallEventLike): InterceptorResult {
  if (!event.toolName.startsWith("jetkvm_")) return;
  const input = event.input;
  switch (event.toolName) {
    case "jetkvm_device": {
      const action = input["action"];
      if (action === "power" && !policy.allowPowerActions) {
        const op = String(input["op"] ?? "");
        if (op === "atx-state" || op === "dc-state") return; // reads always allowed
        return {
          block: true,
          reason: "power actions are disabled by jetkvm.policy.allowPowerActions=false",
        };
      }
      if (action === "usb" && input["enabled"] === false && !policy.allowUsbDisconnect) {
        return {
          block: true,
          reason:
            "disconnecting USB emulation (unplugging the KVM from the host) is disabled by jetkvm.policy.allowUsbDisconnect=false",
        };
      }
      return;
    }
    case "jetkvm_storage": {
      if (input["action"] === "delete_file" && input["filename"] === undefined) {
        return { block: true, reason: "delete_file requires filename" };
      }
      return;
    }
    default:
      return;
  }
}
