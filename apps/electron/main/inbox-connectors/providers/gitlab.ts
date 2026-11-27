/**
 * GitLab 待办 adapter：GET /api/v4/todos?state=pending（只取未完成待办）。
 *
 * Todos 天然覆盖 assigned / review_requested / mentioned / directly_addressed /
 * unmergeable / build_failed；默认屏蔽 build_failed 与 marked，避免流水线刷屏。
 */
import type {
  InboxExternalCheck,
  InboxExternalChecks,
  InboxExternalDetail,
  InboxExternalDiff,
  InboxExternalDiffFile,
  InboxPullRequestAction,
} from "pi-protocol";
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
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  changes_count?: string;
  squash?: boolean;
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
  const mergeStatus = item.detailed_merge_status ?? item.merge_status ?? "";
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
    ...(kind === "merge_requests"
      ? {
          pullRequest: {
            ...(item.target_branch ? { baseRef: item.target_branch } : {}),
            ...(item.source_branch ? { headRef: item.source_branch } : {}),
            ...(item.sha ? { headSha: item.sha } : {}),
            ...(typeof item.draft === "boolean"
              ? { draft: item.draft }
              : typeof item.work_in_progress === "boolean"
                ? { draft: item.work_in_progress }
                : {}),
            ...(item.has_conflicts === true || mergeStatus === "conflict"
              ? { mergeable: false }
              : mergeStatus === "mergeable" ||
                  mergeStatus === "can_be_merged"
                ? { mergeable: true }
                : {}),
            ...(mergeStatus ? { mergeableState: mergeStatus } : {}),
            ...(Number.isFinite(Number.parseInt(item.changes_count ?? "", 10))
              ? { changedFiles: Number.parseInt(item.changes_count ?? "", 10) }
              : {}),
          },
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

const MAX_DIFF_CHARS = 1_500_000;

type GitlabChange = {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  too_large?: boolean;
  diff?: string;
};

type GitlabChanges = {
  changes?: GitlabChange[];
  overflow?: boolean;
};

type GitlabPipeline = {
  id?: number;
  status?: string;
  web_url?: string;
  sha?: string;
};

type GitlabJob = {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  web_url?: string;
  allow_failure?: boolean;
};

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function gitlabPatchBlock(change: GitlabChange): {
  text: string;
  binary: boolean;
  file: InboxExternalDiffFile;
} {
  const oldPath = change.old_path ?? change.new_path ?? "";
  const newPath = change.new_path ?? oldPath;
  const newFile = change.new_file === true;
  const deleted = change.deleted_file === true;
  const renamed = change.renamed_file === true;
  const diff = typeof change.diff === "string" ? change.diff : "";
  const binary =
    change.too_large === true ||
    /^Binary files /m.test(diff) ||
    (!diff && !newFile && !deleted && !renamed);

  const lines = [`diff --git a/${oldPath} b/${newPath}`];
  if (newFile) lines.push("new file mode 100644");
  else if (deleted) lines.push("deleted file mode 100644");
  else if (renamed) lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  if (newFile) lines.push("--- /dev/null", `+++ b/${newPath}`);
  else if (deleted) lines.push(`--- a/${oldPath}`, "+++ /dev/null");
  else lines.push(`--- a/${oldPath}`, `+++ b/${newPath}`);

  if (binary) {
    lines.push(`Binary files a/${oldPath} and b/${newPath} differ`);
  } else {
    lines.push(diff.endsWith("\n") ? diff.slice(0, -1) : diff);
  }
  const counts = binary
    ? { additions: 0, deletions: 0 }
    : countDiffLines(diff);
  return {
    text: `${lines.join("\n")}\n`,
    binary,
    file: {
      path: newPath,
      ...(renamed && oldPath ? { previousPath: oldPath } : {}),
      ...counts,
      ...(binary ? { binary: true } : {}),
    },
  };
}

async function fetchGitlabPullRequestDiff(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string },
): Promise<InboxExternalDiff> {
  const parsed = parseGitlabKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 group/project!123）`,
    );
  }
  const kind =
    input.type === "merge_request" ? "merge_requests" : parsed.kind;
  if (kind !== "merge_requests") {
    throw new ConnectorError("config", `${LABEL}：仅 Merge Request 支持代码差异`);
  }
  const api = apiBase(ctx.config);
  const projectPath = encodeURIComponent(parsed.path);
  const res = await ctx.http({
    url: `${api}/projects/${projectPath}/merge_requests/${parsed.iid}/changes`,
    headers: headers(ctx.token),
    timeoutMs: 20_000,
    // 大 MR 的 changes 载荷可能超过默认 4MB；放宽到 12MB，再由 MAX_DIFF_CHARS 截断
    maxBytes: 12 * 1024 * 1024,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "Token 无效或权限不足（需要 read_api）",
    configHint: "GitLab 地址不可用，请检查服务器地址",
    notFoundHint: "Merge Request 不存在或无权访问（可能已被删除）",
  });
  const page = parseJson<GitlabChanges>(res, LABEL);
  const files: InboxExternalDiffFile[] = [];
  const chunks: string[] = [];
  let chars = 0;
  let truncated = page.overflow === true;

  for (const change of page.changes ?? []) {
    const block = gitlabPatchBlock(change);
    files.push(block.file);
    if (chars + block.text.length > MAX_DIFF_CHARS) {
      truncated = true;
      continue;
    }
    chunks.push(block.text);
    chars += block.text.length;
  }

  return {
    patch: chunks.join(""),
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}

function gitlabJobState(status: string | undefined): InboxExternalCheck["state"] {
  switch ((status ?? "").toLowerCase()) {
    case "success":
      return "pass";
    case "failed":
      return "fail";
    case "canceled":
    case "cancelling":
      return "cancel";
    case "skipped":
      return "skipping";
    case "running":
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
    case "manual":
      return "pending";
    default:
      return "unknown";
  }
}

async function resolveGitlabHeadSha(
  ctx: ConnectorFetchContext,
  api: string,
  projectPath: string,
  iid: string,
  headSha: string | undefined,
): Promise<string> {
  const provided = headSha?.trim();
  if (provided) return provided;
  const res = await ctx.http({
    url: `${api}/projects/${projectPath}/merge_requests/${iid}`,
    headers: headers(ctx.token),
    timeoutMs: 15_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "Token 无效或权限不足（需要 read_api）",
    configHint: "GitLab 地址不可用，请检查服务器地址",
    notFoundHint: "Merge Request 不存在或无权访问（可能已被删除）",
  });
  const detail = parseJson<GitlabTodoDetail>(res, LABEL);
  return detail.sha?.trim() ?? "";
}

async function fetchGitlabPullRequestChecks(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string; headSha?: string },
): Promise<InboxExternalChecks> {
  const parsed = parseGitlabKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 group/project!123）`,
    );
  }
  const kind =
    input.type === "merge_request" ? "merge_requests" : parsed.kind;
  if (kind !== "merge_requests") {
    throw new ConnectorError("config", `${LABEL}：仅 Merge Request 支持检查项`);
  }
  const api = apiBase(ctx.config);
  const projectPath = encodeURIComponent(parsed.path);
  const sha = await resolveGitlabHeadSha(
    ctx,
    api,
    projectPath,
    parsed.iid,
    input.headSha,
  );

  const pipelinesRes = await ctx.http({
    url: `${api}/projects/${projectPath}/merge_requests/${parsed.iid}/pipelines?per_page=1&order_by=updated_at&sort=desc`,
    headers: headers(ctx.token),
    timeoutMs: 15_000,
  });
  assertOk(pipelinesRes, {
    label: LABEL,
    authHint: "Token 无效或权限不足（需要 read_api）",
    notFoundHint: "Merge Request 不存在或无权访问（可能已被删除）",
  });
  const pipelines = parseJson<unknown>(pipelinesRes, LABEL);
  if (!Array.isArray(pipelines) || pipelines.length === 0) {
    return { headSha: sha || undefined, checks: [] };
  }
  const pipeline = pipelines[0] as GitlabPipeline;
  const pipelineId = Number(pipeline.id);
  if (!Number.isFinite(pipelineId)) {
    return { headSha: sha || undefined, checks: [] };
  }

  const jobsRes = await ctx.http({
    url: `${api}/projects/${projectPath}/pipelines/${Math.trunc(pipelineId)}/jobs?per_page=100&include_retried=false`,
    headers: headers(ctx.token),
    timeoutMs: 20_000,
  });
  assertOk(jobsRes, { label: LABEL });
  const jobs = parseJson<unknown>(jobsRes, LABEL);
  const rows = Array.isArray(jobs) ? (jobs as GitlabJob[]) : [];
  const checks: InboxExternalCheck[] = rows
    .map((job) => {
      const name = clampText(job.name, 160);
      if (!name) return null;
      return {
        name,
        ...(clampText(job.stage, 80) ? { workflow: clampText(job.stage, 80) } : {}),
        state: gitlabJobState(job.status),
        ...(safeHttpUrl(job.web_url) ? { detailsUrl: job.web_url } : {}),
      } satisfies InboxExternalCheck;
    })
    .filter((entry): entry is InboxExternalCheck => entry !== null);

  // 没有 job 明细时至少展示 pipeline 自身状态
  if (checks.length === 0) {
    checks.push({
      name: "Pipeline",
      workflow: "GitLab CI",
      state: gitlabJobState(pipeline.status),
      ...(safeHttpUrl(pipeline.web_url) ? { detailsUrl: pipeline.web_url } : {}),
    });
  }

  return {
    headSha: sha || undefined,
    checks,
    ...(rows.length >= 100 ? { truncated: true } : {}),
  };
}

