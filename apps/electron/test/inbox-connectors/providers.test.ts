import { describe, expect, test } from "bun:test";
import type {
  HttpJsonRequest,
  HttpJsonResponse,
  StoredConnector,
} from "../../main/inbox-connectors/types";
import {
  githubAdapter,
  mapGithubNotification,
} from "../../main/inbox-connectors/providers/github";
import {
  gitlabAdapter,
  mapGitlabTodo,
} from "../../main/inbox-connectors/providers/gitlab";
import {
  jiraAdapter,
  jiraWikiMediaToText,
  mapJiraIssue,
} from "../../main/inbox-connectors/providers/jira";
import {
  linearAdapter,
  mapLinearIssue,
} from "../../main/inbox-connectors/providers/linear";

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpJsonResponse {
  return {
    status,
    headers,
    text: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function fakeHttp(
  handler: (req: HttpJsonRequest) => HttpJsonResponse | Promise<HttpJsonResponse>,
) {
  return async (req: HttpJsonRequest) => handler(req);
}

function config(
  provider: StoredConnector["provider"],
  overrides: Partial<StoredConnector> = {},
): StoredConnector {
  return {
    id: provider,
    provider,
    enabled: true,
    ...overrides,
  };
}

describe("github inbox adapter", () => {
  const ctx = {
    config: config("github"),
    token: "tkn",
    http: fakeHttp(() => response(200, [])),
  };

  test("assign 通知映射成待关注 PR，URL 从 API 地址还原为网页地址", () => {
    const item = mapGithubNotification(
      {
        id: "1",
        reason: "assign",
        updated_at: "2026-11-01T00:00:00.000Z",
        subject: {
          title: "Fix login redirect",
          type: "PullRequest",
          url: "https://api.github.com/repos/o/r/pulls/12",
        },
        repository: {
          full_name: "o/r",
          html_url: "https://github.com/o/r",
        },
      },
      ctx,
      "https://api.github.com",
    );
    expect(item?.idKey).toBe("github.com/o/r#12");
    expect(item?.key).toBe("o/r#12");
    expect(item?.url).toBe("https://github.com/o/r/pull/12");
    expect(item?.summary).toContain("指派给你");
    expect(item?.requiresAction).toBe(true);
    expect(item?.priority).toBe(1);
  });

  test("默认过滤掉 subscribed/ci_activity 等噪音通知", () => {
    const item = mapGithubNotification(
      {
        id: "2",
        reason: "subscribed",
        subject: { title: "noise", type: "Issue", url: "https://api.github.com/repos/o/r/issues/2" },
        repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
      },
      ctx,
      "https://api.github.com",
    );
    expect(item).toBeNull();
  });

  test("GitHub Enterprise 的 api/v3 地址映射回站点网页", () => {
    const item = mapGithubNotification(
      {
        id: "3",
        reason: "mention",
        subject: {
          title: "GHES issue",
          type: "Issue",
          url: "https://ghe.example.com/api/v3/repos/o/r/issues/3",
        },
        repository: {
          full_name: "o/r",
          html_url: "https://ghe.example.com/o/r",
        },
      },
      ctx,
      "https://ghe.example.com/api/v3",
    );
    expect(item?.idKey).toBe("ghe.example.com/o/r#3");
    expect(item?.url).toBe("https://ghe.example.com/o/r/issues/3");
  });

  test("分页：Link rel=next 拉第二页，拉全时 complete=true", async () => {
    const seen: string[] = [];
    const http = fakeHttp((req) => {
      seen.push(req.url);
      if (req.url.includes("page=2")) {
        return response(200, [
          {
            id: "2",
            reason: "review_requested",
            subject: {
              title: "Second",
              type: "PullRequest",
              url: "https://api.github.com/repos/o/r/pulls/2",
            },
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          },
        ]);
      }
      return response(
        200,
        [
          {
            id: "1",
            reason: "assign",
            subject: {
              title: "First",
              type: "Issue",
              url: "https://api.github.com/repos/o/r/issues/1",
            },
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          },
        ],
        {
          link: '<https://api.github.com/notifications?page=2>; rel="next"',
        },
      );
    });
    const result = await githubAdapter.fetch({
      config: ctx.config,
      token: "tkn",
      http,
    });
    expect(result.items.map((item) => item.key)).toEqual(["o/r#1", "o/r#2"]);
    expect(result.complete).toBe(true);
    expect(seen.some((url) => url.includes("page=2"))).toBe(true);
  });

  test("分页：跨域 Link rel=next 不跟随，避免 Token 外带", async () => {
    const seen: string[] = [];
    const http = fakeHttp((req) => {
      seen.push(req.url);
      return response(
        200,
        [
          {
            id: "1",
            reason: "assign",
            subject: {
              title: "First",
              type: "Issue",
              url: "https://api.github.com/repos/o/r/issues/1",
            },
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          },
        ],
        {
          link: '<https://evil.example/notifications?page=2>; rel="next"',
        },
      );
    });
    const result = await githubAdapter.fetch({
      config: ctx.config,
      token: "tkn",
      http,
    });
    expect(seen).toHaveLength(1);
    expect(result.items.map((item) => item.key)).toEqual(["o/r#1"]);
    // 有下一页但被安全策略拒绝：不能标记 complete，否则会误结算缺失项
    expect(result.complete).toBe(false);
  });

  test("PR 详情：refs/增减行/评审结论", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/reviews")) {
        return response(200, [
          { user: { login: "ada" }, state: "APPROVED" },
          { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
          { user: { login: "ada" }, state: "APPROVED" },
        ]);
      }
      if (req.url.includes("/comments")) return response(200, []);
      return response(200, {
        title: "Fix login",
        body: "body",
        state: "open",
        html_url: "https://github.com/o/r/pull/12",
        user: { login: "ada" },
        head: { ref: "feat/login", sha: "abc123" },
        base: { ref: "main" },
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        additions: 12,
        deletions: 3,
        changed_files: 2,
      });
    });
    const detail = await githubAdapter.detail!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request" },
    );
    expect(detail.pullRequest).toEqual({
      baseRef: "main",
      headRef: "feat/login",
      headSha: "abc123",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      reviewDecision: "changes_requested",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });
  });

  test("PR diff：多文件统一 patch，二进制文件只保留文件行", async () => {
    const http = fakeHttp(() =>
      response(200, [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
        },
        {
          filename: "assets/logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ]),
    );
    const diff = await githubAdapter.pullRequestDiff!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request" },
    );
    expect(diff.files).toHaveLength(2);
    expect(diff.files[1]?.binary).toBe(true);
    expect(diff.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff.patch).toContain("+++ b/src/a.ts");
    expect(diff.patch).toContain("@@ -1 +1,2 @@");
    expect(diff.patch).toContain("Binary files a/assets/logo.png and b/assets/logo.png differ");
    expect(diff.truncated).toBeUndefined();
  });

  test("PR diff：纯重命名不标二进制，保留 rename 文件头", async () => {
    const http = fakeHttp(() =>
      response(200, [
        {
          filename: "src/new-name.ts",
          previous_filename: "src/old-name.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
      ]),
    );
    const diff = await githubAdapter.pullRequestDiff!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request" },
    );
    expect(diff.files[0]?.binary).toBeUndefined();
    expect(diff.patch).toContain("rename from src/old-name.ts");
    expect(diff.patch).toContain("rename to src/new-name.ts");
  });

  test("PR 详情：合并 issue 评论与 review 评论，review 带 replyToId", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/pulls/12/comments")) {
        return response(200, [
          {
            id: 5,
            body: "inline comment",
            user: { login: "rev" },
            created_at: "2026-11-01T00:00:02.000Z",
          },
        ]);
      }
      if (req.url.includes("/issues/12/comments")) {
        return response(200, [
          {
            id: 1,
            body: "issue comment",
            user: { login: "ada" },
            created_at: "2026-11-01T00:00:01.000Z",
          },
        ]);
      }
      if (req.url.includes("/reviews")) return response(200, []);
      return response(200, {
        title: "Fix",
        state: "open",
        head: { ref: "feat", sha: "abc" },
        base: { ref: "main" },
      });
    });
    const detail = await githubAdapter.detail!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request" },
    );
    expect(detail.comments?.map((comment) => comment.body)).toEqual([
      "issue comment",
      "inline comment",
    ]);
    expect(detail.comments?.[1]?.replyToId).toBe("5");
  });

  test("PR checks：403 限流不被当成无 Actions 权限吞掉", async () => {
    const http = fakeHttp(() =>
      response(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
      }),
    );
    let error: unknown;
    try {
      await githubAdapter.pullRequestChecks!(
        { config: ctx.config, token: "tkn", http },
        { key: "o/r#12", type: "pull_request", headSha: "abc123" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain("配额");
  });

  test("评论：issue 评论与 PR review 回复走对应端点", async () => {
    const calls: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      calls.push(req);
      return response(201, {});
    });
    await githubAdapter.postComment!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "issue", body: "hello" },
    );
    await githubAdapter.postComment!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request", body: "reply", replyToId: "99" },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/repos/o/r/issues/12/comments");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ body: "hello" });
    expect(calls[1]?.url).toContain(
      "/repos/o/r/pulls/12/comments/99/replies",
    );
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ body: "reply" });
  });

  test("PR 动作：merge/close/ready 的方法与载荷", async () => {
    const calls: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      calls.push(req);
      return response(200, {});
    });
    await githubAdapter.pullRequestAction!(
      { config: ctx.config, token: "tkn", http },
      {
        key: "o/r#12",
        type: "pull_request",
        action: "squash",
        headSha: "abc123",
      },
    );
    await githubAdapter.pullRequestAction!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request", action: "close" },
    );
    await githubAdapter.pullRequestAction!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request", action: "ready_for_review" },
    );
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/pulls/12/merge");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      merge_method: "squash",
      sha: "abc123",
    });
    expect(calls[1]?.method).toBe("PATCH");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ state: "closed" });
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.url).toContain("/pulls/12/ready_for_review");
  });

  test("PR checks：check-runs + commit status 合并去重", async () => {
    const calls: string[] = [];
    const http = fakeHttp((req) => {
      calls.push(req.url);
      if (req.url.includes("/check-runs")) {
        return response(200, {
          total_count: 2,
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/o/r/actions/runs/1",
              output: { title: "build failed", summary: "boom" },
              app: { name: "GitHub Actions" },
            },
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              app: { name: "GitHub Actions" },
            },
          ],
        });
      }
      if (req.url.includes("/status")) {
        return response(200, {
          state: "pending",
          statuses: [
            {
              context: "ci/circle",
              state: "pending",
              target_url: "https://circleci.com/1",
            },
            { context: "build", state: "failure" },
          ],
        });
      }
      // 未传 headSha 时回落到 PR 详情取 head.sha
      return response(200, { head: { sha: "abc123" } });
    });
    const checks = await githubAdapter.pullRequestChecks!(
      { config: ctx.config, token: "tkn", http },
      { key: "o/r#12", type: "pull_request" },
    );
    expect(checks.headSha).toBe("abc123");
    expect(checks.checks.map((entry) => entry.name)).toEqual([
      "build",
      "lint",
      "ci/circle",
    ]);
    const build = checks.checks.find((entry) => entry.name === "build");
    expect(build?.state).toBe("fail");
    expect(build?.workflow).toBe("GitHub Actions");
    expect(build?.output).toContain("boom");
    expect(checks.checks.find((entry) => entry.name === "lint")?.state).toBe(
      "pass",
    );
    expect(
      checks.checks.find((entry) => entry.name === "ci/circle")?.state,
    ).toBe("pending");
    expect(calls.some((url) => url.includes("/pulls/12"))).toBe(true);
  });
});

