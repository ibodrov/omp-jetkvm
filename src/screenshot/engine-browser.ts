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
import { abortable, JetKvmError } from "../util.ts";
import type { DeviceConfig, JetKvmConfig } from "../config.ts";
import type { AuthState } from "../connection.ts";
import { sharedAuthState } from "../connection.ts";
import type { CaptureOptions, CaptureResult, ScreenshotEngine } from "./engine.ts";

declare global {
  interface Window {
    __jetkvm: {
      createOffer(): Promise<string>;
      setAnswer(b64: string): Promise<void>;
      addCandidate(candidate: unknown): Promise<void>;
      waitFrame(ms: number): Promise<boolean>;
      capture(o: { format: string; quality: number; maxModelWidth: number }): Promise<{
        fullB64: string;
        modelB64: string;
        width: number;
        height: number;
      }>;
    };
  }
}

declare const window: Window;

interface BridgeResult {
  fullB64: string;
  modelB64: string;
  width: number;
  height: number;
  ageMs?: number;
}

export class BrowserEngine implements ScreenshotEngine {
  readonly name = "browser";
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pagePromise: Promise<Page> | null = null;
  private chromiumProc: ChildProcess | null = null;
  private chromiumDir: string | null = null;
  private bridgeServer: ReturnType<typeof Bun.serve> | null = null;
  private idleTimer: Timer | undefined;
  private idleCleanup: Promise<void> | null = null;
  private activeCaptures = 0;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  private readonly auth: AuthState;

