/**
 * Jira adapter：JQL 拉「指派给我且未完成」的 Issue。
 *
 * - Cloud：邮箱 + API Token（Basic），优先新版 /rest/api/3/search/jql，
 *   404/410 时回退 /rest/api/2/search；
 * - Server/DC：Personal Access Token（Bearer），直接用 v2 search。
 * - 只读；不做状态流转/评论。
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
  hostOf,
  isoOrUndefined,
  normalizeBaseUrl,
  summaryLine,
} from "../normalize";

const LABEL = "Jira";
const DEFAULT_JQL =
  "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "project",
  "created",
  "updated",
].join(",");
const MAX_RESULTS = 50;
const MAX_PAGES = 2;

type JiraIssue = {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
    project?: { key?: string; name?: string };
    created?: string;
    updated?: string;
  };
};

type JiraSearchV2 = {
  issues?: JiraIssue[];
  total?: number;
  startAt?: number;
  maxResults?: number;
};

type JiraSearchV3 = {
  issues?: JiraIssue[];
  nextPageToken?: string;
};

type JiraMyself = {
  displayName?: string;
  emailAddress?: string;
};

type JiraAuthMode = "cloud" | "server";

function baseOf(config: { baseUrl?: string }): string {
  const raw = (config.baseUrl ?? "").trim();
  if (!raw) {
    throw new ConnectorError("config", `${LABEL}：请填写站点地址`);
  }
  return normalizeBaseUrl(raw, "", LABEL);
}

function authModeOf(ctx: ConnectorFetchContext): JiraAuthMode {
  if (ctx.config.authMode === "cloud" || ctx.config.authMode === "server") {
    return ctx.config.authMode;
  }
  try {
    return new URL(baseOf(ctx.config)).host.endsWith(".atlassian.net")
      ? "cloud"
      : "server";
  } catch {
    return "cloud";
  }
}

function authHeader(ctx: ConnectorFetchContext): string {
  const mode = authModeOf(ctx);
  if (mode === "server") return `Bearer ${ctx.token}`;
  const email = (ctx.config.account ?? "").trim();
  if (!email) {
    throw new ConnectorError(
      "config",
      `${LABEL} Cloud：请填写登录邮箱（Server/DC 请切换认证方式）`,
    );
  }
  return `Basic ${Buffer.from(`${email}:${ctx.token}`).toString("base64")}`;
}

function headers(ctx: ConnectorFetchContext): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: authHeader(ctx),
    "User-Agent": "Kova-Inbox",
  };
}

function jqlOf(ctx: ConnectorFetchContext): string {
  const custom = (ctx.config.jql ?? "").trim();
  return custom || DEFAULT_JQL;
}

export function mapJiraIssue(
  raw: unknown,
  base: string,
): ExternalNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const issue = raw as JiraIssue;
  const issueKey = clampText(issue.key, 80);
  if (!issueKey) return null;
  const fields = issue.fields ?? {};
  const projectKey = clampText(
    fields.project?.key ?? fields.project?.name,
    120,
  );
  const status = clampText(fields.status?.name, 60);
  const priorityName = clampText(fields.priority?.name, 40);
  return {
    idKey: `${hostOf(base)}/${issueKey}`,
    key: issueKey,
    type: "ticket",
    title:
      clampText(fields.summary, 160) ??
      `${LABEL} ${issueKey}`,
    summary: summaryLine("指派给你", projectKey, status, priorityName),
    url: `${base}/browse/${encodeURIComponent(issueKey)}`,
    status,
    sourceName: projectKey,
    createdAt: isoOrUndefined(fields.created ?? fields.updated),
    requiresAction: true,
    priority: jiraPriority(priorityName),
    reason: "assigned",
  };
}

function jiraPriority(name: string | undefined): 1 | 2 | 3 {
  const value = (name ?? "").toLowerCase();
  if (
    value === "highest" ||
    value === "blocker" ||
    value === "critical" ||
    value === "high"
  ) {
    return 1;
  }
  if (value === "low" || value === "lowest" || value === "trivial") return 3;
  return 2;
}

function v3Url(base: string, jql: string, nextPageToken?: string): string {
  const params = new URLSearchParams({
    jql,
    maxResults: String(MAX_RESULTS),
    fields: FIELDS,
  });
  if (nextPageToken) params.set("nextPageToken", nextPageToken);
  return `${base}/rest/api/3/search/jql?${params.toString()}`;
}

function v2Url(base: string, jql: string, startAt: number): string {
  const params = new URLSearchParams({
    jql,
    startAt: String(startAt),
    maxResults: String(MAX_RESULTS),
    fields: FIELDS,
  });
  return `${base}/rest/api/2/search?${params.toString()}`;
}

async function fetchV3Page(
  ctx: ConnectorFetchContext,
  base: string,
  jql: string,
  nextPageToken?: string,
): Promise<{ rows: JiraIssue[]; nextPageToken?: string; notFound: boolean }> {
  const res = await ctx.http({
    url: v3Url(base, jql, nextPageToken),
    headers: headers(ctx),
    timeoutMs: 15_000,
  });
  if (res.status === 404 || res.status === 410) {
    return { rows: [], notFound: true };
  }
  assertOk(res, {
    label: LABEL,
    authHint:
      "邮箱或 API Token 不正确；Server/DC 请把认证方式切换为 Personal Access Token",
    configHint: "Jira 地址不可用，请检查站点地址",
  });
  const parsed = parseJson<JiraSearchV3>(res, LABEL);
  return {
    rows: Array.isArray(parsed.issues) ? parsed.issues : [],
    nextPageToken:
      typeof parsed.nextPageToken === "string" && parsed.nextPageToken
        ? parsed.nextPageToken
        : undefined,
    notFound: false,
  };
}

async function fetchV2Page(
  ctx: ConnectorFetchContext,
  base: string,
  jql: string,
  startAt: number,
): Promise<{ rows: JiraIssue[]; complete: boolean }> {
  const res = await ctx.http({
    url: v2Url(base, jql, startAt),
    headers: headers(ctx),
    timeoutMs: 15_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint:
      "邮箱或 API Token 不正确；Server/DC 请把认证方式切换为 Personal Access Token",
    configHint: "Jira 地址不可用，请检查站点地址",
  });
  const parsed = parseJson<JiraSearchV2>(res, LABEL);
  const rows = Array.isArray(parsed.issues) ? parsed.issues : [];
  const total = Number(parsed.total);
  const from = Number(parsed.startAt);
  return {
    rows,
    complete:
      Number.isFinite(total) && Number.isFinite(from)
        ? from + rows.length >= total
        : rows.length < MAX_RESULTS,
  };
}

async function fetchIssues(
  ctx: ConnectorFetchContext,
): Promise<{ items: ExternalNotification[]; complete: boolean }> {
  const base = baseOf(ctx.config);
  const jql = jqlOf(ctx);
  const items: ExternalNotification[] = [];
  const seen = new Set<string>();
  let complete = true;

  if (authModeOf(ctx) === "cloud") {
    let nextPageToken: string | undefined;
    let useV2 = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await fetchV3Page(ctx, base, jql, nextPageToken);
      if (result.notFound) {
        useV2 = true;
        break;
      }
      for (const row of result.rows) {
        const item = mapJiraIssue(row, base);
        if (item && !seen.has(item.idKey ?? item.title)) {
          seen.add(item.idKey ?? item.title);
          items.push(item);
        }
      }
      if (!result.nextPageToken) {
        complete = true;
        break;
      }
      nextPageToken = result.nextPageToken;
      if (page === MAX_PAGES - 1) complete = false;
    }
    if (!useV2) return { items, complete };
    // v3 不存在：从头走 v2，避免只拿到半页
    items.length = 0;
    seen.clear();
  }

  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchV2Page(ctx, base, jql, startAt);
    for (const row of result.rows) {
      const item = mapJiraIssue(row, base);
      if (item && !seen.has(item.idKey ?? item.title)) {
        seen.add(item.idKey ?? item.title);
        items.push(item);
      }
    }
    if (result.complete) {
      complete = true;
      break;
    }
    startAt += result.rows.length;
    if (page === MAX_PAGES - 1) complete = false;
    if (result.rows.length === 0) break;
  }
  return { items, complete };
}

type JiraIssueDetail = {
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    assignee?: { displayName?: string };
    reporter?: { displayName?: string };
    labels?: string[];
    updated?: string;
  };
};

type JiraComment = {
  id?: string;
  body?: unknown;
  author?: { displayName?: string };
  created?: string;
};

type JiraCommentPage = {
  comments?: JiraComment[];
  total?: number;
};

/** Jira Cloud v3 的富文本是 ADF；把常见节点转成可读 Markdown/纯文本。 */
function adfNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as {
    type?: string;
    text?: string;
    content?: unknown[];
    attrs?: Record<string, unknown>;
  };
  const children = Array.isArray(n.content)
    ? n.content.map(adfNode).join("")
    : "";
  switch (n.type) {
    case "text":
      return n.text ?? "";
    case "hardBreak":
      return "\n";
    case "paragraph":
      return `${children}\n\n`;
    case "heading":
      return `## ${children.trim()}\n\n`;
    case "bulletList":
      return `${(n.content ?? [])
        .map((item) => `- ${adfNode(item).trim()}`)
        .join("\n")}\n\n`;
    case "orderedList":
      return `${(n.content ?? [])
        .map((item, index) => `${index + 1}. ${adfNode(item).trim()}`)
        .join("\n")}\n\n`;
    case "listItem":
      return children;
    case "codeBlock":
      return `\`\`\`\n${children.trim()}\n\`\`\`\n\n`;
    case "blockquote":
      return `> ${children.trim().replace(/\n/g, "\n> ")}\n\n`;
    case "mention":
      return `@${String(n.attrs?.text ?? "")}`;
    case "inlineCard":
      return String(n.attrs?.url ?? "");
    case "mediaSingle":
    case "media":
      return "[图片]\n";
    case "rule":
      return "---\n\n";
    default:
      return children;
  }
}

