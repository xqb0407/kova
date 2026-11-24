/**
 * 网络代理设置的值域契约（桌面设置页与 Electron 主进程共用）。
 *
 * - system：跟随系统代理（默认）；
 * - direct：不使用代理，并在 spawn sidecar 时清掉继承的代理 env；
 * - custom：使用用户填写的 http(s) 代理。
 *
 * Bun fetch 不支持 SOCKS，因此 custom/系统代理解析结果都只接受 http(s)。
 */
export type NetworkProxyMode = "system" | "direct" | "custom";

export type NetworkProxyConfig = {
  mode: NetworkProxyMode;
  url: string;
  /** 额外绕过代理的域名/IP，多行或逗号分隔；主进程会与内置回环/RFC1918 合并 */
  noProxy: string;
};

export const NETWORK_PROXY_KV_KEY = "pi.networkProxy";

export const DEFAULT_NETWORK_PROXY_CONFIG: NetworkProxyConfig = {
  mode: "system",
  url: "",
  noProxy: "",
};

/** 「测试连接」结果（主进程 CONNECT 探针 → 设置页展示）。 */
export type NetworkProxyTestResult = {
  ok: boolean;
  /** 实际测试的代理；null = 系统未配置代理（直连，无需测试） */
  proxy: string | null;
  statusCode?: number;
  error?: string;
  latencyMs: number;
};

/**
 * 归一化 http(s) 代理地址；host:port 自动补 http://；其它 scheme/非法值返回 null。
 *
 * 默认拒绝 user:pass@：设置页的值会明文落 state.db，凭据应走 KOVA_SIDECAR_PROXY
 * 环境变量（不持久化）。强制 env 路径可显式 allowCredentials。
 */
export function normalizeNetworkProxyUrl(
  raw: unknown,
  options?: { allowCredentials?: boolean },
): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    if (!options?.allowCredentials && (url.username || url.password)) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * 解析持久化 JSON。坏数据/custom 地址非法时回落 system——代理配置坏了不能
 * 让应用直接断网。
 */
export function parseNetworkProxyConfig(
  raw: string | null | undefined,
): NetworkProxyConfig {
  if (!raw) return DEFAULT_NETWORK_PROXY_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<NetworkProxyConfig> | null;
    const mode: NetworkProxyMode =
      parsed?.mode === "direct" || parsed?.mode === "custom"
        ? parsed.mode
        : "system";
    const url = typeof parsed?.url === "string" ? parsed.url.trim() : "";
    const noProxy =
      typeof parsed?.noProxy === "string" ? parsed.noProxy : "";
    if (mode === "custom" && !normalizeNetworkProxyUrl(url)) {
      return DEFAULT_NETWORK_PROXY_CONFIG;
    }
    return { mode, url, noProxy };
  } catch {
    return DEFAULT_NETWORK_PROXY_CONFIG;
  }
}

export function serializeNetworkProxyConfig(
  config: NetworkProxyConfig,
): string {
  return JSON.stringify(config);
}
