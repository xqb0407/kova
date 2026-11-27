/**
 * 外部 issue 详情（正文/评论）按需拉取。
 *
 * 事实源仍在各平台；这里只在用户选中条目时调用 provider detail 接口，
 * 返回内存缓存 60s。Token/代理都在主进程，详情不落收件箱 journal。
 */
import type {
  InboxExternalChecks,
  InboxExternalChecksResult,
  InboxExternalCommentInput,
  InboxExternalCommentResult,
  InboxExternalDetail,
  InboxExternalDetailInput,
  InboxExternalDetailResult,
  InboxExternalDiff,
  InboxExternalDiffResult,
  InboxExternalPullRequestInput,
  InboxPullRequestActionInput,
  InboxPullRequestActionResult,
} from "pi-protocol";
import { loadStoredConnectors, tokenOf } from "./config-store";
import { asNetworkError, ConnectorError } from "./errors";
import { electronHttp } from "./http";
import { adapterFor } from "./providers";
import { recordInboxSelfActivity } from "./self-activity";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 60;
const DIFF_CACHE_MAX = 20;
const cache = new Map<string, { at: number; detail: InboxExternalDetail }>();
const diffCache = new Map<string, { at: number; value: InboxExternalDiff }>();
const checksCache = new Map<string, { at: number; value: InboxExternalChecks }>();

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

function ttlGet<T>(
  store: Map<string, { at: number; value: T }>,
  key: string,
): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function ttlSet<T>(
  store: Map<string, { at: number; value: T }>,
  key: string,
  value: T,
  max: number,
): void {
  store.set(key, { at: Date.now(), value });
  while (store.size > max) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";
}

type ResolvedConnector = {
  provider: NonNullable<InboxExternalDetailInput["provider"]>;
  key: string;
  type?: string;
  externalId?: string;
  config: ReturnType<typeof loadStoredConnectors>[number];
  token: string;
};

/**
 * 命令共用的参数/配置解析：provider 白名单、key 归一、连接器与 Token。
 * 失败时返回可展示文案，调用方直接转成 `{ ok:false }`。
 */
function resolveConnector(
  raw: unknown,
): { ok: true; value: ResolvedConnector } | { ok: false; message: string } {
  const input = (raw ?? {}) as Partial<InboxExternalPullRequestInput>;
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
  const type = clean(input.type, 40) || undefined;
  const externalId = clean(input.externalId, 160) || undefined;
  return {
    ok: true,
    value: { provider, key, type, externalId, config, token },
  };
}

export async function fetchInboxExternalDetail(
  raw: unknown,
): Promise<InboxExternalDetailResult> {
  const resolved = resolveConnector(raw);
  if (!resolved.ok) return resolved;
  const { provider, key, type, externalId, config, token } = resolved.value;
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

/** PR/MR diff：独立缓存，避免打开条目就拉大 patch。 */
export async function fetchInboxPullRequestDiff(
  raw: unknown,
): Promise<InboxExternalDiffResult> {
  const resolved = resolveConnector(raw);
  if (!resolved.ok) return resolved;
  const { provider, key, type, externalId, config, token } = resolved.value;
  const headSha = clean(
    (raw as Partial<InboxExternalPullRequestInput> | undefined)?.headSha,
    80,
  ) || undefined;
  const force =
    (raw as Partial<InboxExternalPullRequestInput> | undefined)?.force === true;
  const adapter = adapterFor(provider);
  if (!adapter.pullRequestDiff) {
    return { ok: false, message: `${adapter.label} 暂不支持代码差异` };
  }
  const cacheId = `${provider}:${key}:${externalId ?? ""}:${headSha ?? ""}`;
  const cached = force ? null : ttlGet(diffCache, cacheId);
  if (cached) return { ok: true, diff: cached };
  try {
    const diff = await adapter.pullRequestDiff(
      { config, token, http: electronHttp },
      { key, type, externalId, ...(headSha ? { headSha } : {}) },
    );
    ttlSet(diffCache, cacheId, diff, DIFF_CACHE_MAX);
    return { ok: true, diff };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapter.label);
    return { ok: false, message: failure.message };
  }
}