async function postGitlabComment(
  ctx: ConnectorFetchContext,
  input: { key: string; type?: string; body: string },
): Promise<void> {
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
  const res = await ctx.http({
    url: `${api}/projects/${projectPath}/${kind}/${parsed.iid}/notes`,
    method: "POST",
    headers: headers(ctx.token),
    body: JSON.stringify({ body: input.body }),
    timeoutMs: 20_000,
  });
  assertOk(res, {
    label: LABEL,
    authHint: "Token 需要 api 权限（写 notes）",
    configHint: "评论接口不可用，请检查服务器地址",
    notFoundHint: "Issue/MR 不存在或无权评论",
  });
}

async function runGitlabPullRequestAction(
  ctx: ConnectorFetchContext,
  input: {
    key: string;
    type?: string;
    action: InboxPullRequestAction;
    headSha?: string;
  },
): Promise<void> {
  const parsed = parseGitlabKey(input.key);
  if (!parsed) {
    throw new ConnectorError(
      "config",
      `${LABEL}：无法解析条目编号（需要 group/project!123）`,
    );
  }
  const kind =
    input.type === "merge_request" ? "merge_requests" : parsed.kind;
  if (kind !== "merge_requests") {
    throw new ConnectorError("config", `${LABEL}：仅 Merge Request 支持该操作`);
  }
  const api = apiBase(ctx.config);
  const projectPath = encodeURIComponent(parsed.path);
  const basePath = `${api}/projects/${projectPath}/merge_requests/${parsed.iid}`;
  try {
    if (input.action === "merge" || input.action === "squash") {
      let previousSquash = false;
      if (input.action === "squash") {
        const beforeRes = await ctx.http({
          url: basePath,
          headers: headers(ctx.token),
          timeoutMs: 15_000,
        });
        assertOk(beforeRes, { label: LABEL });
        previousSquash =
          parseJson<GitlabTodoDetail>(beforeRes, LABEL).squash === true;
        const squashRes = await ctx.http({
          url: basePath,
          method: "PUT",
          headers: headers(ctx.token),
          body: JSON.stringify({ squash: true }),
          timeoutMs: 20_000,
        });
        assertOk(squashRes, { label: LABEL });
      }
      try {
        const mergeRes = await ctx.http({
          url: `${basePath}/merge`,
          method: "PUT",
          headers: headers(ctx.token),
          body: JSON.stringify(
            input.headSha ? { sha: input.headSha } : {},
          ),
          timeoutMs: 20_000,
        });
        assertOk(mergeRes, {
          label: LABEL,
          authHint: "Token 需要 api 权限（写 merge request）",
          notFoundHint: "Merge Request 不存在或无权合并",
        });
      } catch (error) {
        // squash 两步操作：合并失败时尽量恢复原来的 squash 设置，避免
        // “没合并成功但 MR 被改成 squash”的副作用。
        if (input.action === "squash" && !previousSquash) {
          try {
            await ctx.http({
              url: basePath,
              method: "PUT",
              headers: headers(ctx.token),
              body: JSON.stringify({ squash: false }),
              timeoutMs: 10_000,
            });
          } catch {
            /* 回滚是 best-effort，不覆盖原始合并错误 */
          }
        }
        throw error;
      }
      return;
    }
    if (input.action === "rebase") {
      const res = await ctx.http({
        url: `${basePath}/rebase`,
        method: "PUT",
        headers: headers(ctx.token),
        timeoutMs: 20_000,
      });
      assertOk(res, { label: LABEL });
      return;
    }
    if (input.action === "close" || input.action === "reopen") {
      const res = await ctx.http({
        url: basePath,
        method: "PUT",
        headers: headers(ctx.token),
        body: JSON.stringify({
          state_event: input.action === "close" ? "close" : "reopen",
        }),
        timeoutMs: 20_000,
      });
      assertOk(res, { label: LABEL });
      return;
    }
    if (input.action === "ready_for_review") {
      const detailRes = await ctx.http({
        url: basePath,
        headers: headers(ctx.token),
        timeoutMs: 15_000,
      });
      assertOk(detailRes, { label: LABEL });
      const detail = parseJson<GitlabTodoDetail>(detailRes, LABEL);
      const title = (detail.title ?? "").trim();
      const readyTitle = title.replace(/^(?:Draft|WIP):\s*/i, "").trim();
      if (!readyTitle || readyTitle === title) return;
      const res = await ctx.http({
        url: basePath,
        method: "PUT",
        headers: headers(ctx.token),
        body: JSON.stringify({ title: readyTitle }),
        timeoutMs: 20_000,
      });
      assertOk(res, { label: LABEL });
    }
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      (error.status === 405 ||
        error.status === 406 ||
        error.status === 409 ||
        error.status === 422)
    ) {
      throw new ConnectorError(
        "http",
        `${LABEL}：操作被拒绝（HTTP ${error.status}），请检查 MR 状态、冲突、流水线或 head 是否已更新`,
        error.status,
      );
    }
    throw error;
  }
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

  pullRequestDiff(ctx, input) {
    return fetchGitlabPullRequestDiff(ctx, input);
  },

  pullRequestChecks(ctx, input) {
    return fetchGitlabPullRequestChecks(ctx, input);
  },

  postComment(ctx, input) {
    return postGitlabComment(ctx, input);
  },

  pullRequestAction(ctx, input) {
    return runGitlabPullRequestAction(ctx, input);
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