  constructor(
    private readonly chromiumPath: string,
    dev: DeviceConfig,
    private readonly cfg: JetKvmConfig,
  ) {
    // Shared per-origin AuthState: a private instance would re-login and
    // rotate the device's single token out from under the control session
    // (every login invalidates the previous cookie).
    this.auth = sharedAuthState(dev);
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
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.disposed || this.activeCaptures > 0 || this.idleCleanup) return;
      const pending = this.releaseIdleResources();
      this.idleCleanup = pending;
      const settled = (): void => { if (this.idleCleanup === pending) this.idleCleanup = null; };
      pending.then(settled, settled);
    }, this.cfg.screenshot.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async releaseIdleResources(): Promise<void> {
    // A canceled caller may leave shared startup/signaling running. Drain it
    // before cleanup, and retain the page if another capture has arrived.
    const launching = this.pagePromise;
    const connecting = this.connecting;
    if (launching) await launching.catch(() => {});
    if (connecting) await connecting.catch(() => {});
    if (this.disposed || this.activeCaptures > 0) return;
    await this.releaseResources();
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
    if (this.idleCleanup) await this.idleCleanup;
    if (this.disposed) throw new JetKvmError("Aborted", "screenshot engine disposed");
    if (this.page && this.browser && !this.page.isClosed()) return this.page;
    if (this.pagePromise) return this.pagePromise;
    if (this.page || this.browser) await this.closePage();
    const pending = this.launchPage();
    this.pagePromise = pending;
    pending.then(
      () => { if (this.pagePromise === pending) this.pagePromise = null; },
      () => { if (this.pagePromise === pending) this.pagePromise = null; },
    );
    return pending;
  }

  private async launchPage(): Promise<Page> {
    if (this.page && this.browser) return this.page;
    const userDir = mkdtempSync(join(tmpdir(), "omp-jetkvm-chromium-"));
    const args = [
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      `--user-data-dir=${userDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const child = spawn(this.chromiumPath, args, { stdio: ["ignore", "ignore", "pipe"] });
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
      stderrTail = (stderrTail + String(d)).slice(-8_192);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderrTail);
      if (m) settle(m[1]!);
    });
    child.once("error", (err) => settle(new JetKvmError(
      "ChromiumLaunchFailed",
      `failed to start Chromium (${(err as NodeJS.ErrnoException).code ?? "unknown"})`,
    )));
    child.once("exit", (code) => {
      settle(new JetKvmError("ChromiumLaunchFailed", `chromium exited early (code ${String(code)}): ${stderrTail.slice(-300)}`));
    });
    try {
      const endpoint = await promise;
      if (endpoint instanceof Error) throw endpoint;
      if (this.disposed) throw new JetKvmError("Aborted", "screenshot engine disposed");
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      if (this.disposed) {
        await browser.close();
        throw new JetKvmError("Aborted", "screenshot engine disposed");
      }
      this.browser = browser;
      const page = await browser.newPage();
      if (this.disposed) {
        await browser.close();
        throw new JetKvmError("Aborted", "screenshot engine disposed");
      }
      this.page = page;
      await page.setDefaultTimeout(30_000);
      await page.goto(this.bridgeUrl(), { waitUntil: "domcontentloaded" });
      if (this.disposed) throw new JetKvmError("Aborted", "screenshot engine disposed");
      return page;
    } catch (err) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await this.closePage();
      try {
        rmSync(userDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      throw err;
    }
  }

  /**
   * Full connection dance: page builds a recvonly offer (libwebrtc), the
   * extension exchanges it over the device's HTTP or signaling WebSocket,
   * then the page sets the answer and waits for the first decoded frame.
   */
  private async connectBridge(page: Page): Promise<void> {
    const offerB64 = (await page.evaluate("window.__jetkvm.createOffer()")) as string;
    let signaling: { close: () => void } | null = null;
    try {
      const resp = await this.auth.authedFetch("/webrtc/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sd: offerB64 }),
      });
      let answerB64: string;
      if (resp.status === 404) {
        const exchange = await this.auth.websocketSignaling(
          offerB64,
          (candidate) => page.evaluate((c: unknown) => window.__jetkvm.addCandidate(c), candidate),
        );
        signaling = exchange;
        answerB64 = exchange.answer;
      } else {
        if (!resp.ok) {
          throw new JetKvmError("SignalingFailed", `bridge signaling POST failed: HTTP ${resp.status}`);
        }
        const body = (await resp.json()) as { sd: string };
        answerB64 = body.sd;
      }
      await page.evaluate((b64: string) => window.__jetkvm.setAnswer(b64), answerB64);
      await page.evaluate((ms: number) => window.__jetkvm.waitFrame(ms), 15_000);
    } finally {
      signaling?.close();
    }
  }

  private async ensureConnected(): Promise<Page> {
    const page = await this.ensurePage();
    if (!this.connecting) {
      const pending = (async () => {
        if (page.isClosed()) throw new JetKvmError("ChromiumPageClosed", "Chromium page closed");
        await page.reload({ waitUntil: "domcontentloaded" });
        await this.connectBridge(page);
      })().catch(async (err) => {
        await this.closePage();
        throw err;
      });
      this.connecting = pending;
      pending.then(
        () => { if (this.connecting === pending) this.connecting = null; },
        () => { if (this.connecting === pending) this.connecting = null; },
      );
    }
    await this.connecting;
    return page;
  }

  private async capturePage(page: Page, opts: CaptureOptions): Promise<BridgeResult> {
    const result = (await abortable(
      page.evaluate(
        (o: { format: string; quality: number; maxModelWidth: number }) =>
          window.__jetkvm.capture(o),
        { format: opts.format, quality: opts.quality, maxModelWidth: opts.maxModelWidth },
      ),
      opts.signal,
      "screenshot capture aborted",
    )) as BridgeResult;
    // The bridge tracks frame age at the instant pixels are copied. The
    // preflight state check alone has a race with a stalled stream, so reject
    // stale pixels here as well and let capture's reconnect path rebuild it.
    if (result.ageMs !== undefined && result.ageMs > 5_000) {
      throw new JetKvmError("StaleCapture", `decoded video frame is ${result.ageMs}ms old`);
    }
    return result;
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    if (this.disposed || opts.signal?.aborted) throw new JetKvmError("Aborted", "screenshot capture aborted");
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.activeCaptures++;
    try {
      // Cleanup owns the old resources until it finishes. In particular, its
      // browser/profile teardown must not reach a newly launched page.
      if (this.idleCleanup) await abortable(this.idleCleanup, opts.signal, "screenshot capture aborted");
      if (this.disposed || opts.signal?.aborted) throw new JetKvmError("Aborted", "screenshot capture aborted");
      let r: BridgeResult;
      try {
        const page = await abortable(this.ensureConnected(), opts.signal, "screenshot capture aborted");
        r = await this.capturePage(page, opts);
      } catch (err) {
        if (this.disposed) throw new JetKvmError("Aborted", "screenshot capture aborted");
        if (err instanceof JetKvmError && err.code === "Aborted") throw err;
        await this.closePage();
        const fresh = await abortable(this.ensureConnected(), opts.signal, "screenshot capture aborted");
        r = await this.capturePage(fresh, opts);
      }
      if (this.disposed) throw new JetKvmError("Aborted", "screenshot capture aborted");
      return {
        modelData: r.modelB64,
        modelMime: opts.format === "png" ? "image/png" : "image/jpeg",
        fullData: r.fullB64,
        fullMime: opts.format === "png" ? "image/png" : "image/jpeg",
        width: r.width,
        height: r.height,
      };
    } finally {
      this.activeCaptures--;
      if (!this.disposed && this.activeCaptures === 0) this.armIdleKill();
    }
  }


  private async closePage(): Promise<void> {
    const page = this.page;
    const browser = this.browser;
    const child = this.chromiumProc;
    const dir = this.chromiumDir;
    this.page = null;
    this.browser = null;
    this.chromiumProc = null;
    this.chromiumDir = null;
    if (page) {
      try {
        await page.close();
      } catch {
        // already closed
      }
    }
    if (browser) {
      try {
        // We spawned this browser ourselves: close() both disconnects the
        // ws and shuts the browser down.
        await browser.close();
      } catch {
        // already closed
      }
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const { promise: exited, resolve, reject } = Promise.withResolvers<void>();
      const onExit = (): void => resolve();
      const onError = (err: Error): void => reject(err);
      child.once("exit", onExit);
      child.once("error", onError);
      let timer: Timer | undefined;
      const sendSignal = (signal: NodeJS.Signals): boolean => {
        try {
          const sent = child.kill(signal);
          // ESRCH returns false without an exit event; an emitted error or
          // thrown signal failure rejects instead of stranding the waiter.
          if (!sent) resolve();
          return sent;
        } catch (err) {
          reject(err);
          return false;
        }
      };
      try {
        if (sendSignal("SIGTERM")) {
          timer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else sendSignal("SIGKILL");
          }, 2_000);
          timer.unref?.();
        }
        // Keep cleanup pending until Chromium exits or signaling settles.
        await exited;
      } finally {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
      }
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; tmpfs cleans up eventually
      }
    }
  }

  private async releaseResources(): Promise<void> {
    await this.closePage();
    if (this.bridgeServer) {
      this.bridgeServer.stop(true);
      this.bridgeServer = null;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleCleanup) await this.idleCleanup.catch(() => {});
    const launching = this.pagePromise;
    const connecting = this.connecting;
    if (launching) await launching.catch(() => {});
    if (connecting) await connecting.catch(() => {});
    await this.releaseResources();
  }
}
