import { describe, expect, test } from "bun:test";
import {
  CHAR_USAGE,
  foreignInputCheck,
  hidKeysPayload,
  KEY_USAGE,
  MODIFIER_BITS,
  parseChord,
  prepareText,
  typeText,
  type InputTransaction,
} from "../src/input.ts";
import { JetKvmError, pixelToHid, routeSourceAddress, sdpCodec } from "../src/util.ts";

describe("USB HID keymap (HID Usage Tables)", () => {
  test("a-z and 0-9 usage IDs", () => {
    expect(KEY_USAGE["a"]).toBe(0x04);
    expect(KEY_USAGE["z"]).toBe(0x1d);
    expect(KEY_USAGE["1"]).toBe(0x1e);
    expect(KEY_USAGE["9"]).toBe(0x26);
    expect(KEY_USAGE["0"]).toBe(0x27);
  });

  test("control keys", () => {
    expect(KEY_USAGE["enter"]).toBe(0x28);
    expect(KEY_USAGE["esc"]).toBe(0x29);
    expect(KEY_USAGE["backspace"]).toBe(0x2a);
    expect(KEY_USAGE["tab"]).toBe(0x2b);
    expect(KEY_USAGE["space"]).toBe(0x2c);
    expect(KEY_USAGE["f1"]).toBe(0x3a);
    expect(KEY_USAGE["f12"]).toBe(0x45);
    expect(KEY_USAGE["up"]).toBe(0x52);
    expect(KEY_USAGE["printscreen"]).toBe(0x46);
  });

  test("modifier bitmask per DESIGN §2.4", () => {
    expect(MODIFIER_BITS.leftCtrl).toBe(1);
    expect(MODIFIER_BITS.leftShift).toBe(2);
    expect(MODIFIER_BITS.leftAlt).toBe(4);
    expect(MODIFIER_BITS.leftGui).toBe(8);
    expect(MODIFIER_BITS.rightCtrl).toBe(0x10);
    expect(MODIFIER_BITS.rightShift).toBe(0x20);
    expect(MODIFIER_BITS.rightAlt).toBe(0x40);
    expect(MODIFIER_BITS.rightGui).toBe(0x80);
  });

  test("US char mapping incl. shifted symbols", () => {
    expect(CHAR_USAGE["a"]).toEqual({ usage: 0x04, shift: false });
    expect(CHAR_USAGE["A"]).toEqual({ usage: 0x04, shift: true });
    expect(CHAR_USAGE["!"]).toEqual({ usage: 0x1e, shift: true });
    expect(CHAR_USAGE["~"]).toEqual({ usage: 0x35, shift: true });
    expect(CHAR_USAGE["|"]).toEqual({ usage: 0x31, shift: true });
    expect(CHAR_USAGE["{"]).toEqual({ usage: 0x2f, shift: true });
    expect(CHAR_USAGE["\n"]!.usage).toBe(0x28);
    // \r is not mapped: prepareText collapses it so CRLF types one enter.
    expect(CHAR_USAGE["\r"]).toBeUndefined();
    expect(CHAR_USAGE["\t"]!.usage).toBe(0x2b);
    expect(CHAR_USAGE[" "]!.usage).toBe(0x2c);
    expect(CHAR_USAGE["é"]).toBeUndefined();
  });
});

describe("parseChord", () => {
  test("ctrl+alt+t", () => {
    const c = parseChord("ctrl+alt+t");
    expect(c.modifierMask).toBe(1 | 4);
    expect(c.usages).toEqual([0x17]);
  });

  test("win+r and aliases", () => {
    expect(parseChord("win+r").modifierMask).toBe(8);
    expect(parseChord("meta+r").modifierMask).toBe(8);
    expect(parseChord("cmd+r").modifierMask).toBe(8);
  });

  test("altgr is right-alt", () => {
    expect(parseChord("altgr+2").modifierMask).toBe(0x40);
  });

  test("bare modifier tap (right-ctrl)", () => {
    const c = parseChord("right-ctrl");
    expect(c.modifierMask).toBe(0x10);
    expect(c.usages).toEqual([]);
  });

  test("shift+a adds shift automatically", () => {
    const c = parseChord("shift+a");
    expect(c.modifierMask).toBe(2);
    expect(c.usages).toEqual([0x04]);
  });

  test("unknown key throws with token named", () => {
    expect(() => parseChord("ctrl+wat")).toThrow(JetKvmError);
    try {
      parseChord("ctrl+wat");
      throw new Error("unreachable");
    } catch (e) {
      expect((e as JetKvmError).message).toContain('"wat"');
    }
  });

  test("empty chord throws", () => {
    expect(() => parseChord("")).toThrow(JetKvmError);
  });
});

