"use client";

/**
 * MCP 市场：官方 MCP Registry 的只读客户端。
 *
 *   GET https://registry.modelcontextprotocol.io/v0/servers
 *       ?search=&limit=&cursor=
 *
 * 公开只读、无需 Key，CORS 全开，渲染进程可直连。这里只取「可远程连接」
 * 的条目：remotes 里的 streamable-http / sse 且地址必须是 HTTPS——
 * 本地包（npm/pypi/docker）要映射成命令与参数，超出「一键添加」的安全
 * 范围，本市场一律不展示。
 *
 * 合规约定：不镜像、不缓存整库，按搜索词与游标即取即用；安装时直接用
 * Registry 给出的远程地址，不在本地代理或转存内容；卡片不展示第三方
 * logo，只显示名称与仓库链接。
 *
 * 同一 name 会有多个版本，服务端用 _meta 标记 isLatest；只保留最新版，
 * 且 status 非 active 的一律丢弃。
 */

/** 官方 Registry 地址；换环境时改这一处 */
export const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0";

export type McpMarketHeader = {
  name: string;
  description: string;
  /** 必填：不填就连不上（通常是鉴权头） */
  isRequired: boolean;
  /** 密钥类：UI 用密码框，不回显 */
  isSecret: boolean;
  /** 注册表给的默认值/占位（非密钥时才可直接沿用） */
  defaultValue?: string;
};

export type McpMarketRemoteType = "streamable-http" | "sse";

export type McpMarketRemote = {
  type: McpMarketRemoteType;
  url: string;
  headers: McpMarketHeader[];
};

export type McpMarketServer = {
  /** `${name}@${version}`：同一条目的稳定标识 */
  id: string;
  /** 注册表全名，如 ai.smithery/xxx */
  name: string;
  /** 展示名：title 优先，缺失时取全名末段 */
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  /** 注册表条目自带的图标（https）；没有时 UI 回落到首字母色块 */
  iconUrl?: string;
  remotes: McpMarketRemote[];
  updatedAt?: string;
};

export type McpMarketPage = {
  servers: McpMarketServer[];
  nextCursor: string | null;
};

type RegistryHeader = {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
};

type RegistryRemote = {
  type?: string;
  url?: string;
  headers?: RegistryHeader[];
};

type RegistryServer = {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  icons?: { src?: string }[];
  remotes?: RegistryRemote[];
};

type RegistryEntry = {
  server?: RegistryServer;
  _meta?: Record<string, unknown>;
};

type RegistryResponse = {
  servers?: RegistryEntry[];
  metadata?: { nextCursor?: string | null; count?: number };
};

const REQUEST_TIMEOUT_MS = 10_000;

/** 单请求硬超时：连接挂起时不能让加载态永远转圈 */
async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(`${MCP_REGISTRY_BASE}${path}`, {
      signal: merged,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error(
        `MCP Registry 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）`,
      );
    throw err;
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      // 非 JSON 错误体：保留状态码
    }
    throw new Error(`MCP Registry 请求失败：${message}`);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function officialMeta(
  entry: RegistryEntry,
): { status?: string; isLatest?: boolean; updatedAt?: string } | null {
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if (!meta || typeof meta !== "object") return null;
  const record = meta as {
    status?: unknown;
    isLatest?: unknown;
    updatedAt?: unknown;
  };
  return {
    status: typeof record.status === "string" ? record.status : undefined,
    isLatest:
      typeof record.isLatest === "boolean" ? record.isLatest : undefined,
    updatedAt:
      typeof record.updatedAt === "string" ? record.updatedAt : undefined,
  };
}

/** 只接受 HTTPS 远程地址：第三方托管代理的明文 HTTP 一律不信任 */
function normalizeRemote(remote: RegistryRemote): McpMarketRemote | null {
  if (remote.type !== "streamable-http" && remote.type !== "sse") return null;
  if (!remote.url) return null;
  let parsed: URL;
  try {
    parsed = new URL(remote.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const headers = (remote.headers ?? [])
    .filter((h): h is RegistryHeader & { name: string } =>
      Boolean(h?.name?.trim()),
    )
    .map((h) => ({
      name: h.name.trim(),
      description: h.description?.trim() ?? "",
      isRequired: h.isRequired === true,
      isSecret: h.isSecret === true,
      defaultValue:
        !h.isSecret && typeof h.value === "string" && h.value.trim()
          ? h.value.trim()
          : undefined,
    }));
  return { type: remote.type, url: parsed.toString(), headers };
}

function normalizeEntry(entry: RegistryEntry): McpMarketServer | null {
  const server = entry.server;
  const meta = officialMeta(entry);
  // 下架/废弃的不展示
  if (meta?.status && meta.status !== "active") return null;
  // 同名的旧版本不展示（缺 isLatest 的老条目交给后面按 name 去重）
  if (meta?.isLatest === false) return null;
  if (!server?.name || !server.version) return null;

  const remotes = (server.remotes ?? [])
    .map(normalizeRemote)
    .filter((r): r is McpMarketRemote => r !== null);
  if (remotes.length === 0) return null;

  const shortName = server.name.split("/").pop() ?? server.name;
  const iconUrl = server.icons?.find(
    (icon) => icon?.src && icon.src.startsWith("https://"),
  )?.src;
  return {
    id: `${server.name}@${server.version}`,
    name: server.name,
    title: server.title?.trim() || shortName,
    description: server.description?.trim() ?? "",
    version: server.version,
    repositoryUrl: server.repository?.url,
    iconUrl,
    remotes,
    updatedAt: meta?.updatedAt,
  };
}

/**
 * 取一页市场条目（已过滤不可远程连接/明文 HTTP/旧版本，并按 name 去重）。
 * `nextCursor` 透传，调用方用它「加载更多」。
 */
export async function fetchMcpMarketPage(
  params: { search?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
): Promise<McpMarketPage> {
  const res = await request<RegistryResponse>(
    `/servers${qs({
      search: params.search?.trim() || undefined,
      cursor: params.cursor,
      limit: params.limit ?? 30,
    })}`,
    signal,
  );

  const servers: McpMarketServer[] = [];
  const seen = new Set<string>();
  for (const entry of res.servers ?? []) {
    const server = normalizeEntry(entry);
    if (!server || seen.has(server.name)) continue;
    seen.add(server.name);
    servers.push(server);
  }

  return {
    servers,
    nextCursor: res.metadata?.nextCursor ?? null,
  };
}
