/**
 * 外部 issue 详情（正文/评论）按需拉取。
 *
 * 事实源仍在各平台；这里只在用户选中条目时调用 provider detail 接口，
 * 返回内存缓存 60s。Token/代理都在主进程，详情不落收件箱 journal。
 */
import type {
  InboxExternalDetail,
  InboxExternalDetailInput,
  InboxExternalDetailResult,
} from "pi-protocol";
import { loadStoredConnectors, tokenOf } from "./config-store";
import { asNetworkError, ConnectorError } from "./errors";
import { electronHttp } from "./http";
import { adapterFor } from "./providers";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 60;
const cache = new Map<string, { at: number; detail: InboxExternalDetail }>();

function cacheKey(input: InboxExternalDetailInput): string {
  return `${input.provider}:${input.key}:${input.externalId ?? ""}`;
}

function cacheGet(key: string): InboxExternalDetail | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.detail;
}

function cacheSet(key: string, detail: InboxExternalDetail): void {
  cache.set(key, { at: Date.now(), detail });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";
}

export async function fetchInboxExternalDetail(
  raw: unknown,
): Promise<InboxExternalDetailResult> {
  const input = (raw ?? {}) as Partial<InboxExternalDetailInput>;
  const provider = input.provider;
  if (
    provider !== "github" &&
    provider !== "gitlab" &&
    provider !== "jira" &&
    provider !== "linear"
  ) {
    return { ok: false, message: "不支持的收件箱来源" };
  }
  const key = clean(input.key, 300);
  if (!key) return { ok: false, message: "缺少条目编号" };
  const type = clean(input.type, 40) || undefined;
  const externalId = clean(input.externalId, 160) || undefined;

  const config = loadStoredConnectors().find(
    (item) => item.provider === provider,
  );
  if (!config) {
    return { ok: false, message: "该来源尚未接入，请先在设置中连接" };
  }
  const token = tokenOf(config);
  if (!token) {
    return { ok: false, message: "Token 不可用，请重新填写" };
  }
  const adapter = adapterFor(provider);
  if (!adapter.detail) {
    return { ok: false, message: `${adapter.label} 暂不支持详情` };
  }

  const normalized: InboxExternalDetailInput = {
    provider,
    key,
    ...(type ? { type } : {}),
    ...(externalId ? { externalId } : {}),
  };
  const cacheId = cacheKey(normalized);
  const cached = cacheGet(cacheId);
  if (cached) return { ok: true, detail: cached };

  try {
    const detail = await adapter.detail(
      { config, token, http: electronHttp },
      { key, type, externalId },
    );
    cacheSet(cacheId, detail);
    return { ok: true, detail };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapter.label);
    return { ok: false, message: failure.message };
  }
}
