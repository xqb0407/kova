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
});