/** 写操作后清掉该条目的详情/diff/checks 缓存，下一次读取回源。 */
function clearConnectorCaches(provider: string, key: string): void {
  const prefix = `${provider}:${key}:`;
  for (const store of [cache, diffCache, checksCache]) {
    for (const cacheKey of [...store.keys()]) {
      if (cacheKey.startsWith(prefix)) store.delete(cacheKey);
    }
  }
}

/** 发表评论/回复；成功后记录 self-activity，避免同步把自己的操作顶回未读。 */
export async function postInboxExternalComment(
  raw: unknown,
): Promise<InboxExternalCommentResult> {
  const resolved = resolveConnector(raw);
  if (!resolved.ok) return resolved;
  const { provider, key, type, externalId, config, token } = resolved.value;
  const input = (raw ?? {}) as Partial<InboxExternalCommentInput>;
  const body =
    typeof input.body === "string"
      ? input.body.replace(/\r\n/g, "\n").trim()
      : "";
  if (!body) return { ok: false, message: "评论内容不能为空" };
  if (body.length > 20_000) {
    return { ok: false, message: "评论过长（上限 20000 字）" };
  }
  const replyToId = clean(input.replyToId, 160) || undefined;
  const adapter = adapterFor(provider);
  if (!adapter.postComment) {
    return { ok: false, message: `${adapter.label} 暂不支持发表评论` };
  }
  try {
    await adapter.postComment(
      { config, token, http: electronHttp },
      { key, type, externalId, body, ...(replyToId ? { replyToId } : {}) },
    );
    recordInboxSelfActivity(provider, key);
    clearConnectorCaches(provider, key);
    return { ok: true };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapter.label);
    return { ok: false, message: failure.message };
  }
}

/** PR/MR 写操作（merge/close/reopen/ready）；成功后同样抑制未读回弹。 */
export async function runInboxPullRequestAction(
  raw: unknown,
): Promise<InboxPullRequestActionResult> {
  const resolved = resolveConnector(raw);
  if (!resolved.ok) return resolved;
  const { provider, key, type, externalId, config, token } = resolved.value;
  const input = (raw ?? {}) as Partial<InboxPullRequestActionInput>;
  const action = input.action;
  const headSha = clean(input.headSha, 80) || undefined;
  if (
    action !== "merge" &&
    action !== "squash" &&
    action !== "rebase" &&
    action !== "close" &&
    action !== "reopen" &&
    action !== "ready_for_review"
  ) {
    return { ok: false, message: "不支持的 PR 操作" };
  }
  const adapter = adapterFor(provider);
  if (!adapter.pullRequestAction) {
    return { ok: false, message: `${adapter.label} 暂不支持 PR 操作` };
  }
  try {
    await adapter.pullRequestAction(
      { config, token, http: electronHttp },
      { key, type, externalId, action, ...(headSha ? { headSha } : {}) },
    );
    recordInboxSelfActivity(provider, key);
    clearConnectorCaches(provider, key);
    return { ok: true };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapter.label);
    return { ok: false, message: failure.message };
  }
}

/** PR/MR checks：独立缓存；同一 headSha 下 60s 内不重复拉。 */
export async function fetchInboxPullRequestChecks(
  raw: unknown,
): Promise<InboxExternalChecksResult> {
  const resolved = resolveConnector(raw);
  if (!resolved.ok) return resolved;
  const { provider, key, type, externalId, config, token } = resolved.value;
  const headSha = clean(
    (raw as Partial<InboxExternalPullRequestInput> | undefined)?.headSha,
    80,
  ) || undefined;
  const force =
    (raw as Partial<InboxExternalPullRequestInput> | undefined)?.force === true;
  const adapter = adapterFor(provider);
  if (!adapter.pullRequestChecks) {
    return { ok: false, message: `${adapter.label} 暂不支持检查项` };
  }
  const cacheId = `${provider}:${key}:${externalId ?? ""}:${headSha ?? ""}`;
  const cached = force ? null : ttlGet(checksCache, cacheId);
  if (cached) return { ok: true, checks: cached };
  try {
    const checks = await adapter.pullRequestChecks(
      { config, token, http: electronHttp },
      { key, type, externalId, ...(headSha ? { headSha } : {}) },
    );
    ttlSet(checksCache, cacheId, checks, CACHE_MAX);
    return { ok: true, checks };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapter.label);
    return { ok: false, message: failure.message };
  }
}
