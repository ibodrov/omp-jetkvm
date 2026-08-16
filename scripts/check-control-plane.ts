/** Live control-plane check: login, datachannel, ping, read-only RPC shapes. */
import { loadJetKvmConfig, resolveDevice } from "../src/config.ts";
import { ConnectionManager } from "../src/connection.ts";

const cwd = process.argv[2] ?? process.cwd();
const cfg = loadJetKvmConfig(cwd);
const devName = process.argv[3] ?? "default";
resolveDevice(cfg, devName); // throws helpfully when unconfigured

const mgr = new ConnectionManager(cfg);
const session = mgr.session(devName);

console.log("[connect] ...");
await session.ensureConnected();
console.log("[connect] connected ✓");

console.log("[ping]", JSON.stringify(await session.call("ping")));
for (const m of ["getVideoState", "getATXState", "getStorageSpace", "getVirtualMediaState", "getKeyboardLayout"]) {
  const r = await session.call(m, {}, { retryOnReconnect: true });
  console.log(`[rpc] ${m}:`, JSON.stringify(r));
}
console.log("[dims]", JSON.stringify(await session.videoDims()));
console.log("[snapshot]", JSON.stringify(session.snapshot(), null, 2));
await ConnectionManager.disposeAll();
process.exit(0);
