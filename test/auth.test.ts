import { describe, expect, test } from "bun:test";
import { AuthState } from "../src/connection.ts";

describe("AuthState", () => {
  test("coalesces concurrent login and token-rotation recovery", async () => {
    let loginCount = 0;
    let activeToken = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/auth/login-local") {
          loginCount++;
          activeToken = `token-${loginCount}`;
          return new Response("ok", {
            headers: { "Set-Cookie": `authToken=${activeToken}; Path=/; HttpOnly` },
          });
        }
        if (url.pathname === "/resource") {
          return request.headers.get("cookie") === `authToken=${activeToken}`
            ? new Response("ok")
            : new Response("unauthorized", { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const auth = new AuthState({
        host: `127.0.0.1:${server.port}`,
        password: "secret",
      });
      const initial = await Promise.all([
        auth.authedFetch("/resource"),
        auth.authedFetch("/resource"),
      ]);
      expect(initial.every((response) => response.ok)).toBe(true);
      expect(loginCount).toBe(1);
      expect(auth.tokenRotatedRecently(0)).toBe(false);

      activeToken = "external-rotation";
      const recoveryStartedAt = Date.now() - 1;
      const recovered = await Promise.all([
        auth.authedFetch("/resource"),
        auth.authedFetch("/resource"),
      ]);
      expect(recovered.every((response) => response.ok)).toBe(true);
      expect(loginCount).toBe(2);
      expect(auth.tokenRotatedRecently(recoveryStartedAt)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
