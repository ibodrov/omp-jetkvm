import { loadJetKvmConfig } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";
const cfg = loadJetKvmConfig(process.cwd());
const s = new ConnectionManager(cfg).session();
await s.ensureConnected();
console.log("dc before:", JSON.stringify(await s.call("getDCPowerState", {}, { retryOnReconnect: true })));
try {
  console.log("set:", JSON.stringify(await s.call("setDCPowerState", { isOn: true })));
} catch (e) {
  console.log("setDCPowerState failed:", e instanceof Error ? e.message : String(e));
}
await new Promise((r) => setTimeout(r, 3000));
console.log("dc after:", JSON.stringify(await s.call("getDCPowerState", {}, { retryOnReconnect: true })));
console.log("atx:", JSON.stringify(await s.call("getATXState", {}, { retryOnReconnect: true })));
console.log("video:", JSON.stringify(await s.call("getVideoState", {}, { retryOnReconnect: true })));
await ConnectionManager.disposeAll();
process.exit(0);
