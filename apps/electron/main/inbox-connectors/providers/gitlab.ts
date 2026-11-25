/**
 * GitLab 待办 adapter：GET /api/v4/todos?state=pending（只取未完成待办）。
 *
 * Todos 天然覆盖 assigned / review_requested / mentioned / directly_addressed /
 * unmergeable / build_failed；默认屏蔽 build_failed 与 marked，避免流水线刷屏。
 */
import type { InboxExternalDetail } from "pi-protocol";
import type { ExternalNotification } from "../types";
import type {
  ConnectorAdapter,
  ConnectorFetchContext,
  ConnectorTestResult,
} from "../types";
import { assertOk, ConnectorError, parseJson } from "../errors";
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

const DEFAULT_BASE = "https://gitlab.com";
const LABEL = "GitLab";
const PER_PAGE = 100;
const MAX_PAGES = 2;

type GitlabTodo = {
  id?: number;
  action_name?: string;
  target_type?: string;
  target_url?: string;
  created_at?: string;
  project?: {
    path_with_namespace?: string;
    web_url?: string;
  };
  target?: {
    title?: string;
    iid?: number;
    state?: string;
  };
};

type GitlabUser = { username?: string; name?: string };

function apiBase(config: { baseUrl?: string }): string {
  const root = normalizeBaseUrl(config.baseUrl, DEFAULT_BASE, LABEL);
  return /\/api\/v\d+$/i.test(root) ? root : `${root}/api/v4`;
}

function includeAction(
  action: string,
  ctx: ConnectorFetchContext,
): boolean {
  switch (action) {
    case "assigned":
      return eventEnabled(ctx.config, "assigned");
    case "review_requested":
    case "approval_required":
      return eventEnabled(ctx.config, "reviewRequested");
    case "mentioned":
    case "directly_addressed":
      return eventEnabled(ctx.config, "mention");
    case "unmergeable":
      return eventEnabled(ctx.config, "unmergeable");
    case "build_failed":
      return eventEnabled(ctx.config, "buildFailed");
    default:
      return false;
  }
}

function isMergeRequest(todo: GitlabTodo): boolean {
  return todo.target_type === "MergeRequest";
}

function pathNumber(todo: GitlabTodo): string {
  const fromTarget = Number(todo.target?.iid);
  if (Number.isFinite(fromTarget) && fromTarget > 0) {
    return String(Math.trunc(fromTarget));
  }
  const match = /\/-\/(?:issues|merge_requests)\/(\d+)/.exec(
    todo.target_url ?? "",
  );
  return match?.[1] ?? String(todo.id ?? "");
}

export function mapGitlabTodo(
  raw: unknown,
  ctx: ConnectorFetchContext,
): ExternalNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const todo = raw as GitlabTodo;
  const action = typeof todo.action_name === "string" ? todo.action_name : "";
  if (!includeAction(action, ctx)) return null;

  const projectPath = clampText(todo.project?.path_with_namespace, 160);
  const host =
    hostOf(todo.target_url) ||
    hostOf(todo.project?.web_url) ||
    hostOf(apiBase(ctx.config));
  const number = pathNumber(todo);
  const kind = isMergeRequest(todo) ? "merge_request" : "issue";
  const separator = isMergeRequest(todo) ? "!" : "#";
  const keyBase = projectPath
    ? `${projectPath}${separator}${number}`
    : `todo:${todo.id ?? number}`;
  const idKey = host ? `${host}/${keyBase}` : keyBase;
  const projectWeb =
    safeHttpUrl(todo.project?.web_url) ??
    (projectPath && host ? `https://${host}/${projectPath}` : undefined);
  const url =
    safeHttpUrl(todo.target_url) ||
    (projectWeb && number
      ? `${projectWeb}/-/${
          isMergeRequest(todo) ? "merge_requests" : "issues"
        }/${number}`
      : undefined);

  return {
    idKey,
    key: keyBase,
    type: kind,
    title:
      clampText(todo.target?.title, 160) ??
      clampText(`${projectPath ?? LABEL} 待办`, 160) ??
      `${LABEL} 待办`,
    summary: summaryLine(reasonLabel(action), projectPath),
    url,
    status: clampText(todo.target?.state, 60),
    sourceName: projectPath,
    createdAt: isoOrUndefined(todo.created_at),
    requiresAction:
      action !== "build_failed" && action !== "marked",
    priority: action === "build_failed" ? 2 : 1,
    reason: action,
  };
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "PRIVATE-TOKEN": token,
    "User-Agent": "Kova-Inbox",
  };
}

