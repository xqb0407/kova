import { describe, expect, it } from "bun:test";
import type { InboxItem } from "pi-protocol";
import {
  buildInboxFilter,
  DEFAULT_INBOX_ADVANCED,
  initiatorOf,
  matchesAdvancedFilters,
  matchesTime,
  sourceOf,
  sourceOptions,
} from "./inbox-filters";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  const createdAt = overrides.createdAt ?? "2026-11-15T10:00:00.000Z";
  return {
    id: "approval:a1",
    kind: "approval",
    state: "open",
    outcome: "needs_action",
    priority: 0,
    requiresAction: true,
    title: "需要批准：bash",
    sourceId: "a1",
    sessionId: "s1",
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    actions: ["open", "approve", "deny"],
    hasDetail: true,
    ...overrides,
  };
}

describe("inbox 筛选", () => {
  it("来源映射：本地任务/自动化/子代理/后台/外部 provider", () => {
    expect(sourceOf(item())).toBe("task");
    expect(sourceOf(item({ kind: "automation" }))).toBe("automation");
    expect(sourceOf(item({ kind: "subagent" }))).toBe("subagent");
    expect(sourceOf(item({ kind: "background_task" }))).toBe("background");
    expect(
      sourceOf(
        item({ kind: "external", external: { provider: "github", key: "o/r#1" } }),
      ),
    ).toBe("github");
  });

  it("来源选项按固定顺序 + 未知 provider 追加", () => {
    expect(
      sourceOptions([
        item({ kind: "external", external: { provider: "linear" } }),
        item(),
        item({ kind: "automation" }),
        item({ kind: "external", external: { provider: "custom" } }),
      ]),
    ).toEqual(["task", "automation", "linear", "custom"]);
  });

  it("发起人：外部=人；自动化/后台=系统；目标安全阀=系统；其余=Agent", () => {
    expect(initiatorOf(item({ kind: "external", external: { provider: "jira" } }))).toBe("human");
    expect(initiatorOf(item({ kind: "automation" }))).toBe("system");
    expect(initiatorOf(item({ kind: "background_task" }))).toBe("system");
    expect(
      initiatorOf(item({ kind: "goal", meta: { pauseReason: "time budget reached" } })),
    ).toBe("system");
    expect(initiatorOf(item({ kind: "question" }))).toBe("agent");
  });

  it("时间筛选：按最近活动（updatedAt），今天 / 7 天 / 30 天", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z");
    expect(matchesTime(item(), "today", now)).toBe(true);
    expect(matchesTime(item({ createdAt: "2026-11-10T10:00:00.000Z" }), "7d", now)).toBe(true);
    expect(matchesTime(item({ createdAt: "2026-10-01T10:00:00.000Z" }), "30d", now)).toBe(false);
    expect(matchesTime(item({ createdAt: "not-a-date" }), "today", now)).toBe(false);

    // 老 issue 今天有新评论：updatedAt 是今天，应命中「今天」
    expect(
      matchesTime(
        item({
          createdAt: "2026-10-01T10:00:00.000Z",
          updatedAt: "2026-11-15T10:00:00.000Z",
        }),
        "today",
        now,
      ),
    ).toBe(true);
  });

  it("UI 筛选映射到服务端 InboxFilter：来源/项目/状态/时间/类型", () => {
    const advanced = {
      ...DEFAULT_INBOX_ADVANCED,
      time: "7d" as const,
      status: "open" as const,
      project: "p1",
      team: "o/r",
      externalKind: "pr" as const,
      includeSnoozed: true,
    };
    expect(
      buildInboxFilter({
        tab: "attention",
        query: "  login ",
        provider: "github",
        advanced,
        projectSessionIds: ["s1", "s2"],
      }),
    ).toEqual({
      tab: "attention",
      source: "github",
      kinds: ["external"],
      query: "login",
      time: "7d",
      status: "open",
      team: "o/r",
      externalKind: "pr",
      projectId: "p1",
      sessionIds: ["s1", "s2"],
      includeSnoozed: true,
    });

    expect(
      buildInboxFilter({
        tab: "history",
        query: "",
        localOnly: true,
        advanced: { ...DEFAULT_INBOX_ADVANCED, project: "none" },
        projectExcludeSessionIds: ["s1"],
      }),
    ).toMatchObject({
      tab: "history",
      kinds: ["approval", "question", "goal", "automation", "subagent", "background_task"],
      noProject: true,
      excludeSessionIds: ["s1"],
    });
  });

  it("客户端兜底筛选与项目/无项目一致", () => {
    const advanced = { ...DEFAULT_INBOX_ADVANCED, project: "p1" };
    expect(matchesAdvancedFilters(item({ projectId: "p1" }), advanced)).toBe(true);
    expect(matchesAdvancedFilters(item({ projectId: "p2" }), advanced)).toBe(false);
    expect(
      matchesAdvancedFilters(item({ projectId: undefined }), {
        ...DEFAULT_INBOX_ADVANCED,
        project: "none",
      }),
    ).toBe(true);
  });
});