describe("gitlab inbox adapter", () => {
  const ctx = {
    config: config("gitlab"),
    token: "tkn",
    http: fakeHttp(() => response(200, [])),
  };

  test("review_requested todo 映射为 MR 评审项", () => {
    const item = mapGitlabTodo(
      {
        id: 9,
        action_name: "review_requested",
        target_type: "MergeRequest",
        target_url: "https://gitlab.com/g/r/-/merge_requests/7",
        created_at: "2026-11-01T00:00:00.000Z",
        project: { path_with_namespace: "g/r", web_url: "https://gitlab.com/g/r" },
        target: { title: "Better cache", iid: 7, state: "opened" },
      },
      ctx,
    );
    expect(item?.idKey).toBe("gitlab.com/g/r!7");
    expect(item?.key).toBe("g/r!7");
    expect(item?.type).toBe("merge_request");
    expect(item?.url).toBe("https://gitlab.com/g/r/-/merge_requests/7");
    expect(item?.requiresAction).toBe(true);
    expect(item?.priority).toBe(1);
    expect(item?.status).toBe("opened");
  });

  test("build_failed 默认关闭；打开后是 FYI（不占待关注动作）", () => {
    const raw = {
      id: 10,
      action_name: "build_failed",
      target_type: "Issue",
      target_url: "https://gitlab.com/g/r/-/issues/3",
      project: { path_with_namespace: "g/r" },
      target: { title: "Pipeline", iid: 3 },
    };
    expect(mapGitlabTodo(raw, ctx)).toBeNull();
    const item = mapGitlabTodo(raw, {
      ...ctx,
      config: config("gitlab", { events: { buildFailed: true } }),
    });
    expect(item?.requiresAction).toBe(false);
    expect(item?.priority).toBe(2);
  });

  test("x-next-page 分页与 complete 标志", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("page=2")) {
        return response(200, [
          {
            id: 2,
            action_name: "assigned",
            target_type: "Issue",
            target_url: "https://gitlab.com/g/r/-/issues/2",
            project: { path_with_namespace: "g/r" },
            target: { title: "Two", iid: 2 },
          },
        ]);
      }
      return response(
        200,
        [
          {
            id: 1,
            action_name: "assigned",
            target_type: "Issue",
            target_url: "https://gitlab.com/g/r/-/issues/1",
            project: { path_with_namespace: "g/r" },
            target: { title: "One", iid: 1 },
          },
        ],
        { "x-next-page": "2" },
      );
    });
    const result = await gitlabAdapter.fetch({
      config: ctx.config,
      token: "tkn",
      http,
    });
    expect(result.items.map((item) => item.key)).toEqual(["g/r#1", "g/r#2"]);
    expect(result.complete).toBe(true);
  });

  test("MR 详情：refs/draft/冲突与变更文件数", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/notes")) return response(200, []);
      return response(200, {
        title: "Better cache",
        description: "body",
        state: "opened",
        web_url: "https://gitlab.com/g/r/-/merge_requests/7",
        source_branch: "feat/cache",
        target_branch: "main",
        sha: "deadbeef",
        draft: true,
        has_conflicts: true,
        detailed_merge_status: "conflict",
        changes_count: "4",
        author: { name: "Ada" },
      });
    });
    const detail = await gitlabAdapter.detail!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request" },
    );
    expect(detail.pullRequest).toEqual({
      baseRef: "main",
      headRef: "feat/cache",
      headSha: "deadbeef",
      draft: true,
      mergeable: false,
      mergeableState: "conflict",
      changedFiles: 4,
    });
  });

  test("MR 详情：not_approved 不误标为可合并", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/notes")) return response(200, []);
      return response(200, {
        title: "Needs approval",
        state: "opened",
        web_url: "https://gitlab.com/g/r/-/merge_requests/8",
        has_conflicts: false,
        detailed_merge_status: "not_approved",
      });
    });
    const detail = await gitlabAdapter.detail!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!8", type: "merge_request" },
    );
    expect(detail.pullRequest?.mergeable).toBeUndefined();
    expect(detail.pullRequest?.mergeableState).toBe("not_approved");
  });

  test("MR diff：changes 转统一 patch，overflow/too_large 降级", async () => {
    const http = fakeHttp(() =>
      response(200, {
        overflow: true,
        changes: [
          {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            diff: "@@ -1 +1,2 @@\n-old\n+new\n+more",
          },
          { old_path: "img.png", new_path: "img.png", too_large: true },
        ],
      }),
    );
    const diff = await gitlabAdapter.pullRequestDiff!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request" },
    );
    expect(diff.truncated).toBe(true);
    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]?.additions).toBe(2);
    expect(diff.files[0]?.deletions).toBe(1);
    expect(diff.files[1]?.binary).toBe(true);
    expect(diff.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff.patch).toContain("+++ b/src/a.ts");
    expect(diff.patch).toContain("Binary files a/img.png and b/img.png differ");
  });

  test("MR checks：最新 pipeline 的 jobs 状态映射", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/pipelines/5/jobs")) {
        return response(200, [
          {
            id: 1,
            name: "rspec",
            stage: "test",
            status: "failed",
            web_url: "https://gitlab.com/g/r/-/jobs/1",
          },
          {
            id: 2,
            name: "build",
            stage: "build",
            status: "success",
            web_url: "https://gitlab.com/g/r/-/jobs/2",
          },
        ]);
      }
      if (req.url.includes("/pipelines?")) {
        return response(200, [
          {
            id: 5,
            status: "failed",
            web_url: "https://gitlab.com/g/r/-/pipelines/5",
          },
        ]);
      }
      return response(200, { sha: "deadbeef" });
    });
    const checks = await gitlabAdapter.pullRequestChecks!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request" },
    );
    expect(checks.headSha).toBe("deadbeef");
    expect(checks.checks.map((entry) => entry.name)).toEqual(["rspec", "build"]);
    expect(checks.checks[0]?.state).toBe("fail");
    expect(checks.checks[1]?.state).toBe("pass");
  });

  test("MR 评论与动作：notes / merge / close 端点", async () => {
    const calls: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      calls.push(req);
      return response(201, {});
    });
    await gitlabAdapter.postComment!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request", body: "hello" },
    );
    await gitlabAdapter.pullRequestAction!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request", action: "merge" },
    );
    await gitlabAdapter.pullRequestAction!(
      { config: ctx.config, token: "tkn", http },
      { key: "g/r!7", type: "merge_request", action: "close" },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain(
      "/projects/g%2Fr/merge_requests/7/notes",
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ body: "hello" });
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.url).toContain(
      "/projects/g%2Fr/merge_requests/7/merge",
    );
    expect(calls[2]?.method).toBe("PUT");
    expect(calls[2]?.url).toContain("/projects/g%2Fr/merge_requests/7");
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      state_event: "close",
    });
  });

  test("squash 合并失败时回滚 squash 设置", async () => {
    const calls: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      calls.push(req);
      if (req.url.endsWith("/merge")) {
        return response(405, { message: "merge blocked" });
      }
      if (!req.method || req.method === "GET") {
        return response(200, { squash: false });
      }
      return response(200, {});
    });
    let error: unknown;
    try {
      await gitlabAdapter.pullRequestAction!(
        { config: ctx.config, token: "tkn", http },
        { key: "g/r!7", type: "merge_request", action: "squash" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    const squashBodies = calls
      .filter((req) => req.method === "PUT" && req.body?.includes("squash"))
      .map((req) => JSON.parse(req.body ?? "{}") as { squash?: boolean });
    expect(squashBodies).toEqual([
      { squash: true },
      { squash: false },
    ]);
  });
});

