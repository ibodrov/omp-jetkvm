import { loadJetKvmConfig } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";

const url = process.argv[2]!;
const mode = (process.argv[3] as "CDROM" | "Disk") ?? "CDROM";
const cfg = loadJetKvmConfig(process.cwd());
const session = new ConnectionManager(cfg).session();
await session.ensureConnected();

console.log(`calling mountWithHTTP {url: ${url}, mode: ${mode}} directly`);
try {
  const r = await session.call("mountWithHTTP", { url, mode }, { timeoutMs: 45_000 });
  console.log("mountWithHTTP ok:", JSON.stringify(r));
} catch (e) {
  console.log("mountWithHTTP failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  console.log("details:", JSON.stringify((e as { details?: unknown }).details));
}
const state = await session.call("getVirtualMediaState", {}, { retryOnReconnect: true });
console.log("virtualMediaState:", JSON.stringify(state));
await ConnectionManager.disposeAll();
process.exit(0);
