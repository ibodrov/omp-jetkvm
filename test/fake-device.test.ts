import { describe, expect, test } from "bun:test";
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
});
