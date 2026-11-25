/**
 * Linear adapter：GraphQL 拉「指派给我且未完成/未取消」的 Issue。
 * 只读；不写回 Linear。
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
  isoOrUndefined,
  summaryLine,
} from "../normalize";

const LABEL = "Linear";
const ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const MAX_PAGES = 2;

const ASSIGNED_QUERY = `
query KovaInboxAssigned($first: Int!, $after: String) {
  viewer { name email }
  issues(
    first: $first
    after: $after
    filter: {
      assignee: { isMe: { eq: true } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      priority
      createdAt
      updatedAt
      state { name type }
      team { name key }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
  state?: { name?: string; type?: string };
  team?: { name?: string; key?: string };
};

type LinearViewer = { name?: string; email?: string };

type LinearIssuesPayload = {
  viewer?: LinearViewer;
  issues?: {
    nodes?: LinearIssue[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  };
};

type LinearResponse = {
  data?: LinearIssuesPayload;
  errors?: Array<{ message?: string }>;
};

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: token,
    "User-Agent": "Kova-Inbox",
  };
}

function linearPriority(value: unknown): 1 | 2 | 3 {
  switch (Number(value)) {
    case 1:
    case 2:
      return 1;
    case 3:
      return 2;
    case 4:
      return 3;
    default:
      return 2;
  }
}

export function mapLinearIssue(raw: unknown): ExternalNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const issue = raw as LinearIssue;
  const identifier = clampText(issue.identifier, 80);
  if (!identifier) return null;
  const teamName = clampText(issue.team?.name ?? issue.team?.key, 120);
  const status = clampText(issue.state?.name, 60);
  return {
    idKey: `linear/${identifier}`,
    key: identifier,
    type: "issue",
    title: clampText(issue.title, 160) ?? `${LABEL} ${identifier}`,
    summary: summaryLine("指派给你", teamName, status),
    url: clampText(issue.url, 500),
    status,
    sourceName: teamName,
    createdAt: isoOrUndefined(issue.createdAt ?? issue.updatedAt),
    requiresAction: true,
    priority: linearPriority(issue.priority),
    reason: "assigned",
    ...(issue.id ? { externalId: issue.id } : {}),
  };
}

async function requestPage(
  ctx: ConnectorFetchContext,
  after: string | undefined,
): Promise<{
  viewer?: LinearViewer;
  rows: LinearIssue[];
  hasNextPage: boolean;
  endCursor?: string;
}> {
  let res;
  try {
    res = await ctx.http({
      url: ENDPOINT,
      method: "POST",
      headers: headers(ctx.token),
      body: JSON.stringify({
        query: ASSIGNED_QUERY,
        variables: { first: PAGE_SIZE, after: after ?? null },
      }),
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw error;
  }
  assertOk(res, {
    label: LABEL,
    authHint: "API Key 无效或已过期",
    configHint: "Linear 接口不可用，请检查网络或代理",
  });
  const payload = parseJson<LinearResponse>(res, LABEL);
  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors
      .map((entry) => entry.message)
      .filter((entry): entry is string => Boolean(entry))
      .join("; ");
    throw new ConnectorError(
      /auth|unauthor/i.test(message) ? "auth" : "http",
      `${LABEL}：${message || "GraphQL 查询失败"}`,
    );
  }
  const issues = payload.data?.issues;
  return {
    viewer: payload.data?.viewer,
    rows: Array.isArray(issues?.nodes) ? issues.nodes : [],
    hasNextPage: issues?.pageInfo?.hasNextPage === true,
    endCursor:
      typeof issues?.pageInfo?.endCursor === "string"
        ? issues.pageInfo.endCursor
        : undefined,
  };
}

async function fetchIssues(ctx: ConnectorFetchContext): Promise<{
  items: ExternalNotification[];
  complete: boolean;
  accountName?: string;
}> {
  const items: ExternalNotification[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let accountName: string | undefined;
  let complete = true;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await requestPage(ctx, after);
    accountName =
      clampText(result.viewer?.name ?? result.viewer?.email, 80) ?? accountName;
    for (const row of result.rows) {
      const item = mapLinearIssue(row);
      const key = item?.idKey ?? item?.key ?? "";
      if (item && key && !seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
    if (!result.hasNextPage || !result.endCursor) {
      complete = true;
      break;
    }
    after = result.endCursor;
    if (page === MAX_PAGES - 1) complete = false;
  }
  return { items, complete, accountName };
}

const DETAIL_QUERY = `
query KovaInboxIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    state { name }
    assignee { name }
    creator { name }
    team { name }
    url
    updatedAt
    comments(first: 30) {
      nodes {
        id
        body
        createdAt
        user { name }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

type LinearIssueDetail = {
  identifier?: string;
  title?: string;
  description?: string;
  state?: { name?: string };
  assignee?: { name?: string };
  creator?: { name?: string };
  team?: { name?: string };
  url?: string;
  updatedAt?: string;
  comments?: {
    nodes?: Array<{
      id?: string;
      body?: string;
      createdAt?: string;
      user?: { name?: string };
    }>;
    pageInfo?: { hasNextPage?: boolean };
  };
};

type LinearDetailResponse = {
  data?: { issue?: LinearIssueDetail | null };
  errors?: Array<{ message?: string }>;
};

async function fetchLinearDetail(
  ctx: ConnectorFetchContext,
  input: { key: string; externalId?: string },
): Promise<InboxExternalDetail> {
  const id = input.externalId?.trim() || input.key.trim();
  if (!id) {
    throw new ConnectorError("config", `${LABEL}：缺少 Issue id`);
  }
  const res = await ctx.http({
    url: ENDPOINT,
    method: "POST",
    headers: headers(ctx.token),
    body: JSON.stringify({
      query: DETAIL_QUERY,
      variables: { id },
    }),
    timeoutMs: 15_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "API Key 无效或已过期",
    configHint: "Linear 接口不可用，请检查网络或代理",
  });
  const payload = parseJson<LinearDetailResponse>(res, LABEL);
  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors
      .map((entry) => entry.message)
      .filter((entry): entry is string => Boolean(entry))
      .join("; ");
    throw new ConnectorError(
      /auth|unauthor/i.test(message) ? "auth" : "http",
      `${LABEL}：${message || "GraphQL 查询失败"}`,
    );
  }
  const issue = payload.data?.issue;
  if (!issue) {
    throw new ConnectorError(
      "config",
      `${LABEL}：找不到该 Issue（可能已被删除或无权访问）`,
    );
  }
  const body = clampMultiline(issue.description, 20_000);
  const comments = issue.comments?.nodes ?? [];
  return {
    ...(clampText(issue.title, 300)
      ? { title: clampText(issue.title, 300) }
      : {}),
    ...(body ? { body } : {}),
    ...(issue.state?.name ? { state: issue.state.name } : {}),
    ...(issue.creator?.name ? { author: issue.creator.name } : {}),
    ...(issue.assignee?.name ? { assignee: issue.assignee.name } : {}),
    ...(clampText(issue.url, 500) ? { url: issue.url } : {}),
    ...(isoOrUndefined(issue.updatedAt)
      ? { updatedAt: isoOrUndefined(issue.updatedAt) }
      : {}),
    comments: comments.slice(0, 30).map((comment) => ({
      id: String(comment.id ?? comment.createdAt ?? ""),
      ...(comment.user?.name ? { author: comment.user.name } : {}),
      body: clampMultiline(comment.body, 6_000) ?? "",
      ...(isoOrUndefined(comment.createdAt)
        ? { createdAt: isoOrUndefined(comment.createdAt) }
        : {}),
    })),
    ...(issue.comments?.pageInfo?.hasNextPage ||
    (body && body.length >= 20_000)
      ? { truncated: true }
      : {}),
  };
}

export const linearAdapter: ConnectorAdapter = {
  provider: "linear",
  label: LABEL,

  async fetch(ctx) {
    const result = await fetchIssues(ctx);
    return {
      items: result.items,
      complete: result.complete,
      accountName: result.accountName,
    };
  },

  detail(ctx, input) {
    return fetchLinearDetail(ctx, input);
  },

  async test(ctx): Promise<ConnectorTestResult> {
    const result = await fetchIssues(ctx);
    return {
      accountName: result.accountName,
      itemCount: result.items.length,
    };
  },
};
