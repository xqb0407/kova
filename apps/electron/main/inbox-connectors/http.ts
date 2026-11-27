/**
 * 连接器专用 HTTP 通道。
 *
 * 不用全局 fetch：Node/undici 不读系统代理，而设置页的代理配置必须对
 * Jira/GitHub 这类海外接口生效。这里用 Electron net.request + 独立 session，
 * 按 pi.networkProxy 应用 system/direct/custom 代理。
 *
 * 安全约束：
 * - 只跟随同源 3xx：GitHub 会把改名仓库重定向到 /repositories/<id>/...，
 *   同域必须放行；跨域重定向一律阻断，Token 不会被带到第三方；
 * - 响应上限 4MB，错误页/异常网关不会把主进程内存打爆；
 * - header 名统一小写，provider 只依赖小写键。
 */
import { net, session } from "electron";
import { normalizeNetworkProxyUrl } from "pi-protocol";
import { ConnectorError } from "./errors";
import { mergeNoProxy } from "../system-proxy";
import { readNetworkProxyConfig } from "../network-proxy-config";
import type { HttpJson, HttpJsonRequest, HttpJsonResponse } from "./types";

const PARTITION = "inbox-connectors";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

let connSession: Electron.Session | null = null;
let proxySignature = "";

function connectorSession(): Electron.Session {
  if (!connSession) connSession = session.fromPartition(PARTITION);
  return connSession;
}

/** 把设置页的代理配置应用到独立 session；配置签名没变就跳过。 */
async function applyProxy(): Promise<void> {
  const config = readNetworkProxyConfig();
  const signature = `${config.mode}|${config.url}|${config.noProxy}`;
  if (signature === proxySignature) return;
  const ses = connectorSession();
  if (config.mode === "direct") {
    await ses.setProxy({ mode: "direct" });
  } else if (config.mode === "custom") {
    const proxy = normalizeNetworkProxyUrl(config.url);
    if (!proxy) {
      // 设置页写入前已校验；这里兜底不让坏值把连接器静默打成直连
      throw new ConnectorError(
        "config",
        "网络代理地址不合法，请到「设置 → 网络代理」检查",
      );
    }
    await ses.setProxy({
      mode: "fixed_servers",
      proxyRules: proxy,
      proxyBypassRules: mergeNoProxy(undefined, config.noProxy),
    });
  } else {
    await ses.setProxy({ mode: "system" });
  }
  proxySignature = signature;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export const electronHttp: HttpJson = async (
  req: HttpJsonRequest,
): Promise<HttpJsonResponse> => {
  await applyProxy();
  const ses = connectorSession();
  const timeoutMs = Math.min(
    60_000,
    Math.max(1_000, Math.trunc(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const method = req.method ?? "GET";
  const maxBytes = Math.min(
    MAX_BODY_BYTES_LIMIT,
    Math.max(1024 * 1024, Math.trunc(req.maxBytes ?? MAX_BODY_BYTES)),
  );
  let originalUrl: URL;
  try {
    originalUrl = new URL(req.url);
  } catch {
    throw new ConnectorError("config", "连接的接口地址不合法");
  }
  let redirectCount = 0;

  return new Promise<HttpJsonResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (
      error: Error | null,
      value?: HttpJsonResponse,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      if (error) reject(error);
      else resolve(value!);
    };

    let request: Electron.ClientRequest;
    try {
      request = net.request({
        method,
        url: req.url,
        session: ses,
        redirect: "manual",
        headers: {
          "User-Agent": "Kova-Inbox",
          ...(req.headers ?? {}),
        },
      });
    } catch (error) {
      reject(
        new ConnectorError(
          "network",
          `网络请求创建失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    timer = setTimeout(() => {
      finish(
        new ConnectorError(
          "network",
          `请求超时（${Math.round(timeoutMs / 1000)}s），请检查网络代理设置`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    request.on("error", (error: Error) => {
      finish(
        new ConnectorError(
          "network",
          `网络连接失败（${error.message}），请检查网络代理设置`,
        ),
      );
    });

    /**
     * 同源重定向才跟随：GitHub 改名仓库会 301 到 /repositories/<id>/...，
     * 仍在 api.github.com 上；跨域/降级（https→http）/超过 5 跳一律阻断，
     * 避免 Authorization 被带到第三方。
     */
    request.on("redirect", (_status, _method, redirectUrl) => {
      let next: URL;
      try {
        next = new URL(redirectUrl);
      } catch {
        finish(new ConnectorError("network", "接口返回了非法重定向地址"));
        return;
      }
      const sameHost = next.host === originalUrl.host;
      const downgrade =
        originalUrl.protocol === "https:" && next.protocol === "http:";
      const supported =
        next.protocol === "http:" || next.protocol === "https:";
      if (sameHost && supported && !downgrade && redirectCount < MAX_REDIRECTS) {
        redirectCount += 1;
        request.followRedirect();
        return;
      }
      finish(
        new ConnectorError(
          "network",
          sameHost
            ? "接口重定向次数过多，已中止"
            : `接口重定向到其他域名（${next.host}），为避免 Token 泄露已阻止`,
        ),
      );
    });

    request.on("response", (response) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key.toLowerCase()] = headerValue(value);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          finish(
            new ConnectorError(
              "http",
              `接口响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已中止`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish(null, {
          status: response.statusCode ?? 0,
          headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", (error: Error) => {
        finish(
          new ConnectorError(
            "network",
            `读取响应失败（${error.message}），请检查网络代理设置`,
          ),
        );
      });
    });

    try {
      if (req.body !== undefined && method !== "GET") {
        request.write(req.body);
      }
      request.end();
    } catch (error) {
      finish(
        new ConnectorError(
          "network",
          `发送请求失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
};