function jiraRichText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const text = adfNode(value).trim();
  return text || undefined;
}

async function fetchJiraDetail(
  ctx: ConnectorFetchContext,
  input: { key: string },
): Promise<InboxExternalDetail> {
  const issueKey = input.key.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) {
    throw new ConnectorError("config", `${LABEL}：无法解析 Issue 编号`);
  }
  const base = baseOf(ctx.config);
  const requestHeaders = headers(ctx);

  const issueRes = await ctx.http({
    url: `${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,assignee,reporter,labels,updated`,
    headers: requestHeaders,
    timeoutMs: 15_000,
  });
  assertOk(issueRes, {
    label: LABEL,
    authHint:
      "邮箱或 API Token 不正确；Server/DC 请把认证方式切换为 Personal Access Token",
    configHint: "Jira 地址不可用，请检查站点地址",
    notFoundHint: "Issue 不存在或无权访问（可能已被删除，或 JQL 已失效）",
  });
  const issue = parseJson<JiraIssueDetail>(issueRes, LABEL);
  const fields = issue.fields ?? {};

  let comments: JiraComment[] = [];
  let commentTotal = 0;
  try {
    const commentsRes = await ctx.http({
      url: `${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?maxResults=30&orderBy=created`,
      headers: requestHeaders,
      timeoutMs: 15_000,
    });
    assertOk(commentsRes, { label: LABEL });
    const page = parseJson<JiraCommentPage>(commentsRes, LABEL);
    comments = Array.isArray(page.comments) ? page.comments : [];
    commentTotal = Number(page.total ?? comments.length);
  } catch {
    comments = [];
  }

  const body = clampMultiline(
    jiraRichText(fields.description),
    20_000,
  );
  return {
    ...(clampText(fields.summary, 300)
      ? { title: clampText(fields.summary, 300) }
      : {}),
    ...(body ? { body } : {}),
    ...(fields.status?.name ? { state: fields.status.name } : {}),
    ...(fields.reporter?.displayName
      ? { author: fields.reporter.displayName }
      : {}),
    ...(fields.assignee?.displayName
      ? { assignee: fields.assignee.displayName }
      : {}),
    ...(Array.isArray(fields.labels) && fields.labels.length
      ? {
          labels: fields.labels
            .map((label) => clampText(label, 60))
            .filter((label): label is string => Boolean(label))
            .slice(0, 10),
        }
      : {}),
    url: `${base}/browse/${encodeURIComponent(issueKey)}`,
    ...(isoOrUndefined(fields.updated)
      ? { updatedAt: isoOrUndefined(fields.updated) }
      : {}),
    comments: comments.slice(0, 30).map((comment, index) => ({
      id: String(comment.id ?? index),
      ...(comment.author?.displayName
        ? { author: comment.author.displayName }
        : {}),
      body: clampMultiline(jiraRichText(comment.body), 6_000) ?? "",
      ...(isoOrUndefined(comment.created)
        ? { createdAt: isoOrUndefined(comment.created) }
        : {}),
    })),
    ...(commentTotal > 30 || (body && body.length >= 20_000)
      ? { truncated: true }
      : {}),
  };
}