async function fetchPaged(
  ctx: ConnectorFetchContext,
): Promise<{ items: ExternalNotification[]; complete: boolean }> {
  const api = apiBase(ctx.config);
  const items: ExternalNotification[] = [];
  let page = 1;
  let complete = true;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const res = await ctx.http({
      url: `${api}/todos?state=pending&per_page=${PER_PAGE}&page=${page}`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 无效或权限不足（需要 read_api）",
      configHint: "GitLab 地址不可用，请检查服务器地址",
    });
    const parsed = parseJson<unknown>(res, LABEL);
    if (!Array.isArray(parsed)) {
      throw new ConnectorError(
        "config",
        `${LABEL}：待办接口返回格式异常`,
      );
    }
    for (const row of parsed as GitlabTodo[]) {
      const item = mapGitlabTodo(row, ctx);
      if (item) items.push(item);
    }
    const next = Number(res.headers["x-next-page"] ?? "");
    if (!Number.isFinite(next) || next <= page) {
      complete = true;
      break;
    }
    page = next;
    if (index === MAX_PAGES - 1) complete = false;
  }
  return { items, complete };
}

type GitlabTodoDetail = {
  title?: string;
  description?: string;
  state?: string;
  author?: { username?: string; name?: string };
  labels?: string[];
  updated_at?: string;
  web_url?: string;
};

type GitlabNote = {
  id?: number;
  body?: string;
  system?: boolean;
  author?: { username?: string; name?: string };
  created_at?: string;
};

function parseGitlabKey(key: string): {
  path: string;
  iid: string;
  kind: "issues" | "merge_requests";
} | null {
  const match = /^(.+?)([#!])(\d+)$/.exec(key.trim());
  if (!match) return null;
  return {
    path: match[1],
    iid: match[3],
    kind: match[2] === "!" ? "merge_requests" : "issues",
  };
}

async function fetchGitlabDetail(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string },
): Promise<InboxExternalDetail> {
  const parsed = parseGitlabKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 group/project#123 或 group/project!123）`,
    );
  }
  const kind =
    input.type === "merge_request" ? "merge_requests" : parsed.kind;
  const api = apiBase(ctx.config);
  const projectPath = encodeURIComponent(parsed.path);
  const basePath = `${api}/projects/${projectPath}/${kind}/${parsed.iid}`;

  const detailRes = await ctx.http({
    url: basePath,
    headers: headers(ctx.token),
    timeoutMs: 15_000,
  });
  assertOk(detailRes, {
    label: LABEL,
    authHint: "Token 无效或权限不足（需要 read_api）",
    configHint: "GitLab 地址不可用，请检查服务器地址",
    notFoundHint: "Issue/MR 不存在或无权访问（可能已被删除）",
  });
  const item = parseJson<GitlabTodoDetail>(detailRes, LABEL);

  let notes: GitlabNote[] = [];
  try {
    const notesRes = await ctx.http({
      url: `${basePath}/notes?sort=asc&order_by=created_at&per_page=30`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(notesRes, { label: LABEL });
    const parsedNotes = parseJson<unknown>(notesRes, LABEL);
    if (Array.isArray(parsedNotes)) notes = parsedNotes as GitlabNote[];
  } catch {
    notes = [];
  }

  const body = clampMultiline(item.description, 20_000);
  const author = item.author?.name ?? item.author?.username;
  return {
    ...(clampText(item.title, 300) ? { title: clampText(item.title, 300) } : {}),
    ...(body ? { body } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(author ? { author } : {}),
    ...(Array.isArray(item.labels) && item.labels.length
      ? {
          labels: item.labels
            .map((label) => clampText(label, 60))
            .filter((label): label is string => Boolean(label))
            .slice(0, 10),
        }
      : {}),
    ...(safeHttpUrl(item.web_url) ? { url: item.web_url } : {}),
    ...(isoOrUndefined(item.updated_at)
      ? { updatedAt: isoOrUndefined(item.updated_at) }
      : {}),
    comments: notes
      .filter((note) => note.system !== true)
      .slice(0, 30)
      .map((note) => ({
        id: String(note.id ?? note.created_at ?? ""),
        ...(note.author?.name || note.author?.username
          ? { author: note.author?.name ?? note.author?.username }
          : {}),
        body: clampMultiline(note.body ?? undefined, 6_000) ?? "",
        ...(isoOrUndefined(note.created_at)
          ? { createdAt: isoOrUndefined(note.created_at) }
          : {}),
        ...(safeHttpUrl(item.web_url)
          ? { url: `${item.web_url}#note_${note.id ?? ""}` }
          : {}),
      })),
    ...(notes.length > 30 || (body && body.length >= 20_000)
      ? { truncated: true }
      : {}),
  };
}

export const gitlabAdapter: ConnectorAdapter = {
  provider: "gitlab",
  label: LABEL,

  async fetch(ctx) {
    const result = await fetchPaged(ctx);
    return { items: result.items, complete: result.complete };
  },

  detail(ctx, input) {
    return fetchGitlabDetail(ctx, input);
  },

  async test(ctx): Promise<ConnectorTestResult> {
    const api = apiBase(ctx.config);
    const res = await ctx.http({
      url: `${api}/user`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 无效或已过期",
      configHint: "GitLab 地址不可用，请检查服务器地址",
    });
    const user = parseJson<GitlabUser>(res, LABEL);
    const result = await fetchPaged(ctx);
    return {
      accountName: clampText(user.username ?? user.name, 80),
      itemCount: result.items.length,
    };
  },
};
