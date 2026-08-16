/**
 * Live smoke suite against a real JetKVM. DESIGN §7.
 *
 * Usage: JETKVM_HOST=192.168.1.100 JETKVM_PASSWORD_FILE=/path/pwd \
 *        bun scripts/smoke.ts [proto|input|storage|engine|all]
 *
 * No hardcoded lab constants — everything comes from the environment or
 * .omp/config.yml. Exits non-zero on any failure; prints one line per check.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJetKvmConfig, type JetKvmConfig } from "../src/config.ts";
import { ConnectionManager, type DeviceSession } from "../src/connection.ts";
import { parseChord, pressChord, runInputTransaction } from "../src/input.ts";
import { getMountState, getSpace, listFiles, mountFile, unmount, uploadFile, deleteFile } from "../src/storage.ts";
import { engineFor, disposeEngines } from "../src/tools.ts";

const host = process.env.JETKVM_HOST;
const pwdFile = process.env.JETKVM_PASSWORD_FILE;
const suite = process.argv[2] ?? "all";

if (!host || !pwdFile) {
  console.error("set JETKVM_HOST and JETKVM_PASSWORD_FILE (see scripts/smoke.ts header)");
  process.exit(2);
}

// Build an in-memory config pointed at the env-provided device.
const cfg: JetKvmConfig = {
  ...loadJetKvmConfig(process.cwd()),
  devices: {
    default: { host, passwordFile: pwdFile },
  },
};

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const mgr = new ConnectionManager(cfg);
const session: DeviceSession = mgr.session("default");

async function proto(): Promise<void> {
  console.log("\n== proto (read-only shapes) ==");
  await session.ensureConnected();
  check("connect + datachannel", session.state === "connected");
  check("ping", (await session.call("ping")) === "pong");
  const vs = (await session.call("getVideoState", {}, { retryOnReconnect: true })) as { width?: number; height?: number };
  check("getVideoState has dimensions", Boolean(vs.width && vs.height), JSON.stringify(vs));
  check("getATXState", typeof (await session.call("getATXState")) === "object");
  check("getStorageSpace", typeof (await session.call("getStorageSpace")) === "object");
  check("listStorageFiles", Array.isArray((await session.call("listStorageFiles") as { files?: unknown[] })?.files));
  check("getKeyboardLayout", typeof (await session.call("getKeyboardLayout")) === "string");
  check("videoDims cache", Boolean((await session.videoDims()).width));
}

async function input(): Promise<void> {
  console.log("\n== input (wire-level injection) ==");
  // Hold a key and observe it in getKeyDownState — proves injection works even
  // with the host powered off (no pixels needed).
  const observed = await runInputTransaction(session, "smoke", async (tx) => {
    await tx.keyboardReport(0, [0x17]); // t
    await tx.abortableSleep(80);
    const down = (await session.call("getKeyDownState", {}, { timeoutMs: 3_000 })) as { keys?: number[] };
    return Array.isArray(down.keys) && down.keys.includes(0x17);
  });
  check("keyboardReport observed via getKeyDownState", observed.result === true);
  // Right-ctrl tap (official UI e2e pattern).
  const tap = await runInputTransaction(session, "smoke", async (tx) => {
    await pressChord(tx, parseChord("right-ctrl"));
    return true;
  });
  check("right-ctrl tap", tap.result === true);
  // Mouse move to center + release (inert while host is off, wire-level only).
  const dims = await session.videoDims();
  const moved = await runInputTransaction(session, "smoke", async (tx) => {
    await tx.mouseReport(Math.round(dims.width / 2 / (dims.width - 1) * 32767), Math.round(dims.height / 2 / (dims.height - 1) * 32767), 0);
    return true;
  });
  check("absMouseReport center", moved.result === true);
}

async function storage(): Promise<void> {
  console.log("\n== storage (upload → mount → unmount → delete) ==");
  const dir = mkdtempSync(join(tmpdir(), "jetkvm-smoke-"));
  const path = join(dir, "smoke.iso");
  // Firmware rejects CDROM mounts of tiny images (observed: <1MiB → -32603);
  // 4MiB exercises the real path.
  const payload = Buffer.alloc(4 * 1024 * 1024, 7);
  writeFileSync(path, payload);
  try {
    const up = await uploadFile(session, { path, filename: "smoke.iso" });
    check("upload", up.filename === "smoke.iso" && up.totalBytes === payload.length, `resumedFrom=${up.resumedFrom}`);
    const files = await listFiles(session);
    check("file listed", files.files.some((f) => f.filename === "smoke.iso"));
    const spaceBefore = (await getSpace(session)).bytesFree;
    await mountFile(session, cfg.policy, { filename: "smoke.iso", mode: "CDROM" });
    const mounted = await getMountState(session);
    check("mounted from storage", mounted?.source === "Storage" && mounted?.filename === "smoke.iso", JSON.stringify(mounted));
    await unmount(session);
    const after = await getMountState(session);
    check("unmounted", after === null || after === undefined);
    await deleteFile(session, "smoke.iso");
    const filesAfter = await listFiles(session);
    check("deleted", !filesAfter.files.some((f) => f.filename === "smoke.iso"));
    const spaceAfter = (await getSpace(session)).bytesFree;
    check("space reclaimed", spaceAfter >= spaceBefore, `${spaceAfter} >= ${spaceBefore}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function engine(): Promise<void> {
  console.log("\n== engine (screenshot capture parity) ==");
  try {
    const { engine } = await engineFor(cfg);
    const cap = await engine.capture({ format: "jpeg", quality: 75, maxModelWidth: 1024 });
    check(`${engine.name} capture`, cap.width > 0 && cap.modelData.length > 0, `${cap.width}x${cap.height}`);
  } catch (e) {
    check("engine capture", false, e instanceof Error ? e.message : String(e));
  }
  try {
    const recorderPath = process.env.JETKVM_RECORDER_PATH ?? "";
    const cfgRecorder = { ...cfg, screenshot: { ...cfg.screenshot, engine: "recorder" as const, recorderPath } };
    const { engine } = await engineFor(cfgRecorder);
    const cap = await engine.capture({ format: "png", quality: 75, maxModelWidth: 1024 });
    check(`${engine.name} capture`, cap.width > 0 && cap.modelData.length > 0, `${cap.width}x${cap.height}`);
  } catch (e) {
    check("recorder capture", false, e instanceof Error ? e.message : String(e));
  }
}

if (suite === "all" || suite === "proto") await proto();
if (suite === "all" || suite === "input") await input();
if (suite === "all" || suite === "storage") await storage();
if (suite === "all" || suite === "engine") await engine();

await ConnectionManager.disposeAll();
await disposeEngines();
console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