export const jiraAdapter: ConnectorAdapter = {
  provider: "jira",
  label: LABEL,

  async fetch(ctx) {
    const result = await fetchIssues(ctx);
    return { items: result.items, complete: result.complete };
  },

  detail(ctx, input) {
    return fetchJiraDetail(ctx, input);
  },

  async test(ctx): Promise<ConnectorTestResult> {
    const base = baseOf(ctx.config);
    const res = await ctx.http({
      url: `${base}/rest/api/2/myself`,
      headers: headers(ctx),
      timeoutMs: 15_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint:
        "邮箱或 API Token 不正确；Server/DC 请把认证方式切换为 Personal Access Token",
      configHint: "Jira 地址不可用，请检查站点地址",
    });
    const me = parseJson<JiraMyself>(res, LABEL);
    let itemCount: number | undefined;
    try {
      const result = await fetchIssues(ctx);
      itemCount = result.items.length;
    } catch (error) {
      // 账号能登录但 JQL/搜索接口失败：把原因带出来，测试连接不能只报“成功”
      throw error instanceof ConnectorError
        ? error
        : new ConnectorError(
            "http",
            `${LABEL}：搜索接口失败：${errorSnippet(String(error))}`,
          );
    }
    return {
      accountName: clampText(me.displayName ?? me.emailAddress, 80),
      itemCount,
    };
  },
};
