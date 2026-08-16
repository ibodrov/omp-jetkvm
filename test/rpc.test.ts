import { describe, expect, test } from "bun:test";
import { JsonRpcClient } from "../src/rpc.ts";
import { JetKvmError } from "../src/util.ts";

function harness() {
  const sent: string[] = [];
  const client = new JsonRpcClient((t) => sent.push(t), 100);
  return { client, sent };
}

describe("JsonRpcClient framing", () => {
  test("request carries jsonrpc 2.0, method, params, id", async () => {
    const { client, sent } = harness();
    const p = client.call("ping");
    client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pong" }));
    expect(await p).toBe("pong");
    expect(JSON.parse(sent[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  });

  test("ids are monotonically increasing", () => {
    const { client, sent } = harness();
    const ps = [client.call("a"), client.call("b"), client.call("c")];
    for (const [i, p] of ps.entries()) {
      client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: i + 1, result: null }));
      void p.catch(() => {});
    }
    const ids = sent.map((s) => (JSON.parse(s) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("device error object rejects with RpcError and deviceCode", async () => {
    const { client } = harness();
    const p = client.call("getVideoState");
    client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } }));
    await expect(p).rejects.toThrow();
    try {
      await p;
    } catch (e) {
      const err = e as JetKvmError;
      expect(err.code).toBe("RpcError");
      expect((err.details as { deviceCode: number }).deviceCode).toBe(-32601);
    }
  });

  test("timeout rejects with RpcTimeout", async () => {
    const { client } = harness();
    await expect(client.call("ping", {}, { timeoutMs: 20 })).rejects.toThrow(/no device response/);
  });

  test("unsolicited method-only frames go to event handlers, never resolve pending", async () => {
    const { client } = harness();
    const events: { method: string; params: unknown }[] = [];
    client.onEvent((e) => events.push(e));
    const p = client.call("getVideoState");
    client.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "videoInputState", params: { ready: true, width: 640, height: 480 } }),
    );
    client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { width: 640, height: 480 } }));
    expect(await p).toEqual({ width: 640, height: 480 });
    expect(events).toEqual([{ method: "videoInputState", params: { ready: true, width: 640, height: 480 } }]);
  });

  test("close rejects pending with ConnectionLost and blocks new calls", async () => {
    const { client } = harness();
    const p = client.call("ping", {}, { timeoutMs: 1_000 });
    client.close("test teardown");
    await expect(p).rejects.toThrow(/test teardown/);
    await expect(client.call("ping")).rejects.toThrow(/channel closed/);
  });

  test("send failure rejects the call", async () => {
    const client = new JsonRpcClient(() => {
      throw new Error("dc closed");
    }, 100);
    await expect(client.call("ping")).rejects.toThrow(/send failed/);
  });

  test("abort signal cancels the pending call", async () => {
    const { client } = harness();
    const ac = new AbortController();
    const p = client.call("ping", {}, { timeoutMs: 5_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/caller aborted/);
  });
});
