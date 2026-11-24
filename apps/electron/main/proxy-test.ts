/**
 * 设置页「测试连接」：向代理发一条 HTTP CONNECT 探针。
 *
 * 只验证代理端口/握手可用（目标 host 走 CONNECT 隧道，不真正发业务请求），
 * 不做 DNS/证书校验——避免把目标站点的可达性误报成代理故障。
 */
import http from "node:http";
import https from "node:https";
import {
  normalizeNetworkProxyUrl,
  type NetworkProxyTestResult,
} from "pi-protocol";
import { resolveSystemProxyUrl } from "./system-proxy";

const TEST_HOST = "www.gstatic.com";
const TEST_PORT = 443;
const TIMEOUT_MS = 6_000;

export async function testProxyConnection(
  rawUrl?: string,
): Promise<NetworkProxyTestResult> {
  let proxy: string | null;
  if (rawUrl?.trim()) {
    proxy = normalizeNetworkProxyUrl(rawUrl);
    if (!proxy) {
      return {
        ok: false,
        proxy: null,
        error: "invalid proxy URL",
        latencyMs: 0,
      };
    }
  } else {
    proxy = await resolveSystemProxyUrl();
    if (!proxy) return { ok: true, proxy: null, latencyMs: 0 };
  }

  const url = new URL(proxy);
  const started = Date.now();
  return new Promise<NetworkProxyTestResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: http.ClientRequest | undefined;
    const finish = (result: Omit<NetworkProxyTestResult, "latencyMs" | "proxy">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
      resolve({ ...result, proxy, latencyMs: Date.now() - started });
    };

    try {
      const lib = url.protocol === "https:" ? https : http;
      const port = Number(
        url.port || (url.protocol === "https:" ? 443 : 80),
      );
      req = lib.request({
        host: url.hostname,
        port,
        method: "CONNECT",
        path: `${TEST_HOST}:${TEST_PORT}`,
        headers: { Host: `${TEST_HOST}:${TEST_PORT}` },
        timeout: TIMEOUT_MS,
      });
      timer = setTimeout(
        () => finish({ ok: false, error: "timeout" }),
        TIMEOUT_MS,
      );
      timer.unref?.();
      req.on("connect", (res, socket) => {
        socket.destroy();
        finish({
          ok: res.statusCode === 200,
          statusCode: res.statusCode,
        });
      });
      req.on("timeout", () => finish({ ok: false, error: "timeout" }));
      req.on("error", (err) => finish({ ok: false, error: err.message }));
      req.end();
    } catch (err) {
      finish({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