describe("hidKeysPayload", () => {
  test("zero-pads to 6 slots", () => {
    expect(hidKeysPayload([0x04])).toEqual([0x04, 0, 0, 0, 0, 0]);
  });
  test("more than 6 keys throws instead of silently dropping", () => {
    expect(() => hidKeysPayload([1, 2, 3, 4, 5, 6, 7])).toThrow(JetKvmError);
    expect(() => hidKeysPayload([1, 2, 3, 4, 5, 6, 7])).toThrow(/at most 6/);
  });
});

describe("pixelToHid (DESIGN §3.3)", () => {
  test("edges map to 0 and 32767", () => {
    expect(pixelToHid(0, 1920)).toBe(0);
    expect(pixelToHid(1919, 1920)).toBe(32767);
    expect(pixelToHid(1079, 1080)).toBe(32767);
  });
  test("clamps out-of-range input", () => {
    expect(pixelToHid(-50, 1920)).toBe(0);
    expect(pixelToHid(99999, 1920)).toBe(32767);
  });
  test("center maps near half", () => {
    const mid = pixelToHid(960, 1921);
    expect(mid).toBeGreaterThan(16360);
    expect(mid).toBeLessThan(16410);
  });
  test("resolution change shrinks extent", () => {
    expect(pixelToHid(319, 320)).toBe(32767);
    expect(pixelToHid(639, 640)).toBe(32767);
  });
});

describe("sdpCodec", () => {
  test("round trip", () => {
    const desc = { type: "offer", sdp: "v=0\r\nm=application 9 ..." };
    const b64 = sdpCodec.encode(desc);
    expect(sdpCodec.decode(b64)).toEqual(desc);
  });
  test("rejects garbage", () => {
    expect(() => sdpCodec.decode(Buffer.from("[]").toString("base64"))).toThrow();
  });
});

describe("routeSourceAddress", () => {
  test("loopback route resolves to the loopback address", async () => {
    expect(await routeSourceAddress("127.0.0.1")).toBe("127.0.0.1");
  });
  test("unroutable/unresolvable host yields null, not a guess", async () => {
    expect(await routeSourceAddress("no-such-host.invalid")).toBe(null);
  });
});

describe("prepareText / typeText", () => {
  function recordingTx() {
    const reports: { modifier: number; keys: number[] }[] = [];
    const tx: InputTransaction = {
      async keyboardReport(modifier, usages) {
        reports.push({ modifier, keys: usages });
      },
      async mouseReport() {},
      async wheelReport() {},
      async abortableSleep() {},
    };
    return { tx, reports };
  }

  test("CRLF and lone CR collapse to a single enter", async () => {
    const { tx, reports } = recordingTx();
    const r = await typeText(tx, { text: "a\r\nb\rc", keystrokeDelayMs: 0, settleMs: 0 });
    expect(r.chars).toBe(5); // a enter b enter c — one enter per line break
    const enters = reports.filter((x) => x.keys[0] === 0x28);
    expect(enters.length).toBe(2); // one per line break, not two per CRLF
  });

  test("unmappable chars fail the whole call before any keypress", async () => {
    const { tx, reports } = recordingTx();
    await expect(typeText(tx, { text: "abé", keystrokeDelayMs: 0, settleMs: 0 })).rejects.toThrow(JetKvmError);
    expect(reports.length).toBe(0); // no prefix typed before the failure
  });

  test("prepareText names every unmappable char once", () => {
    expect(() => prepareText("aé bé é")).toThrow(/"é"/);
    expect(prepareText("plain ascii 123")).toBe("plain ascii 123");
  });
});

describe("foreignInputCheck", () => {
  test("warns on keys this session did not press", async () => {
    const warnings: string[] = [];
    const session = {
      call: async () => ({ modifier: 2, keys: [0x04, 0, 0, 0, 0, 0] }),
    };
    await foreignInputCheck(session as unknown as Parameters<typeof foreignInputCheck>[0], warnings);
    expect(warnings[0]).toMatch(/foreign input suspected/);
  });

  test("silent on a clean field and on a missing method", async () => {
    const warnings: string[] = [];
    const clean = { call: async () => ({ modifier: 0, keys: [0, 0, 0, 0, 0, 0] }) };
    await foreignInputCheck(clean as unknown as Parameters<typeof foreignInputCheck>[0], warnings);
    const absent = {
      call: async () => {
        throw new Error("method not found");
      },
    };
    await foreignInputCheck(absent as unknown as Parameters<typeof foreignInputCheck>[0], warnings);
    expect(warnings).toEqual([]);
  });
});
