import { loadJetKvmConfig } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";

const cfg = loadJetKvmConfig(process.cwd());
const session = new ConnectionManager(cfg).session();
await session.ensureConnected();
console.log("connected; polling ping with 45s patience...");
try {
  const r = await session.call("ping", {}, { timeoutMs: 45_000 });
  console.log("ping:", JSON.stringify(r));
} catch (e) {
  console.log("ping still failing:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
try {
  const state = await session.call("getVirtualMediaState", {}, { timeoutMs: 60_000 });
  console.log("virtualMediaState:", JSON.stringify(state));
} catch (e) {
  console.log("getVirtualMediaState still failing:", e instanceof Error ? e.message : String(e));
}
await ConnectionManager.disposeAll();
process.exit(0);
