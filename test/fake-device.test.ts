import { describe, expect, test } from "bun:test";
import { FakeDevice } from "./helpers/fake-device.ts";
import { JsonRpcClient } from "../src/rpc.ts";
import { RTCPeerConnection } from "werift";
import { sdpCodec } from "../src/util.ts";

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
});