describe("jira inbox adapter", () => {
  const jiraConfig = config("jira", {
    baseUrl: "https://acme.atlassian.net",
    account: "me@acme.com",
    authMode: "cloud",
  });

  test("issue 映射：JQL 结果 → 待关注 ticket", () => {
    const item = mapJiraIssue(
      {
        key: "ACME-7",
        fields: {
          summary: "Login fails",
          status: { name: "In Progress" },
          priority: { name: "High" },
          project: { key: "ACME" },
          created: "2026-11-01T00:00:00.000Z",
        },
      },
      "https://acme.atlassian.net",
    );
    expect(item?.idKey).toBe("acme.atlassian.net/ACME-7");
    expect(item?.key).toBe("ACME-7");
    expect(item?.url).toBe("https://acme.atlassian.net/browse/ACME-7");
    expect(item?.priority).toBe(1);
    expect(item?.requiresAction).toBe(true);
    expect(item?.summary).toContain("指派给你");
    expect(item?.status).toBe("In Progress");
  });

  test("Cloud 新版 search/jql 不可用时回退 v2 search", async () => {
    const calls: string[] = [];
    const http = fakeHttp((req) => {
      calls.push(req.url);
      if (req.url.includes("/rest/api/3/search/jql")) {
        return response(404, { errorMessages: ["not found"] });
      }
      return response(200, {
        issues: [
          {
            key: "ACME-1",
            fields: {
              summary: "Fallback works",
              status: { name: "To Do" },
              project: { key: "ACME" },
            },
          },
        ],
        total: 1,
        startAt: 0,
        maxResults: 50,
      });
    });
    const result = await jiraAdapter.fetch({
      config: jiraConfig,
      token: "tkn",
      http,
    });
    expect(calls.some((url) => url.includes("/rest/api/3/search/jql"))).toBe(true);
    expect(calls.some((url) => url.includes("/rest/api/2/search"))).toBe(true);
    expect(result.items.map((item) => item.key)).toEqual(["ACME-1"]);
    expect(result.complete).toBe(true);
  });

  test("Cloud 认证缺邮箱时给出可行动错误", async () => {
    const http = fakeHttp(() => response(200, { issues: [] }));
    let error: unknown;
    try {
      await jiraAdapter.fetch({
        config: config("jira", {
          baseUrl: "https://acme.atlassian.net",
          authMode: "cloud",
        }),
        token: "tkn",
        http,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain("请填写登录邮箱");
  });

  test("wiki markup 图片/视频嵌入丢弃，附件保留纯文本占位", () => {
    const text = jiraWikiMediaToText(
      '复现：\n\n!20261124_154936.mp4|width=672,alt="20261124_154936.mp4"!\n\n' +
        "!screen shot.png|width=100!\n\n[^notes.pdf]\n\n保留 ! 感叹号",
    );
    // 图片/视频渲染不出来，不留占位
    expect(text).not.toContain("[视频]");
    expect(text).not.toContain("[图片]");
    expect(text).not.toContain(".mp4");
    expect(text).not.toContain(".png");
    expect(text).toContain("[附件] notes.pdf");
    expect(text).toContain("保留 ! 感叹号");
    expect(text).not.toContain("width=");
    expect(text).not.toContain("[^");
    // 丢弃后不残留多余空行
    expect(text).toBe("复现：\n\n[附件] notes.pdf\n\n保留 ! 感叹号");
    // markdown 图片语法不能被当成 wiki 嵌入
    expect(jiraWikiMediaToText("![alt](https://x/y.png)")).toBe(
      "![alt](https://x/y.png)",
    );
    // 普通正文里的成对感叹号也不能被误判
    expect(jiraWikiMediaToText("Wow! Great!")).toBe("Wow! Great!");
    // 域名不是附件扩展名
    expect(jiraWikiMediaToText("Hello! world.com!")).toBe("Hello! world.com!");
  });

  test("Server detail：正文与评论里的图片/视频嵌入直接丢弃", async () => {
    const http = fakeHttp((req) => {
      if (req.url.includes("/comment")) {
        return response(200, {
          comments: [
            {
              id: "c1",
              author: { displayName: "Ada" },
              body: "看这个 !demo.mp4|width=320!",
            },
          ],
        });
      }
      return response(200, {
        fields: {
          summary: "Video issue",
          description: "步骤\n\n!20261124_154936.mp4|width=672!",
        },
      });
    });
    const detail = await jiraAdapter.detail!(
      {
        config: config("jira", {
          baseUrl: "https://jira.acme.com",
          authMode: "server",
        }),
        token: "pat",
        http,
      },
      { key: "ACME-9" },
    );
    expect(detail.body).toBe("步骤");
    expect(detail.body).not.toContain("!");
    expect(detail.comments?.[0]?.body).toBe("看这个");
  });

  test("评论：Cloud 用 v3 ADF，Server 用 v2 字符串", async () => {
    const calls: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      calls.push(req);
      return response(201, { id: "1" });
    });
    await jiraAdapter.postComment!(
      {
        config: config("jira", {
          baseUrl: "https://acme.atlassian.net",
          account: "me@acme.com",
          authMode: "cloud",
        }),
        token: "tkn",
        http,
      },
      { key: "ACME-7", body: "hello\nworld" },
    );
    await jiraAdapter.postComment!(
      {
        config: config("jira", {
          baseUrl: "https://jira.acme.com",
          authMode: "server",
        }),
        token: "pat",
        http,
      },
      { key: "ACME-7", body: "hello" },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/rest/api/3/issue/ACME-7/comment");
    const cloudBody = JSON.parse(calls[0]?.body ?? "{}") as {
      body?: { type?: string };
    };
    expect(cloudBody.body?.type).toBe("doc");
    expect(calls[1]?.url).toContain("/rest/api/2/issue/ACME-7/comment");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ body: "hello" });
  });
});

