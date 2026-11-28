/**
 * GitHub 通知 adapter：GET /notifications（只取未读）。
 *
 * 默认只收需要动作的 reason：assign / review_requested / mention / team_mention。
 * 不做写操作（不替用户在 GitHub 上标记已读），打开链接后由 GitHub 自己在
 * 下一次同步时把通知移出未读集合。
 */
import type {
  InboxExternalCheck,
  InboxExternalChecks,
  InboxExternalDetail,
  InboxExternalDiff,
  InboxExternalDiffFile,
  InboxExternalPullRequest,
  InboxPullRequestAction,
} from "pi-protocol";
import type { ExternalNotification } from "../types";
import type {
  ConnectorAdapter,
  ConnectorFetchContext,
  ConnectorSource,
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

function nextLink(
  res: { headers: Record<string, string> },
  expectedBase?: string,
): string | null {
  const link = res.headers.link;
  if (!link) return null;
  const match = /<([^>]+)>;\s*rel="next"/i.exec(link);
  const next = match?.[1];
  if (!next) return null;
  // Link 头由服务端控制；只跟随同一 api base 的下一页，避免把 Token 带到
  // 第三方域名（electronHttp 的同源重定向策略只覆盖 3xx，不覆盖直接请求）。
  if (expectedBase) {
    try {
      const a = new URL(next);
      const b = new URL(expectedBase);
      if (a.protocol !== b.protocol || a.host !== b.host) return null;
    } catch {
      return null;
    }
  }
  return next;
}

/** Link 头是否声明还有下一页（即使我们因跨域拒绝跟随）。 */
function hasNextLink(res: { headers: Record<string, string> }): boolean {
  return /rel="next"/i.test(res.headers.link ?? "");
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
    const next = nextLink(res, apiBase);
    if (!next) {
      // 有 next 但被安全策略拒绝（跨域）时不能当作“拉全了”，否则 sidecar 会
      // 把本次未返回的条目结算掉。
      complete = !hasNextLink(res);
      break;
    }
    url = next;
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

type GhPullDetail = GhIssueDetail & {
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

type GhReview = {
  user?: GhUser;
  state?: string;
  submitted_at?: string;
};

type GhPullFile = {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  binary?: boolean;
};

type GhCheckRun = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
  app?: { name?: string };
};

type GhCheckRunsPage = {
  total_count?: number;
  check_runs?: GhCheckRun[];
};

type GhStatusEntry = {
  context?: string;
  state?: string;
  description?: string;
  target_url?: string;
};

type GhCombinedStatus = {
  state?: string;
  statuses?: GhStatusEntry[];
};

type GhComment = {
  id?: number;
  body?: string | null;
  user?: GhUser;
  created_at?: string;
  html_url?: string;
};

function mapGithubComment(
  comment: GhComment,
  replyToId?: string,
): import("pi-protocol").InboxExternalComment {
  return {
    id: replyToId
      ? `review:${replyToId}`
      : String(
          comment.id ??
            `${comment.created_at ?? ""}:${comment.user?.login ?? ""}`,
        ),
    ...(comment.user?.login ? { author: comment.user.login } : {}),
    ...(comment.user?.avatar_url && safeHttpUrl(comment.user.avatar_url)
      ? { avatarUrl: comment.user.avatar_url }
      : {}),
    body: clampMultiline(comment.body ?? undefined, 6_000) ?? "",
    ...(isoOrUndefined(comment.created_at)
      ? { createdAt: isoOrUndefined(comment.created_at) }
      : {}),
    ...(safeHttpUrl(comment.html_url) ? { url: comment.html_url } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
}

function parseGithubKey(key: string): { repo: string; number: string } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(key.trim());
  return match ? { repo: match[1], number: match[2] } : null;
}

/**
 * 从 reviews 汇总「最近评审结论」，口径与 GitHub 的 reviewDecision 接近：
 * 每个用户只取最后一次有效评审；有任何 changes_requested 优先，其次 approved。
 * 只用于展示，不宣称与平台分支保护规则完全一致。
 */
function reviewDecisionOf(reviews: GhReview[]): string | undefined {
  const latest = new Map<string, string>();
  const ordered = [...reviews].sort(
    (a, b) =>
      (Date.parse(a.submitted_at ?? "") || 0) -
      (Date.parse(b.submitted_at ?? "") || 0),
  );
  for (const review of ordered) {
    const login = review.user?.login?.trim();
    const state = (review.state ?? "").toUpperCase();
    if (!login) continue;
    if (state === "DISMISSED") {
      latest.delete(login);
      continue;
    }
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
    latest.set(login, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return reviews.length > 0 ? "review_required" : undefined;
}

function pullRequestOf(item: GhPullDetail, reviews: GhReview[]): InboxExternalPullRequest {
  const reviewDecision = reviewDecisionOf(reviews);
  return {
    ...(item.base?.ref ? { baseRef: item.base.ref } : {}),
    ...(item.head?.ref ? { headRef: item.head.ref } : {}),
    ...(item.head?.sha ? { headSha: item.head.sha } : {}),
    ...(typeof item.draft === "boolean" ? { draft: item.draft } : {}),
    ...(typeof item.merged === "boolean" ? { merged: item.merged } : {}),
    ...(item.mergeable !== undefined ? { mergeable: item.mergeable } : {}),
    ...(item.mergeable_state ? { mergeableState: item.mergeable_state } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(Number.isFinite(Number(item.additions))
      ? { additions: Number(item.additions) }
      : {}),
    ...(Number.isFinite(Number(item.deletions))
      ? { deletions: Number(item.deletions) }
      : {}),
    ...(Number.isFinite(Number(item.changed_files))
      ? { changedFiles: Number(item.changed_files) }
      : {}),
  };
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
  const item = parseJson<GhPullDetail>(issueRes, LABEL);

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

  // PR review comments（inline）是另一套端点；合并进评论列表才能回复线程
  let reviewComments: GhComment[] = [];
  if (isPr) {
    try {
      const reviewCommentsRes = await ctx.http({
        url: `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}/comments?per_page=30`,
        headers: headers(ctx.token),
        timeoutMs: 15_000,
      });
      assertOk(reviewCommentsRes, { label: LABEL });
      const parsedReviewComments = parseJson<unknown>(reviewCommentsRes, LABEL);
      if (Array.isArray(parsedReviewComments)) {
        reviewComments = parsedReviewComments as GhComment[];
      }
    } catch {
      reviewComments = [];
    }
  }

  // 评审结论也是可选信息：PR 才有 /reviews；失败不影响正文
  let reviews: GhReview[] = [];
  if (isPr) {
    try {
      const reviewsRes = await ctx.http({
        url: `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}/reviews?per_page=100`,
        headers: headers(ctx.token),
        timeoutMs: 15_000,
      });
      assertOk(reviewsRes, { label: LABEL });
      const parsedReviews = parseJson<unknown>(reviewsRes, LABEL);
      if (Array.isArray(parsedReviews)) reviews = parsedReviews as GhReview[];
    } catch {
      reviews = [];
    }
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
    ...(isPr ? { pullRequest: pullRequestOf(item, reviews) } : {}),
    ...(safeHttpUrl(item.html_url) ? { url: item.html_url } : {}),
    ...(isoOrUndefined(item.updated_at)
      ? { updatedAt: isoOrUndefined(item.updated_at) }
      : {}),
    comments: [
      ...comments.map((comment) => mapGithubComment(comment)),
      ...reviewComments.map((comment) =>
        mapGithubComment(comment, comment.id ? String(comment.id) : undefined),
      ),
    ]
      .sort(
        (a, b) =>
          (Date.parse(a.createdAt ?? "") || 0) -
          (Date.parse(b.createdAt ?? "") || 0),
      )
      .slice(0, 60),
    ...(body && body.length >= 20_000
      ? { truncated: true }
      : {}),
    ...(comments.length + reviewComments.length > 60
      ? { truncated: true }
      : {}),
  };
}

const DIFF_PAGE_SIZE = 100;
const MAX_DIFF_PAGES = 3;
/** diff 全量上限：1.5M 字符足够覆盖常规 PR，避免把主进程/渲染层拖死 */
const MAX_DIFF_CHARS = 1_500_000;

function patchBlockOf(file: GhPullFile): { text: string; binary: boolean } {
  const path = file.filename?.trim() ?? "";
  if (!path) return { text: "", binary: true };
  const previous = file.previous_filename?.trim() || path;
  const status = (file.status ?? "modified").toLowerCase();
  // GitHub 对二进制文件不给 patch，也没有独立 binary 字段；纯 rename 同样
  // 没有 patch。用 status 区分：rename 保留文件头，其余无 patch 视为不可展开。
  const binary =
    file.binary === true ||
    (typeof file.patch !== "string" && status !== "renamed");
  const lines = [`diff --git a/${previous} b/${path}`];
  if (status === "added") lines.push("new file mode 100644");
  else if (status === "removed") lines.push("deleted file mode 100644");
  else if (status === "renamed") {
    lines.push(`rename from ${previous}`, `rename to ${path}`);
  }
  if (status === "added") lines.push("--- /dev/null", `+++ b/${path}`);
  else if (status === "removed") lines.push(`--- a/${previous}`, "+++ /dev/null");
  else lines.push(`--- a/${previous}`, `+++ b/${path}`);
  if (binary) {
    lines.push(`Binary files a/${previous} and b/${path} differ`);
    return { text: `${lines.join("\n")}\n`, binary: true };
  }
  const patch = file.patch?.endsWith("\n")
    ? file.patch
    : `${file.patch ?? ""}\n`;
  return { text: `${lines.join("\n")}\n${patch}`, binary: false };
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

async function fetchGithubPullRequestDiff(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string },
): Promise<InboxExternalDiff> {
  if (input.type && input.type !== "pull_request") {
    throw new ConnectorError("config", `${LABEL}：仅 Pull Request 支持代码差异`);
  }
  const parsed = parseGithubKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 owner/repo#123）`,
    );
  }
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  let url: string | null =
    `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}/files?per_page=${DIFF_PAGE_SIZE}`;
  const files: InboxExternalDiffFile[] = [];
  const chunks: string[] = [];
  let chars = 0;
  let truncated = false;

  for (let page = 0; page < MAX_DIFF_PAGES && url; page += 1) {
    const res = await ctx.http({
      url,
      headers: headers(ctx.token),
      timeoutMs: 20_000,
      // 100 个文件的 patch 可能超过默认 4MB；放宽到 12MB，再由 MAX_DIFF_CHARS 截断
      maxBytes: 12 * 1024 * 1024,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 无效或权限不足（需要读取该仓库 PR 的权限）",
      configHint: "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
      notFoundHint: "Pull Request 不存在或无权访问（可能已被删除）",
    });
    const parsedRows = parseJson<unknown>(res, LABEL);
    if (!Array.isArray(parsedRows)) {
      throw new ConnectorError(
        "config",
        `${LABEL}：PR 文件列表返回格式异常：${errorSnippet(res.text)}`,
      );
    }
    for (const raw of parsedRows as GhPullFile[]) {
      const path = raw.filename?.trim();
      if (!path) continue;
      const block = patchBlockOf(raw);
      files.push({
        path,
        ...(raw.previous_filename
          ? { previousPath: raw.previous_filename }
          : {}),
        additions: numberOrZero(raw.additions),
        deletions: numberOrZero(raw.deletions),
        ...(block.binary ? { binary: true } : {}),
      });
      if (!block.text) continue;
      if (chars + block.text.length > MAX_DIFF_CHARS) {
        truncated = true;
        continue;
      }
      chunks.push(block.text);
      chars += block.text.length;
    }
    url = nextLink(res, apiBase);
    if (hasNextLink(res) && !url) truncated = true;
    if (url && page === MAX_DIFF_PAGES - 1) truncated = true;
  }

  return {
    patch: chunks.join(""),
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}

function checkStateOf(run: GhCheckRun): InboxExternalCheck["state"] {
  if ((run.status ?? "").toLowerCase() !== "completed") return "pending";
  switch ((run.conclusion ?? "").toLowerCase()) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    default:
      return "unknown";
  }
}

function statusStateOf(state: string | undefined): InboxExternalCheck["state"] {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "pass";
    case "pending":
    case "expected":
      return "pending";
    case "failure":
    case "error":
      return "fail";
    default:
      return "unknown";
  }
}

async function resolveGithubHeadSha(
  ctx: ConnectorFetchContext,
  apiBase: string,
  parsed: { repo: string; number: string },
  headSha: string | undefined,
): Promise<string> {
  const provided = headSha?.trim();
  if (provided) return provided;
  const res = await ctx.http({
    url: `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}`,
    headers: headers(ctx.token),
    timeoutMs: 15_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "Token 无效或权限不足（需要读取该仓库 PR 的权限）",
    configHint: "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
    notFoundHint: "Pull Request 不存在或无权访问（可能已被删除）",
  });
  const pull = parseJson<GhPullDetail>(res, LABEL);
  return pull.head?.sha?.trim() ?? "";
}

async function fetchGithubPullRequestChecks(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string; headSha?: string },
): Promise<InboxExternalChecks> {
  if (input.type && input.type !== "pull_request") {
    throw new ConnectorError("config", `${LABEL}：仅 Pull Request 支持检查项`);
  }
  const parsed = parseGithubKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 owner/repo#123）`,
    );
  }
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  const sha = await resolveGithubHeadSha(ctx, apiBase, parsed, input.headSha);
  if (!sha) return { checks: [] };

  const checks: InboxExternalCheck[] = [];
  let truncated = false;
  let totalCount = 0;
  try {
    const runsRes = await ctx.http({
      url: `${apiBase}/repos/${parsed.repo}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`,
      headers: headers(ctx.token),
      timeoutMs: 20_000,
    });
    assertOk(runsRes, { label: LABEL });
    const page = parseJson<GhCheckRunsPage>(runsRes, LABEL);
    totalCount = numberOrZero(page.total_count);
    truncated = totalCount > 100;
    for (const run of page.check_runs ?? []) {
      const name = clampText(run.name, 160);
      if (!name) continue;
      const output = [run.output?.title, run.output?.summary, run.output?.text]
        .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
        .join("\n\n");
      checks.push({
        name,
        ...(clampText(run.app?.name, 80) ? { workflow: clampText(run.app?.name, 80) } : {}),
        state: checkStateOf(run),
        ...(safeHttpUrl(run.details_url ?? undefined)
          ? { detailsUrl: run.details_url }
          : {}),
        ...(clampMultiline(output || undefined, 6_000)
          ? { output: clampMultiline(output || undefined, 6_000) }
          : {}),
      });
    }
  } catch (error) {
    // Actions/Checks 权限缺失（403）或仓库未启用 checks（404）时，仍可展示
    // commit status；其余错误（Token 失效/网络/5xx）照常上抛。
    if (!ignoreCheckRunsError(error)) throw error;
  }

  try {
    const statusRes = await ctx.http({
      url: `${apiBase}/repos/${parsed.repo}/commits/${encodeURIComponent(sha)}/status`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(statusRes, { label: LABEL });
    const combined = parseJson<GhCombinedStatus>(statusRes, LABEL);
    const existing = new Set(checks.map((check) => check.name.toLowerCase()));
    for (const entry of combined.statuses ?? []) {
      const name = clampText(entry.context, 160);
      if (!name || existing.has(name.toLowerCase())) continue;
      checks.push({
        name,
        workflow: "Status",
        state: statusStateOf(entry.state),
        ...(clampText(entry.description, 240)
          ? { description: clampText(entry.description, 240) }
          : {}),
        ...(safeHttpUrl(entry.target_url)
          ? { detailsUrl: entry.target_url }
          : {}),
      });
    }
  } catch (error) {
    // commit status 是补充信息：无 Actions 权限/未启用 checks 时可以只展示
    // check-runs；限流、网络、5xx、Token 失效继续上抛。
    if (!ignoreCheckRunsError(error)) throw error;
  }

  return {
    headSha: sha,
    checks,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * check-runs/commit status 的 403/404 降级条件：
 * - 403 无 Actions 权限、404 未启用 checks 时允许只展示另一半数据；
 * - 403 限流（code=rate_limit）必须上抛，不能伪装成「没有检查项」；
 * - 401 Token 失效同样上抛。
 */
function ignoreCheckRunsError(error: unknown): boolean {
  if (!(error instanceof ConnectorError)) return false;
  if (error.code === "rate_limit") return false;
  return error.status === 403 || error.status === 404;
}

function writeHeaders(token: string): Record<string, string> {
  return { ...headers(token), "Content-Type": "application/json" };
}

async function postGithubComment(
  ctx: ConnectorFetchContext,
  input: {
    key: string;
    type?: string;
    body: string;
    replyToId?: string;
  },
): Promise<void> {
  const parsed = parseGithubKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 owner/repo#123）`,
    );
  }
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  const isPr = input.type === "pull_request";
  let url: string;
  if (isPr && input.replyToId) {
    if (!/^\d+$/.test(input.replyToId)) {
      throw new ConnectorError("config", `${LABEL}：回复评论 id 无效`);
    }
    url = `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}/comments/${input.replyToId}/replies`;
  } else {
    // issue 评论接口同时适用于 PR 的普通评论
    url = `${apiBase}/repos/${parsed.repo}/issues/${parsed.number}/comments`;
  }
  const res = await ctx.http({
    url,
    method: "POST",
    headers: writeHeaders(ctx.token),
    body: JSON.stringify({ body: input.body }),
    timeoutMs: 20_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "Token 需要 Issue/PR 写权限（Classic PAT 勾选 repo）",
    configHint: "评论接口不可用，请检查仓库权限或接口地址",
    notFoundHint: "Issue/PR 不存在、已关闭或无权评论",
  });
}

async function runGithubPullRequestAction(
  ctx: ConnectorFetchContext,
  input: {
    key: string;
    type?: string;
    action: InboxPullRequestAction;
    headSha?: string;
  },
): Promise<void> {
  if (input.type && input.type !== "pull_request") {
    throw new ConnectorError("config", `${LABEL}：仅 Pull Request 支持该操作`);
  }
  const parsed = parseGithubKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 owner/repo#123）`,
    );
  }
  const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
  const pullUrl = `${apiBase}/repos/${parsed.repo}/pulls/${parsed.number}`;
  let url = pullUrl;
  let method: "POST" | "PUT" | "PATCH" = "PATCH";
  let body: Record<string, unknown> | undefined;
  switch (input.action) {
    case "merge":
    case "squash":
    case "rebase":
      url = `${pullUrl}/merge`;
      method = "PUT";
      body = {
        merge_method: input.action,
        ...(input.headSha ? { sha: input.headSha } : {}),
      };
      break;
    case "close":
      method = "PATCH";
      body = { state: "closed" };
      break;
    case "reopen":
      method = "PATCH";
      body = { state: "open" };
      break;
    case "ready_for_review":
      url = `${pullUrl}/ready_for_review`;
      method = "POST";
      body = undefined;
      break;
  }
  try {
    const res = await ctx.http({
      url,
      method,
      headers: writeHeaders(ctx.token),
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 20_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 需要 PR 写权限（Classic PAT 勾选 repo）",
      configHint: "PR 操作接口不可用，请检查接口地址",
      notFoundHint: "Pull Request 不存在或无权操作",
    });
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      (error.status === 405 || error.status === 409 || error.status === 422)
    ) {
      throw new ConnectorError(
        "http",
        `${LABEL}：操作被拒绝（HTTP ${error.status}），请检查 PR 是否存在冲突、是否受分支保护、head 是否已更新或状态是否允许该操作`,
        error.status,
      );
    }
    throw error;
  }
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

  pullRequestDiff(ctx, input) {
    return fetchGithubPullRequestDiff(ctx, input);
  },

  pullRequestChecks(ctx, input) {
    return fetchGithubPullRequestChecks(ctx, input);
  },

  postComment(ctx, input) {
    return postGithubComment(ctx, input);
  },

  pullRequestAction(ctx, input) {
    return runGithubPullRequestAction(ctx, input);
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

  async listSources(ctx): Promise<ConnectorSource[]> {
    const apiBase = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE, LABEL);
    // membership 缺省含 owner/collaborator/organization_member：Token 可见的
    // 仓库全集，full_name 与通知条目的 sourceName（repo）同口径
    const res = await ctx.http({
      url: `${apiBase}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
      headers: headers(ctx.token),
      timeoutMs: 15_000,
    });
    assertOk(res, {
      label: LABEL,
      authHint: "Token 无效或权限不足（需要 repo 只读权限）",
      configHint: "接口地址不可用，GitHub Enterprise 请填 https://host/api/v3",
    });
    const parsed = parseJson<unknown>(res, LABEL);
    if (!Array.isArray(parsed)) return [];
    const out: ConnectorSource[] = [];
    for (const row of parsed as Array<{ full_name?: string; name?: string; description?: string | null }>) {
      const id = clampText(row.full_name, 160);
      if (!id) continue;
      out.push({ id, ...(row.name && row.name !== id ? { label: clampText(row.name, 160) } : {}) });
    }
    return out;
  },
};
