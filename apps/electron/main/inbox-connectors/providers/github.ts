/**
 * GitHub 通知 adapter：GET /notifications（只取未读）。
 *
 * 默认只收需要动作的 reason：assign / review_requested / mention / team_mention。
 * 不做写操作（不替用户在 GitHub 上标记已读），打开链接后由 GitHub 自己在
 * 下一次同步时把通知移出未读集合。
 */
import type { InboxExternalDetail } from "pi-protocol";
import type { ExternalNotification } from "../types";
import type {
  ConnectorAdapter,
  ConnectorFetchContext,
  ConnectorTestResult,
} from "../types";
import {
  assertOk,
  ConnectorError,
  errorSnippet,
  parseJson,
} from "../errors";
import {
  clampMultiline,
  clampText,
  eventEnabled,
  hostOf,
  isoOrUndefined,
  normalizeBaseUrl,
  reasonLabel,
  safeHttpUrl,
  summaryLine,
} from "../normalize";

const DEFAULT_BASE = "https://api.github.com";
const LABEL = "GitHub";
const PER_PAGE = 50;
const MAX_PAGES = 2;

type GhNotification = {
  id?: string;
  reason?: string;
  updated_at?: string;
  subject?: {
    title?: string;
    type?: string;
    url?: string;
  };
  repository?: {
    full_name?: string;
    html_url?: string;
  };
};

type GhUser = { login?: string; avatar_url?: string };

function includeReason(
  reason: string,
  ctx: ConnectorFetchContext,
): boolean {
  switch (reason) {
    case "assign":
      return eventEnabled(ctx.config, "assigned");
    case "review_requested":
      return eventEnabled(ctx.config, "reviewRequested");
    case "mention":
    case "team_mention":
      return eventEnabled(ctx.config, "mention");
    default:
      return false;
  }
}

/** api.github.com → github.com；GHES 的 /api/v3 前缀回到站点根。 */
function webOriginOf(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    if (url.host === "api.github.com") return "https://github.com";
    return url.origin;
  } catch {
    return "https://github.com";
  }
}

function typeLabel(type: string | undefined): string {
  switch (type) {
    case "PullRequest":
      return "pull_request";
    case "Issue":
      return "issue";
    case "Discussion":
      return "discussion";
    case "Release":
      return "release";
    case "Commit":
      return "commit";
    default:
      return (type ?? "notification").toLowerCase();
  }
}

function webPathFor(type: string | undefined, number: string): string | null {
  switch (type) {
    case "PullRequest":
      return `/pull/${number}`;
    case "Discussion":
      return `/discussions/${number}`;
    case "Issue":
      return `/issues/${number}`;
    default:
      return null;
  }
}

export function mapGithubNotification(
  raw: unknown,
  ctx: ConnectorFetchContext,
  apiBase: string,
): ExternalNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as GhNotification;
  const reason = typeof n.reason === "string" ? n.reason : "";
  if (!includeReason(reason, ctx)) return null;

  const subject = n.subject ?? {};
  const repo = clampText(n.repository?.full_name, 160);
  const repoWeb =
    safeHttpUrl(n.repository?.html_url) ??
    (repo ? `${webOriginOf(apiBase)}/${repo}` : undefined);
  const host = hostOf(repoWeb) || hostOf(apiBase);
  const subjectUrl = safeHttpUrl(subject.url);
  const number = subjectUrl?.split("/").filter(Boolean).at(-1) ?? "";
  const webPath = number ? webPathFor(subject.type, number) : null;
  const url = repoWeb && webPath ? `${repoWeb}${webPath}` : repoWeb;

  const key = repo
    ? number
      ? `${repo}#${number}`
      : repo
    : `notification:${n.id ?? subject.title ?? "unknown"}`;
  const idKey = host ? `${host}/${key}` : key;

  return {
    idKey,
    key,
    type: typeLabel(subject.type),
    title:
      clampText(subject.title, 160) ??
      clampText(`${repo || LABEL} 有新通知`, 160) ??
      `${LABEL} 通知`,
    summary: summaryLine(reasonLabel(reason), repo),
    url,
    sourceName: repo,
    createdAt: isoOrUndefined(n.updated_at),
    requiresAction:
      reason === "assign" ||
      reason === "review_requested" ||
      reason === "mention" ||
      reason === "team_mention",
    priority:
      reason === "review_requested" ||
      reason === "mention" ||
      reason === "team_mention"
        ? 1
        : reason === "assign"
          ? 1
          : 2,
    reason,
  };
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Kova-Inbox",
  };
}

function nextLink(res: { headers: Record<string, string> }): string | null {
  const link = res.headers.link;
  if (!link) return null;
  const match = /<([^>]+)>;\s*rel="next"/i.exec(link);
  return match?.[1] ?? null;
}

