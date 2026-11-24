/**
 * 把系统代理 / 用户代理设置透传给 sidecar。
 *
 * sidecar 是独立 Bun 进程，Bun 的 fetch 只认 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY
 * 环境变量，不读 macOS/Windows 的系统代理；因此 Electron 主进程在 spawn 前解析
 * 一次，把结果注入子进程 env。
 *
 * 配置优先级：
 *   KOVA_SIDECAR_PROXY（调试/运维） > 设置页 pi.networkProxy > 显式 HTTP(S)_PROXY
 *   > 系统代理
 *
 * 约束：
 * - Bun 只支持 http(s) 代理，SOCKS 结果直接忽略（Clash 的 mixed 端口同时提供
 *   HTTP，通常能拿到 PROXY 条目）；
 * - ALL_PROXY / HTTP(S)_PROXY 只有 http(s) 形式才视为显式配置（Bun 会忽略
 *   socks5:// 的 ALL_PROXY，此时仍回落到系统代理）；
 * - direct 模式会清掉从父进程继承的代理 env，否则“直连”会被环境变量架空；
 * - localhost/回环地址与 RFC1918 网段始终走 NO_PROXY，避免本地 MCP/LAN 被代理；
 * - 解析有总超时，PAC 脚本不可达时不能让 sidecar 启动被卡住。
 */
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  normalizeNetworkProxyUrl,
  type NetworkProxyConfig,
} from "pi-protocol";
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

/** 合并已有 NO_PROXY、设置页额外列表与回环/RFC1918 地址，去重后逗号分隔。 */
export function mergeNoProxy(
  existing: string | undefined,
  extra?: string,
): string {
  const values = new Set<string>();
  for (const raw of [
    ...(existing ?? "").split(/[,\s]+/),
    ...(extra ?? "").split(/[,\s]+/),
    ...LOCAL_NO_PROXY,
  ]) {
    // 用户常直接粘贴完整 URL；NO_PROXY 只认 host[:port]。只对带 scheme 的
    // 条目去 scheme/path——裸 CIDR（10.0.0.0/8）的斜杠不是路径。
    const trimmed = raw.trim();
    const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "")
      : trimmed;
    if (value) values.add(value);
  }
  return [...values].join(",");
}

/** 代理主机是否只在本机/内网可达（换机恢复时这类代理通常不可用）。 */
export function isLocalProxyHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value === "::1" || value.endsWith(".local")) {
    return true;
  }
  if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[01])\./.test(value);
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

/** 合并继承 NO_PROXY 与设置页额外列表，返回大小写两套。 */
function noProxyEnv(
  env: NodeJS.ProcessEnv,
  extra?: string,
): Record<string, string> {
  // 大小写两套都可能有值：合并而不是二选一
  const existingNoProxy = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(",");
  const noProxy = mergeNoProxy(existingNoProxy, extra);
  return { NO_PROXY: noProxy, no_proxy: noProxy };
}

/** 构造某个代理 URL 对应的 sidecar env（合并 NO_PROXY）。 */
function buildProxyEnvForUrl(
  proxy: string,
  env: NodeJS.ProcessEnv,
  extraNoProxy?: string,
): Record<string, string> {
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ...noProxyEnv(env, extraNoProxy),
  };
}

/** 清掉继承的代理 env（direct / KOVA_SIDECAR_PROXY=off 用）。 */
export function clearInheritedProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of [
    ...HTTP_PROXY_KEYS,
    ...ALL_PROXY_KEYS,
    "NO_PROXY",
    "no_proxy",
  ]) {
    delete env[key];
  }
}

/**
 * 生成注入 sidecar 的代理环境变量（兼容旧调用/测试）：
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
  const proxy =
    normalizeNetworkProxyUrl(forced, { allowCredentials: true }) ??
    proxyUrlFromResolution(resolved);
  if (!proxy) return {};
  return buildProxyEnvForUrl(proxy, env);
}

/** 通过 Chromium 解析系统代理；超时/无代理返回 null。 */
export async function resolveSystemProxyUrl(): Promise<string | null> {
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
      const proxy = proxyUrlFromResolution(resolution);
      if (proxy) return proxy;
    }
  } catch (err) {
    logWarn(
      `[worker] system proxy resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

export type SidecarProxyPlan = {
  /** 要合并进 sidecar env 的代理变量 */
  env: Record<string, string>;
  /** direct 模式：需要从继承 env 里删掉代理变量 */
  clearInherited: boolean;
  /** 最终生效的代理（日志/诊断用；null = 直连） */
  effective: string | null;
};

/**
 * 按设置页配置 / 环境变量决定 sidecar 的代理方案。系统模式才触发 resolveProxy；
 * 解析失败按直连处理，绝不阻断启动。
 */
export async function resolveSidecarProxy(
  config: NetworkProxyConfig = DEFAULT_NETWORK_PROXY_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SidecarProxyPlan> {
  const forcedRaw = (env.KOVA_SIDECAR_PROXY ?? "").trim();
  if (forcedRaw.toLowerCase() === "off") {
    logInfo("[worker] sidecar proxy: direct (KOVA_SIDECAR_PROXY=off)");
    return { env: {}, clearInherited: true, effective: null };
  }
  const forcedProxy = normalizeNetworkProxyUrl(forcedRaw, {
    allowCredentials: true,
  });
  if (forcedProxy) {
    logInfo(
      `[worker] sidecar proxy: ${redactProxyUrl(forcedProxy)} (KOVA_SIDECAR_PROXY)`,
    );
    return {
      env: buildProxyEnvForUrl(forcedProxy, env, config.noProxy),
      clearInherited: false,
      effective: forcedProxy,
    };
  }
  if (forcedRaw) {
    logWarn(
      `[worker] KOVA_SIDECAR_PROXY ignored (Bun only supports http/https): ${redactProxyUrl(forcedRaw)}`,
    );
  }

  if (config.mode === "direct") {
    logInfo("[worker] sidecar proxy: direct (settings)");
    return { env: {}, clearInherited: true, effective: null };
  }

  if (config.mode === "custom") {
    const custom = normalizeNetworkProxyUrl(config.url);
    if (custom) {
      logInfo(`[worker] sidecar proxy: ${redactProxyUrl(custom)} (settings)`);
      return {
        env: buildProxyEnvForUrl(custom, env, config.noProxy),
        clearInherited: false,
        effective: custom,
      };
    }
    logWarn("[worker] custom proxy URL is invalid; falling back to system proxy");
  }

  if (hasExplicitHttpProxy(env)) {
    logInfo("[worker] sidecar proxy: inherited HTTP(S)_PROXY env");
    // 继承 env 的代理也要让设置页的绕过列表生效；没有额外列表时保持原样
    const extra = config.noProxy.trim();
    return {
      env: extra ? noProxyEnv(env, extra) : {},
      clearInherited: false,
      effective: null,
    };
  }

  const systemProxy = await resolveSystemProxyUrl();
  if (systemProxy) {
    logInfo(`[worker] sidecar proxy: ${redactProxyUrl(systemProxy)} (system)`);
    return {
      env: buildProxyEnvForUrl(systemProxy, env, config.noProxy),
      clearInherited: false,
      effective: systemProxy,
    };
  }

  logInfo("[worker] sidecar proxy: direct (no system proxy)");
  return { env: {}, clearInherited: false, effective: null };
}
