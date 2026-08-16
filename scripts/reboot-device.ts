import { loadJetKvmConfig } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";

const cfg = loadJetKvmConfig(process.cwd());
const session = new ConnectionManager(cfg).session();
await session.ensureConnected();
console.log("calling reboot {force:true}");
try {
  const r = await session.call("reboot", { force: true }, { timeoutMs: 30_000 });
  console.log("reboot ok:", JSON.stringify(r));
} catch (e) {
  console.log("reboot call:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
}
await ConnectionManager.disposeAll();
process.exit(0);
