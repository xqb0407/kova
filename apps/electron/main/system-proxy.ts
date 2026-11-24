/**
 * 把系统代理透传给 sidecar。
 *
 * sidecar 是独立 Bun 进程，Bun 的 fetch 只认 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY
 * 环境变量，不读 macOS/Windows 的系统代理；因此 Electron 主进程在 spawn 前用
 * Chromium 的 resolveProxy 解析一次，把结果注入子进程 env。
 *
 * 约束：
 * - Bun 只支持 http(s) 代理，SOCKS 结果直接忽略（Clash 的 mixed 端口同时提供
 *   HTTP，通常能拿到 PROXY 条目）；
 * - 用户已显式设置 HTTP(S)_PROXY 时不覆盖；ALL_PROXY 只有 http(s) 形式才视为
 *   显式配置（Bun 会忽略 socks5:// 的 ALL_PROXY，此时仍回落到系统代理）；
 * - KOVA_SIDECAR_PROXY=off 可关闭；KOVA_SIDECAR_PROXY=http://host:port 可强制指定；
 * - localhost/回环地址与 RFC1918 网段始终走 NO_PROXY，避免本地 MCP/LAN 被代理；
 * - 解析有总超时，PAC 脚本不可达时不能让 sidecar 启动被卡住。
 */
import { logInfo, logWarn } from "./logging";

/** 逐个探测：PAC/按域名分流时，至少有一个常见域名会给出系统代理。 */
const PROBE_URLS = [
  "https://opencode.ai",
  "https://www.google.com",
  "https://example.com",
] as const;

const LOCAL_NO_PROXY = [
  "127.0.0.1",
  "localhost",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

const HTTP_PROXY_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

const ALL_PROXY_KEYS = ["ALL_PROXY", "all_proxy"] as const;

/** resolveProxy 的总预算：超过就按直连启动，不能让 UI 等 PAC 超时。 */
const RESOLVE_DEADLINE_MS = 2_500;

/** Chromium resolveProxy 结果 → Bun 可用的 http 代理 URL；SOCKS/DIRECT 返回 undefined。 */
export function proxyUrlFromResolution(result: string | undefined): string | undefined {
  if (!result) return undefined;
  for (const entry of result.split(";")) {
    // IPv6 主机形如 [::1]:7897
    const match = /^\s*(PROXY|HTTPS)\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s*$/i.exec(entry);
    if (match) return `http://${match[2]}:${match[3]}`;
  }
  return undefined;
}

/** 合并已有 NO_PROXY 与回环/RFC1918 地址，去重后逗号分隔。 */
export function mergeNoProxy(existing: string | undefined): string {
  const values = new Set<string>();
  for (const raw of [...(existing ?? "").split(/[,\s]+/), ...LOCAL_NO_PROXY]) {
    const value = raw.trim();
    if (value) values.add(value);
  }
  return [...values].join(",");
}

/** 日志脱敏：代理 URL 可能带 user:pass@。 */
export function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "***";
    url.password = "***";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/[^/@]+@/, "//***@");
  }
}

/** 显式代理值是否为 Bun 能用的 HTTP(S) 形式（socks 等 scheme 视为不可用）。 */
function isHttpProxyValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // 带其它 scheme（socks5:// 等）→ Bun 不认，不能据此跳过系统代理
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  return true; // host:port / host，沿用用户原值
}

/** KOVA_SIDECAR_PROXY：支持 http(s) URL 或 host:port；SOCKS 等不支持的 scheme 返回 undefined。 */
function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined;
  if (/^(?:\[[^\]]+\]|[^/\s:]+):\d+$/.test(trimmed)) return `http://${trimmed}`;
  return undefined;
}

/** 用户是否已显式配置了 Bun 能用的 HTTP(S) 代理。 */
function hasExplicitHttpProxy(env: NodeJS.ProcessEnv): boolean {
  return [...HTTP_PROXY_KEYS, ...ALL_PROXY_KEYS].some((key) =>
    isHttpProxyValue(env[key] ?? ""),
  );
}

/** 给 Promise 套一个超时；超时/拒绝统一返回 undefined（调用方按直连处理）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), Math.max(0, ms));
    timer.unref?.();
    promise.then(
      (value) => finish(value),
      () => finish(undefined),
    );
  });
}

/**
 * 生成注入 sidecar 的代理环境变量：
 * - 显式 HTTP(S) 代理 env / KOVA_SIDECAR_PROXY=off → 不注入；
 * - KOVA_SIDECAR_PROXY 指定 http(s) URL / host:port → 使用它；
 * - 否则使用系统代理解析结果（仅 http）。
 */
export function buildSidecarProxyEnv(
  resolved: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const forced = (env.KOVA_SIDECAR_PROXY ?? "").trim();
  if (forced.toLowerCase() === "off") return {};
  if (hasExplicitHttpProxy(env)) return {};
  const proxy = normalizeProxyUrl(forced) ?? proxyUrlFromResolution(resolved);
  if (!proxy) return {};
  // 大小写两套都可能有值：合并而不是二选一
  const existingNoProxy = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(",");
  const noProxy = mergeNoProxy(existingNoProxy);
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * 通过 Chromium 解析系统代理并生成 sidecar env。Electron 不可用、解析超时或
 * 没有可用 HTTP 代理时返回空对象，绝不阻断 sidecar 启动。
 */
export async function systemProxyEnvForSidecar(): Promise<Record<string, string>> {
  const forcedRaw = (process.env.KOVA_SIDECAR_PROXY ?? "").trim();
  if (forcedRaw.toLowerCase() === "off") return {};
  if (hasExplicitHttpProxy(process.env)) return {};
  if (normalizeProxyUrl(forcedRaw)) return buildSidecarProxyEnv(undefined);
  if (forcedRaw) {
    logWarn(
      `[worker] KOVA_SIDECAR_PROXY ignored (Bun only supports http/https): ${redactProxyUrl(forcedRaw)}`,
    );
  }

  try {
    // 动态 import：本模块可被 bun test 直接加载，不需要 Electron 运行时
    const { session } = await import("electron");
    const deadline = Date.now() + RESOLVE_DEADLINE_MS;
    for (const url of PROBE_URLS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const resolution = await withTimeout(
        session.defaultSession.resolveProxy(url),
        remaining,
      );
      if (resolution === undefined) {
        logWarn(`[worker] system proxy resolve timed out (${url}); sidecar connects directly`);
        break;
      }
      const env = buildSidecarProxyEnv(resolution);
      if (env.HTTPS_PROXY) {
        logInfo(
          `[worker] sidecar proxy: ${redactProxyUrl(env.HTTPS_PROXY)} (resolved via ${url})`,
        );
        return env;
      }
    }
  } catch (err) {
    logWarn(
      `[worker] system proxy resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {};
}
