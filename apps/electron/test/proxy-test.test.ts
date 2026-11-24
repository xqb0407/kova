import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { testProxyConnection } from "../main/proxy-test";

describe("testProxyConnection", () => {
  test("HTTP 代理 CONNECT 200 → ok", async () => {
    const server = createServer();
    server.on("connect", (_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await testProxyConnection(`http://127.0.0.1:${port}`);
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.proxy).toBe(`http://127.0.0.1:${port}`);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("非法代理地址 → 失败且不发请求", async () => {
    const result = await testProxyConnection("http://");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid proxy URL");
    expect(result.proxy).toBeNull();
  });
});
