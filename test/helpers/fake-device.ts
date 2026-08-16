/**
 * Fake JetKVM device: a werift server-side peer implementing the `rpc`
 * channel contract (DESIGN §2.3/§2.4) plus the HTTP surface needed by the
 * AuthState + signaling flow. Doubles as the firmware-drift canary target.
 */
import { RTCPeerConnection, type RTCDataChannel } from "werift";

export interface FakeDeviceOptions {
  state?: {
    videoWidth?: number;
    videoHeight?: number;
    atxPower?: boolean;
    /** Keys another client holds (foreign-input check scenarios). */
    heldKeys?: number[];
    heldModifier?: number;
  };
}

interface RecordedInput {
  method: string;
  params: Record<string, unknown>;
}

export class FakeDevice {
  readonly inputs: RecordedInput[] = [];
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;

  constructor(private readonly opts: FakeDeviceOptions = {}) {}

  /**
   * Accept an encoded offer (the same `sd` payload the extension POSTs),
   * return the encoded answer. Mirrors POST /webrtc/session.
   */
  async handleSignaling(sdB64: string): Promise<string> {
    const offer = JSON.parse(Buffer.from(sdB64, "base64").toString("utf8")) as { type: string; sdp: string };
    if (offer.type !== "offer") throw new Error("fake device: expected offer");
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onDataChannel.subscribe((dc) => this.wireChannel(dc));
    await pc.setRemoteDescription(offer as { type: "offer"; sdp: string });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.pc = pc;
    return Buffer.from(JSON.stringify({ type: "answer", sdp: answer.sdp }), "utf8").toString("base64");
  }

  private wireChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onMessage.subscribe((data) => this.handleFrame(String(data)));
  }

  private handleFrame(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const method = msg["method"];
    const id = msg["id"];
    if (typeof method !== "string") return;
    this.inputs.push({ method, params: (msg["params"] ?? {}) as Record<string, unknown> });
    const result = this.dispatch(method);
    if (typeof id === "number") {
      this.dc?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }
  }

  private dispatch(method: string): unknown {
    switch (method) {
      case "ping":
        return "pong";
      case "getVideoState":
        return {
          ready: true,
          streaming: 0,
          width: this.opts.state?.videoWidth ?? 1920,
          height: this.opts.state?.videoHeight ?? 1080,
          fps: 60,
        };
      case "getATXState":
        return { power: this.opts.state?.atxPower ?? false, hdd: false };
      case "getStorageSpace":
        return { bytesUsed: 1000, bytesFree: 13_000_000_000 };
      case "listStorageFiles":
        return { files: [] };
      case "getVirtualMediaState":
        return null;
      case "getKeyboardLayout":
        return "en-US";
      case "getKeyDownState":
        // Object form, like the firmware: {modifier, keys} (zero-padded 6).
        return { modifier: this.opts.state?.heldModifier ?? 0, keys: this.opts.state?.heldKeys ?? [0, 0, 0, 0, 0, 0] };
      case "unmountImage":
      case "deleteStorageFile":
        return undefined;
      case "nosuchmethod":
        return undefined;
      default:
        // Input reports and everything else: accepted silently.
        return undefined;
    }
  }

  /** Push an unsolicited event (videoInputState etc.). */
  pushEvent(method: string, params: Record<string, unknown>): void {
    this.dc?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async close(): Promise<void> {
    try {
      this.dc?.close();
    } catch {
      // already closed
    }
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
  }
}
