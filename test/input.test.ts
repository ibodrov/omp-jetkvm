import { describe, expect, test } from "bun:test";
import { CHAR_USAGE, hidKeysPayload, KEY_USAGE, MODIFIER_BITS, parseChord } from "../src/input.ts";
import { JetKvmError, pixelToHid, sdpCodec } from "../src/util.ts";

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
  test("caps at 6 keys", () => {
    expect(hidKeysPayload([1, 2, 3, 4, 5, 6, 7])).toHaveLength(6);
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