async function fetchPaged(
  ctx: ConnectorFetchContext,
): Promise<{ items: ExternalNotification[]; complete: boolean }> {
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  const items: ExternalNotification[] = [];
  let url: string | null =
    `${apiBase}/notifications?all=false&per_page=${PER_PAGE}`;
  let complete = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (!url) break;
    let res;
    try {
      res = await ctx.http({
        url,
        headers: headers(ctx.token),
        timeoutMs: 15_000,
      });
    } catch (error) {
      throw error;
    }
    assertOk(res, {
      label: LABEL,
      authHint:
        "Token 无效或权限不足（需要 notifications 只读权限；Classic PAT 勾选 notifications）",
      configHint:
        "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
    });
    const parsed = parseJson<unknown>(res, LABEL);
    if (!Array.isArray(parsed)) {
      throw new ConnectorError(
        "config",
        `${LABEL}：通知接口返回格式异常：${errorSnippet(res.text)}`,
      );
    }
    for (const row of parsed as GhNotification[]) {
      const item = mapGithubNotification(row, ctx, apiBase);
      if (item) items.push(item);
    }
    url = nextLink(res);
    if (!url) {
      complete = true;
      break;
    }
    if (page === MAX_PAGES - 1) complete = false;
  }
  return { items, complete };
}

type GhIssueDetail = {
  title?: string;
  body?: string | null;
  state?: string;
  user?: GhUser;
  labels?: Array<{ name?: string }>;
  updated_at?: string;
  html_url?: string;
};

type GhComment = {
  id?: number;
  body?: string | null;
  user?: GhUser;
  created_at?: string;
  html_url?: string;
};

function parseGithubKey(key: string): { repo: string; number: string } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(key.trim());
  return match ? { repo: match[1], number: match[2] } : null;
}

async function fetchGithubDetail(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string },
): Promise<InboxExternalDetail> {
  const parsed = parseGithubKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 owner/repo#123）`,
    );
  }
  if (input.type === "discussion") {
    throw new ConnectorError("config", `${LABEL}：暂不支持 Discussion 详情`);
  }
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  const isPr = input.type === "pull_request";
  const basePath = `/repos/${parsed.repo}/${isPr ? "pulls" : "issues"}/${parsed.number}`;

  const issueRes = await ctx.http({
    url: `${apiBase}${basePath}`,
    headers: headers(ctx.token),
    timeoutMs: 15_000,
  });
  assertOk(issueRes, {
    label: LABEL,
    authHint:
      "Token 无效或权限不足（需要读取该仓库 Issue/PR 的权限）",
    configHint: "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
    notFoundHint: "Issue/PR 不存在或无权访问（可能已被删除）",
  });
  const item = parseJson<GhIssueDetail>(issueRes, LABEL);

  // 评论是可选信息：拉不到时仍然展示正文，不让整页失败
  let comments: GhComment[] = [];
  try {
    const commentsRes = await ctx.http({
      url: `${apiBase}/repos/${parsed.repo}/issues/${parsed.number}/comments?per_page=30`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(commentsRes, { label: LABEL });
    const parsedComments = parseJson<unknown>(commentsRes, LABEL);
    if (Array.isArray(parsedComments)) comments = parsedComments as GhComment[];
  } catch {
    comments = [];
  }

  const body = clampMultiline(item.body ?? undefined, 20_000);
  return {
    ...(clampText(item.title, 300) ? { title: clampText(item.title, 300) } : {}),
    ...(body ? { body } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.user?.login ? { author: item.user.login } : {}),
    ...(item.user?.avatar_url && safeHttpUrl(item.user.avatar_url)
      ? { avatarUrl: item.user.avatar_url }
      : {}),
    ...(item.labels?.length
      ? {
          labels: item.labels
            .map((label) => clampText(label.name, 60))
            .filter((label): label is string => Boolean(label))
            .slice(0, 10),
        }
      : {}),
    ...(safeHttpUrl(item.html_url) ? { url: item.html_url } : {}),
    ...(isoOrUndefined(item.updated_at)
      ? { updatedAt: isoOrUndefined(item.updated_at) }
      : {}),
    comments: comments.slice(0, 30).map((comment) => ({
      id: String(comment.id ?? `${comment.created_at ?? ""}:${comment.user?.login ?? ""}`),
      ...(comment.user?.login ? { author: comment.user.login } : {}),
      ...(comment.user?.avatar_url && safeHttpUrl(comment.user.avatar_url)
        ? { avatarUrl: comment.user.avatar_url }
        : {}),
      body: clampMultiline(comment.body ?? undefined, 6_000) ?? "",
      ...(isoOrUndefined(comment.created_at)
        ? { createdAt: isoOrUndefined(comment.created_at) }
        : {}),
      ...(safeHttpUrl(comment.html_url) ? { url: comment.html_url } : {}),
    })),
    ...(body && body.length >= 20_000 ? { truncated: true } : {}),
  };
}

export const githubAdapter: ConnectorAdapter = {
  provider: "github",
  label: LABEL,

  async fetch(ctx) {
    const result = await fetchPaged(ctx);
    return { items: result.items, complete: result.complete };
  },

  detail(ctx, input) {
    return fetchGithubDetail(ctx, input);
  },

  async test(ctx): Promise<ConnectorTestResult> {
    const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
    const res = await ctx.http({
      url: `${apiBase}/user`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 无效或已过期",
      configHint: "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
    });
    const user = parseJson<GhUser>(res, LABEL);
    const result = await fetchPaged(ctx);
    return {
      accountName: clampText(user.login, 80),
      itemCount: result.items.length,
    };
  },
};
