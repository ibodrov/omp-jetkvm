/**
 * Engine `browser` (default): warm headless-Chromium page decodes the H.264
 * stream via libwebrtc; the extension does ALL device HTTP itself — the page
 * only exchanges SDP strings and returns canvas pixels (DESIGN §3.2).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { JetKvmError } from "../util.ts";
import type { DeviceConfig, JetKvmConfig } from "../config.ts";
import type { AuthState } from "../connection.ts";
import { AuthState as AuthStateClass } from "../connection.ts";
import type { CaptureOptions, CaptureResult, ScreenshotEngine } from "./engine.ts";

declare global {
  interface Window {
    __jetkvm: {
      createOffer(): Promise<string>;
      setAnswer(b64: string): Promise<void>;
      waitFrame(ms: number): Promise<boolean>;
      capture(o: { format: string; quality: number; maxModelWidth: number }): Promise<{
        fullB64: string;
        modelB64: string;
        width: number;
        height: number;
      }>;
      state(): { connected?: string | boolean; frameReady?: boolean; width?: number; height?: number; ageMs?: number | null };
      close(): void;
    };
  }
}

declare const window: Window;

interface BridgeResult {
  fullB64: string;
  modelB64: string;
  width: number;
  height: number;
}

export class BrowserEngine implements ScreenshotEngine {
  readonly name = "browser";
  private browser: Browser | null = null;
  private page: Page | null = null;
  private chromiumProc: ChildProcess | null = null;
  private chromiumDir: string | null = null;
  private bridgeServer: ReturnType<typeof Bun.serve> | null = null;
  private idleTimer: Timer | null = null;
  private connecting: Promise<void> | null = null;
  private lastCaptureAt = 0;
  private readonly auth: AuthState;

  constructor(
    private readonly chromiumPath: string,
    private readonly dev: DeviceConfig,
    private readonly cfg: JetKvmConfig,
  ) {
    this.auth = new AuthStateClass(dev);
  }

  private bridgeUrl(): string {
    if (!this.bridgeServer) {
      const html = Bun.file(import.meta.dir + "/bridge.html");
      this.bridgeServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/bridge.html") {
            return new Response(html, { headers: { "Content-Type": "text/html" } });
          }
          return new Response("not found", { status: 404 });
        },
      });
    }
    return `http://127.0.0.1:${this.bridgeServer.port}/bridge.html`;
  }

  private armIdleKill(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.dispose().catch(() => {});
    }, this.cfg.screenshot.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /**
   * Launch Chromium directly and attach over the DevTools WebSocket.
   * NOT puppeteer.launch: its launcher waits on an internal spawn/pipe
   * handshake that wedges under Bun (node: fine; bun: hangs forever), while
   * Bun's plain spawn + stderr streaming + ws client are all solid. The
   * browser announces `DevTools listening on ws://...` on stderr with
   * --remote-debugging-port=0; we parse and connect.
   */
  private async ensurePage(): Promise<Page> {
    if (this.page && this.browser) return this.page;
    const userDir = mkdtempSync(join(tmpdir(), "omp-jetkvm-chromium-"));
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      `--user-data-dir=${userDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const child = spawn(this.chromiumPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.chromiumProc = child;
    this.chromiumDir = userDir;
    const { promise, resolve } = Promise.withResolvers<string | Error>();
    let stderrTail = "";
    const timer = setTimeout(
      () => settle(new JetKvmError("ChromiumLaunchTimeout", `chromium did not expose a DevTools endpoint in 15s: ${stderrTail.slice(-200)}`)),
      15_000,
    );
    let settled = false;
    const settle = (v: string | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    child.stderr!.on("data", (d: Buffer) => {
      stderrTail += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderrTail);
      if (m) settle(m[1]!);
    });
    child.once("exit", (code) => {
      settle(new JetKvmError("ChromiumLaunchFailed", `chromium exited early (code ${String(code)}): ${stderrTail.slice(-300)}`));
    });
    try {
      const endpoint = await promise;
      if (endpoint instanceof Error) throw endpoint;
      this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      this.page = await this.browser.newPage();
      await this.page.setDefaultTimeout(30_000);
      await this.page.goto(this.bridgeUrl(), { waitUntil: "domcontentloaded" });
      return this.page;
    } catch (err) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(userDir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Full connection dance: page builds a recvonly offer (libwebrtc), the
   * extension exchanges it over the device's HTTP signaling, the page sets
   * the answer and waits for the first decoded frame.
   */
  private async connectBridge(page: Page): Promise<void> {
    const offerB64 = (await page.evaluate("window.__jetkvm.createOffer()")) as string;
    const resp = await this.auth.authedFetch("/webrtc/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sd: offerB64 }),
    });
    if (!resp.ok) {
      throw new JetKvmError("SignalingFailed", `bridge signaling POST failed: HTTP ${resp.status}`);
    }
    const { sd } = (await resp.json()) as { sd: string };
    await page.evaluate((b64: string) => window.__jetkvm.setAnswer(b64), sd);
    await page.evaluate((ms: number) => window.__jetkvm.waitFrame(ms), 15_000);
  }

  private async ensureConnected(maxFrameAgeMs?: number): Promise<Page> {
    const page = await this.ensurePage();
    try {
      const state = (await page.evaluate("window.__jetkvm.state()")) as {
        connected?: string | boolean;
        frameReady?: boolean;
        ageMs?: number | null;
      };
      if (state.frameReady && (maxFrameAgeMs === undefined || (state.ageMs ?? Infinity) <= maxFrameAgeMs)) {
        return page;
      }
      // No frame yet, or the decoded frame is stale (idle screen / stalled
      // session): rebuild the session — fresh sessions get an immediate IDR.
      if (state.frameReady) {
        await page.evaluate("window.__jetkvm.close()");
      }
    } catch {
      // page died; fall through to relaunch
      await this.closePage();
      return this.ensureConnected(maxFrameAgeMs);
    }
    if (!this.connecting) {
      this.connecting = this.connectBridge(page)
        .catch(async (err) => {
          await this.closePage();
          throw err;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    await this.connecting;
    return page;
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    this.armIdleKill();
    // Screenshots must reflect the CURRENT screen: accept a decoded frame at
    // most 5s old; otherwise rebuild the session (fresh IDR on connect).
    const page = await this.ensureConnected(5_000);
    let r: BridgeResult;
    try {
      r = (await page.evaluate(
        (o: { format: string; quality: number; maxModelWidth: number }) =>
          window.__jetkvm.capture(o),
        { format: opts.format, quality: opts.quality, maxModelWidth: opts.maxModelWidth },
      )) as BridgeResult;
    } catch (err) {
      // Stream went stale (host reboot, resolution change): reconnect once.
      await this.closePage();
      const fresh = await this.ensureConnected();
      r = (await fresh.evaluate(
        (o: { format: string; quality: number; maxModelWidth: number }) =>
          window.__jetkvm.capture(o),
        { format: opts.format, quality: opts.quality, maxModelWidth: opts.maxModelWidth },
      )) as BridgeResult;
    }
    this.lastCaptureAt = Date.now();
    return {
      modelData: r.modelB64,
      modelMime: opts.format === "png" ? "image/png" : "image/jpeg",
      fullData: r.fullB64,
      fullMime: opts.format === "png" ? "image/png" : "image/jpeg",
      width: r.width,
      height: r.height,
    };
  }

  get lastCapture(): number {
    return this.lastCaptureAt;
  }

  private async closePage(): Promise<void> {
    const page = this.page;
    this.page = null;
    if (page) {
      try {
        await page.close();
      } catch {
        // already closed
      }
    }
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      try {
        // We spawned this browser ourselves: close() both disconnects the
        // ws and shuts the browser down.
        await browser.close();
      } catch {
        // already closed
      }
    }
    const child = this.chromiumProc;
    this.chromiumProc = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      // Fire-and-forget escalate: browser.close() normally ends it; SIGKILL
      // is the belt for wedged renderers.
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref?.();
    }
    const dir = this.chromiumDir;
    this.chromiumDir = null;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; tmpfs cleans up eventually
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.closePage();
    if (this.bridgeServer) {
      this.bridgeServer.stop(true);
      this.bridgeServer = null;
    }
  }
}
