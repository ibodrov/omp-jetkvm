import { loadJetKvmConfig } from "../src/config.ts";
import { parseRange } from "../src/storage.ts";
import { pickLanIp } from "../src/util.ts";
import Bun from "bun";

console.log("pickLanIp:", pickLanIp());
console.log("parseRange tests:", JSON.stringify([
  parseRange(null, 100),
  parseRange("bytes=0-0", 100),
  parseRange("bytes=10-", 100),
  parseRange("bytes=-5", 100),
  parseRange("bytes=500-600", 100),
]));

const file = Bun.file("/tmp/testmedia.iso");
const size = file.size;
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 0),
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`[req] ${req.method} ${url.pathname} range=${req.headers.get("range")}`);
    if (url.pathname !== "/iso") return new Response("nf", { status: 404 });
    const range = parseRange(req.headers.get("range"), size);
    if (req.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "Content-Length": String(size), "Accept-Ranges": "bytes" } });
    }
    if (range === "invalid") return new Response("bad range", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (range === "full") return new Response(file, { status: 200, headers: { "Content-Length": String(size), "Accept-Ranges": "bytes" } });
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
        "Accept-Ranges": "bytes",
      },
    });
  },
});
console.log(`serving on http://${pickLanIp()}:${server.port}/iso`);
// self-test range
const r = await fetch(`http://127.0.0.1:${server.port}/iso`, { headers: { Range: "bytes=0-99" } });
console.log(`self-test: status=${r.status} content-range=${r.headers.get("content-range")} len=${r.headers.get("content-length")}`);
await r.arrayBuffer();
// keep alive for external check
await new Promise((r) => setTimeout(r, 90_000));
server.stop(true);
