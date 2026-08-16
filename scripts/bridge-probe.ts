import puppeteer from "puppeteer-core";
declare const window: { __jetkvm: { createOffer(): Promise<string>; setAnswer(b: string): Promise<void>; waitFrame(ms: number): Promise<boolean>; capture(o: unknown): Promise<{ modelB64: string; width: number; height: number }>; state(): Record<string, unknown>; } };
import { loadJetKvmConfig, resolveDevice } from "../src/config.ts";
import { AuthState } from "../src/connection.ts";

const t0 = Date.now();
const log = (m: string) => console.log(`+${Date.now() - t0}ms ${m}`);

const cfg = loadJetKvmConfig(process.cwd());
const dev = resolveDevice(cfg);
const auth = new AuthState(dev);

const html = Bun.file(new URL("../src/screenshot/bridge.html", import.meta.url).pathname);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    log(`[http] ${req.method} ${url.pathname}`);
    if (url.pathname === "/bridge.html") {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("nf", { status: 404 });
  },
});
log(`bridge server on :${server.port}`);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox",
  "--disable-features=WebRtcHideLocalIpsWithMdns", "--no-first-run", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (msg) => log(`[page-console] ${msg.text()}`));
page.on("pageerror", (err) => log(`[page-error] ${String(err)}`));
log("page ready");

await page.goto(`http://127.0.0.1:${server.port}/bridge.html`, { waitUntil: "domcontentloaded" });
log("bridge loaded");

const offerB64 = (await page.evaluate("window.__jetkvm.createOffer()")) as string;
log(`offer created (${offerB64.length} b64 chars)`);

const resp = await auth.authedFetch("/webrtc/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sd: offerB64 }),
});
log(`signaling HTTP ${resp.status}`);
const { sd } = (await resp.json()) as { sd: string };
const answerDesc = JSON.parse(Buffer.from(sd, "base64").toString("utf8")) as { type: string; sdp: string };
for (const line of answerDesc.sdp.split("\n")) {
  console.log(`  [answer] ${line.trimEnd()}`);
}
log(`answer type=${answerDesc.type}`);

await page.evaluate((b64: string) => window.__jetkvm.setAnswer(b64), sd);
log("answer set");

try {
  await page.evaluate((ms: number) => window.__jetkvm.waitFrame(ms), 20_000);
  log("FRAME READY");
} catch (err) {
  log(`waitFrame failed: ${String(err)}`);
}
const st = (await page.evaluate("window.__jetkvm.state()")) as Record<string, unknown>;
log(`state: ${JSON.stringify(st)}`);

if (st["frameReady"]) {
  const r = (await page.evaluate(
    (o: unknown) => window.__jetkvm.capture(o),
    { format: "jpeg", quality: 75, maxModelWidth: 1024 },
  )) as { modelB64: string; width: number; height: number };
  log(`captured ${r.width}x${r.height}, model b64 ${r.modelB64.length}`);
  await Bun.write("/tmp/bridge-frame.jpg", Buffer.from(r.modelB64, "base64"));
  log("wrote /tmp/bridge-frame.jpg");
}

await browser.close();
server.stop(true);
process.exit(0);
