import { describe, expect, it } from "bun:test";
import type { InboxItem } from "pi-protocol";
import { filterByViewTab, groupInboxItems } from "./inbox-groups";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "subagent:d1:1",
    kind: "subagent",
    state: "done",
    outcome: "completed",
    priority: 2,
    requiresAction: false,
    title: "子代理完成：reviewer",
    summary: "发现 2 处风险",
    sourceId: "d1",
    sessionId: "s1",
    threadId: "t1",
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    actions: ["open", "mark_read", "archive"],
    hasDetail: true,
    ...overrides,
  };
}

describe("inbox 任务聚合", () => {
  it("同会话的多条更新聚合为一行，最新在前", () => {
    const groups = groupInboxItems(
      [
        item({ id: "a", createdAt: "2026-11-15T10:00:00.000Z" }),
        item({ id: "b", createdAt: "2026-11-15T11:00:00.000Z" }),
      ],
      {
        tab: "attention",
        sessionTitles: new Map([["s1", "支付重构"]]),
      },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("支付重构");
    expect(groups[0]?.items.map((x) => x.id)).toEqual(["b", "a"]);
    expect(groups[0]?.hasUnread).toBe(true);
  });

  it("已读后从待关注进入历史", () => {
    const read = item({ readAt: "2026-11-15T12:00:00.000Z" });
    expect(filterByViewTab([read], "attention")).toHaveLength(0);
    expect(filterByViewTab([read], "history")).toHaveLength(1);
    expect(groupInboxItems([read], { tab: "history" })).toHaveLength(1);
  });

  it("同一自动化任务的多轮运行聚合成一行（按 taskId 而非 runId）", () => {
    const base = item({
      kind: "automation",
      state: "done",
      outcome: "success",
      title: "自动化完成：发布检查",
      sessionId: "run-session-1",
      meta: { taskId: "task-1", taskName: "发布检查", runId: "run-1" },
    });
    const groups = groupInboxItems(
      [
        base,
        {
          ...base,
          id: "automation:task-1:run-2",
          sessionId: "run-session-2",
          meta: { taskId: "task-1", taskName: "发布检查", runId: "run-2" },
        },
      ],
      { tab: "attention" },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("automation");
    expect(groups[0]?.title).toBe("发布检查");
    expect(groups[0]?.items).toHaveLength(2);
  });

  it("外部工作项按 provider + key 聚合，label 带 provider", () => {
    const ext = item({
      id: "external:github:repo#12",
      kind: "external",
      title: "repo#12: Fix login redirect",
      sourceId: "repo#12",
      external: { provider: "github", key: "repo#12", url: "https://github.com/o/r/issues/12" },
      meta: { provider: "github" },
    });
    const groups = groupInboxItems([ext], { tab: "attention" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("external:github");
    expect(groups[0]?.title).toBe("repo#12: Fix login redirect");
  });

  it("需要动作的组排在只有未读更新的组前面", () => {
    const groups = groupInboxItems(
      [
        item({ id: "unread", sessionId: "s-unread", createdAt: "2026-11-15T12:00:00.000Z" }),
        item({
          id: "action",
          kind: "approval",
          state: "open",
          outcome: "needs_action",
          requiresAction: true,
          priority: 0,
          sessionId: "s-action",
          createdAt: "2026-11-15T09:00:00.000Z",
        }),
      ],
      { tab: "attention" },
    );
    expect(groups.map((g) => g.key)).toEqual(["session:s-action", "session:s-unread"]);
  });
});
