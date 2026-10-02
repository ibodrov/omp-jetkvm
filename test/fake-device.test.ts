import { describe, expect, test, vi } from "bun:test";
import { acquireCrossProcessClaim, type CrossProcessClaim } from "../src/concurrency.ts";
import { FakeDevice } from "./helpers/fake-device.ts";
import { JsonRpcClient } from "../src/rpc.ts";
import { RTCPeerConnection } from "werift";
import { sdpCodec } from "../src/util.ts";
import { DeviceSession } from "../src/connection.ts";
import { JETKVM_CONFIG_DEFAULTS } from "../src/config.ts";

/**
 * Integration: a real werift client session against the fake device
 * (werift<->werift over real ICE on loopback). Genuinely time-bound — the
 * DTLS/ICE handshake needs the platform clock, so small real waits are
 * deliberate (ts-no-test-timers exception).
 */
describe("fake device harness", () => {
  test("datachannel + rpc round trip + input recording + events", async () => {
    const device = new FakeDevice({ state: { videoWidth: 1280, videoHeight: 720 } });

    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel("rpc");
    const opened = new Promise<void>((resolve) => {
      dc.onopen = () => resolve();
    });
    const rpc = new JsonRpcClient((t) => dc.send(t), 5_000);
    dc.onMessage.subscribe((data) => rpc.handleMessage(data));
    const events: { method: string; params: unknown }[] = [];
    rpc.onEvent((e) => events.push(e));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const t0 = Date.now();
    while (pc.iceGatheringState !== "complete" && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const answerB64 = await device.handleSignaling(
      sdpCodec.encode(pc.localDescription as { type: string; sdp: string }),
    );
    await pc.setRemoteDescription(sdpCodec.decode(answerB64) as { type: "answer"; sdp: string });
    await opened;

    expect(await rpc.call("ping")).toBe("pong");
    expect(await rpc.call("getVideoState")).toEqual({ ready: true, streaming: 0, width: 1280, height: 720, fps: 60 });
    expect(await rpc.call("getATXState")).toEqual({ power: false, hdd: false });
    expect(await rpc.call("getVirtualMediaState")).toBeNull();

    await rpc.call("keyboardReport", { modifier: 2, keys: [0x04, 0, 0, 0, 0, 0] });
    await rpc.call("absMouseReport", { x: 100, y: 200, buttons: 1 });
    const inputs = device.inputs.map((i) => i.method);
    expect(inputs).toContain("keyboardReport");
    expect(inputs).toContain("absMouseReport");
    const mouse = device.inputs.find((i) => i.method === "absMouseReport");
    expect(mouse?.params).toEqual({ x: 100, y: 200, buttons: 1 });

    device.pushEvent("videoInputState", { ready: true, width: 640, height: 480 });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toContainEqual({ method: "videoInputState", params: { ready: true, width: 640, height: 480 } });

    await expect(rpc.call("nosuchmethod")).resolves.toBeUndefined();
    await device.close();
    try {
      pc.close();
    } catch {
      // already closed
    }
  }, 20_000);

  test("WebSocket-only firmware recovers video state and reconnects after token rotation", async () => {
    const state = { videoWidth: 1280, videoHeight: 720 };
    const device = new FakeDevice({ state });
    let token = "";
    let logins = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/auth/login-local") {
          token = `token-${++logins}`;
          return new Response("ok", { headers: { "Set-Cookie": `authToken=${token}; Path=/` } });
        }
        // Removed routes don't run auth middleware on firmware 0.5.9.
        if (path === "/webrtc/session") return new Response("not found", { status: 404 });
        if (request.headers.get("cookie") !== `authToken=${token}`) {
          return new Response("unauthorized", { status: 401 });
        }
        if (path === "/device") return Response.json({ authMode: "password" });
        if (path === "/webrtc/signaling/client" && server.upgrade(request)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "device-metadata", data: { deviceVersion: "0.5.9" } }));
        },
        async message(ws, message) {
          const frame = JSON.parse(String(message)) as { type?: string; data?: { sd?: string } };
          if (frame.type !== "offer" || typeof frame.data?.sd !== "string") {
            ws.close(1008, "expected offer");
            return;
          }
          const answer = await device.handleSignaling(frame.data.sd);
          ws.send(JSON.stringify({ type: "answer", data: answer }));
        },
      },
    });
    const session = new DeviceSession("ws-test", {
      host: `127.0.0.1:${server.port}`,
      password: "test-password",
    }, structuredClone(JETKVM_CONFIG_DEFAULTS));
    try {
      expect(await session.call("ping")).toBe("pong");
      expect(await session.videoDims()).toEqual({ width: 1280, height: 720 });
      device.pushEvent("videoInputState", { ready: false, width: 0, height: 0, fps: 0, error: "no_signal" });
      await session.call("ping"); // Ordered channel barrier: consume the preceding state event.
      expect(session.videoState.error).toBe("no_signal");
      device.pushEvent("videoInputState", { ready: true, width: 800, height: 600, fps: 60 });
      await session.call("ping");
      expect(session.videoState.error).toBeUndefined();
      expect(await session.videoDims()).toEqual({ width: 800, height: 600 });
      await session.dispose();
      await device.close();
      token = "rotated-by-another-client";
      state.videoWidth = 1920;
      state.videoHeight = 1080;
      expect(await session.videoDims()).toEqual({ width: 1920, height: 1080 });
      expect(logins).toBe(2);
    } finally {
      await session.dispose();
      await device.close();
      server.stop(true);
    }
  }, 20_000);

  test("dispose aborts gated login and signaling before their HTTP responses", async () => {
    for (const blockedPath of ["/auth/login-local", "/webrtc/session"]) {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reachedGate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === blockedPath) {
            started();
            await gate;
            if (path === "/auth/login-local") {
              return new Response("ok", { headers: { "Set-Cookie": "authToken=gate; Path=/" } });
            }
            return Response.json({ sd: "unused" });
          }
          if (path === "/auth/login-local") {
            return new Response("ok", { headers: { "Set-Cookie": "authToken=gate; Path=/" } });
          }
          return new Response("not found", { status: 404 });
        },
      });
      const session = new DeviceSession("cancel-gate", {
        host: `127.0.0.1:${server.port}`,
        password: "test-password",
      }, structuredClone(JETKVM_CONFIG_DEFAULTS));
      const pending = session.ensureConnected().catch(() => null);
      try {
        await reachedGate;
        await session.dispose();
        expect(session.rpcClient).toBeNull();
        release();
        await pending;
      } finally {
        release();
        await session.dispose();
        server.stop(true);
      }
    }
  }, 20_000);

  test("healthy keepalive traffic does not refresh caller idle activity", async () => {
    vi.useFakeTimers();
    const config = structuredClone(JETKVM_CONFIG_DEFAULTS);
    config.session.keepaliveMs = 10;
    config.session.idleTimeoutMs = 30;
    const session = new DeviceSession("idle-test", { host: "idle-test.local" }, config);
    const keepaliveControl = session as unknown as { startKeepalive(): void };
    try {
      session.ensureClaim();
      session.state = "connected";
      session.lastActivity = Date.now();
      keepaliveControl.startKeepalive();
      vi.advanceTimersByTime(40);
      expect(String(session.state)).toBe("idle");
      expect(session.claimInfo).toBeNull();
    } finally {
      await session.dispose();
      vi.useRealTimers();
    }
  });

  test("a retried read cannot leave a mutation without a fresh claim", async () => {
    const device = new FakeDevice();
    let token = "";
    let loginCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/auth/login-local") {
          token = `token-${++loginCount}`;
          return new Response("ok", { headers: { "Set-Cookie": `authToken=${token}; Path=/` } });
        }
        if (request.headers.get("cookie") !== `authToken=${token}`) {
          return new Response("unauthorized", { status: 401 });
        }
        if (path === "/webrtc/session") {
          const payload: unknown = await request.json();
          if (typeof payload !== "object" || payload === null || !("sd" in payload) || typeof payload.sd !== "string") {
            return new Response("bad offer", { status: 400 });
          }
          return Response.json({ sd: await device.handleSignaling(payload.sd) });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const host = `127.0.0.1:${server.port}`;
    const config = structuredClone(JETKVM_CONFIG_DEFAULTS);
    config.session.rpcTimeoutMs = 50;
    const session = new DeviceSession("retry-claim", { host }, config);
    let competitor: CrossProcessClaim | null = null;
    try {
      expect(await session.call("ping")).toBe("pong");
      device.dropNextResponse("getVideoState");
      expect(await session.call("getVideoState", {}, { retryOnReconnect: true })).toMatchObject({
        width: 1920,
        height: 1080,
      });
      competitor = acquireCrossProcessClaim(`http://${host}`, { enabled: true });
      await expect(session.call("keyboardReport", { modifier: 0, keys: [] })).rejects.toMatchObject({
        code: "DeviceBusy",
      });
      expect(device.inputs.some((input) => input.method === "keyboardReport")).toBe(false);
    } finally {
      competitor?.release();
      await session.dispose();
      await device.close();
      server.stop(true);
    }
  }, 20_000);
});