describe("linear inbox adapter", () => {
  test("assigned issue 映射：identifier/状态/优先级", () => {
    const item = mapLinearIssue({
      identifier: "LIN-1",
      title: "Ship it",
      url: "https://linear.app/acme/issue/LIN-1",
      priority: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      team: { name: "Core", key: "CORE" },
    });
    expect(item?.idKey).toBe("linear/LIN-1");
    expect(item?.key).toBe("LIN-1");
    expect(item?.url).toBe("https://linear.app/acme/issue/LIN-1");
    expect(item?.priority).toBe(1);
    expect(item?.status).toBe("In Progress");
    expect(item?.requiresAction).toBe(true);
  });

  test("GraphQL 分页：hasNextPage=false 时 complete=true", async () => {
    const http = fakeHttp(() =>
      response(200, {
        data: {
          viewer: { name: "Ada" },
          issues: {
            nodes: [
              {
                identifier: "LIN-2",
                title: "Two",
                url: "https://linear.app/acme/issue/LIN-2",
                priority: 3,
                state: { name: "Todo" },
                team: { name: "Core" },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );
    const result = await linearAdapter.fetch({
      config: config("linear"),
      token: "lin_api_x",
      http,
    });
    expect(result.items.map((item) => item.key)).toEqual(["LIN-2"]);
    expect(result.complete).toBe(true);
    expect(result.accountName).toBe("Ada");
  });

  test("GraphQL errors 转成可读错误", async () => {
    const http = fakeHttp(() =>
      response(200, {
        errors: [{ message: "Authentication required" }],
      }),
    );
    let error: unknown;
    try {
      await linearAdapter.fetch({
        config: config("linear"),
        token: "bad",
        http,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain("Authentication required");
  });

  test("评论：commentCreate 带 issueId / parentId", async () => {
    const requests: HttpJsonRequest[] = [];
    const http = fakeHttp((req) => {
      requests.push(req);
      return response(200, {
        data: { commentCreate: { success: true } },
      });
    });
    await linearAdapter.postComment!(
      { config: config("linear"), token: "lin_api_x", http },
      {
        key: "LIN-1",
        externalId: "issue-uuid",
        body: "hello",
        replyToId: "parent-uuid",
      },
    );
    expect(requests[0]?.method).toBe("POST");
    const payload = JSON.parse(requests[0]?.body ?? "{}") as {
      query?: string;
      variables?: { input?: Record<string, unknown> };
    };
    expect(payload.query).toContain("commentCreate");
    expect(payload.variables?.input).toEqual({
      issueId: "issue-uuid",
      body: "hello",
      parentId: "parent-uuid",
    });
  });
});

describe("listSources（触发器表单「选代替填」）", () => {
  test("github：full_name 为 id，与通知条目 sourceName 同口径", async () => {
    const sources = await githubAdapter.listSources!({
      config: config("github"),
      token: "tkn",
      http: fakeHttp((req) => {
        expect(req.url).toContain("/user/repos");
        return response(200, [
          { full_name: "org/repo-a", name: "Repo A", description: "x" },
          { full_name: "org/repo-a" },
        ]);
      }),
    });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({ id: "org/repo-a", label: "Repo A" });
    expect(sources[1]).toEqual({ id: "org/repo-a" });
  });

  test("gitlab：path_with_namespace 为 id", async () => {
    const sources = await gitlabAdapter.listSources!({
      config: config("gitlab", { baseUrl: "https://git.example.com" }),
      token: "tkn",
      http: fakeHttp((req) => {
        expect(req.url).toContain("/projects?membership=true");
        return response(200, [
          { path_with_namespace: "group/app", name_with_namespace: "Group / App" },
          { path_with_namespace: "group/lib" },
        ]);
      }),
    });
    expect(sources).toEqual([
      { id: "group/app", label: "Group / App" },
      { id: "group/lib" },
    ]);
  });

  test("jira cloud：v3 search 的 values，id=项目 key", async () => {
    const sources = await jiraAdapter.listSources!({
      config: config("jira", {
        baseUrl: "https://acme.atlassian.net",
        account: "me@acme.com",
        authMode: "cloud",
      }),
      token: "tkn",
      http: fakeHttp((req) => {
        expect(req.url).toContain("/rest/api/3/project/search");
        return response(200, {
          values: [
            { key: "ACME", name: "Acme Platform" },
            { key: "OPS" },
          ],
        });
      }),
    });
    expect(sources).toEqual([
      { id: "ACME", label: "Acme Platform" },
      { id: "OPS" },
    ]);
  });

  test("jira server：v2 全量数组", async () => {
    const sources = await jiraAdapter.listSources!({
      config: config("jira", {
        baseUrl: "https://jira.internal",
        authMode: "server",
      }),
      token: "tkn",
      http: fakeHttp((req) => {
        expect(req.url).toContain("/rest/api/2/project");
        return response(200, [{ key: "INFRA", name: "Infra" }]);
      }),
    });
    expect(sources).toEqual([{ id: "INFRA", label: "Infra" }]);
  });

  test("linear：team name 为 id（与 mapLinearIssue 的 sourceName 口径一致）", async () => {
    const sources = await linearAdapter.listSources!({
      config: config("linear"),
      token: "tkn",
      http: fakeHttp((req) => {
        expect(req.url).toBe("https://api.linear.app/graphql");
        return response(200, {
          data: { teams: { nodes: [{ id: "t1", name: "Core", key: "COR" }] } },
        });
      }),
    });
    expect(sources).toEqual([{ id: "Core", label: "Core (COR)" }]);
  });

  test("linear：GraphQL errors / 坏形状 → 空列表不抛", async () => {
    const sources = await linearAdapter.listSources!({
      config: config("linear"),
      token: "tkn",
      http: fakeHttp(() => response(200, { errors: [{ message: "nope" }] })),
    });
    expect(sources).toEqual([]);
  });
});
