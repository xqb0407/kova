import { describe, expect, it } from "bun:test";
import type { InboxItem } from "pi-protocol";
import {
  archivableItemIdsOfGroup,
  filterByViewTab,
  groupInboxItems,
  unreadItemIdsOfGroup,
} from "./inbox-groups";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  const createdAt = overrides.createdAt ?? "2026-11-15T10:00:00.000Z";
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
    createdAt,
    // 测试里通常只写 createdAt：默认把它当作最近活动时间，
    // 避免 updatedAt 固定值让排序断言变得不直观
    updatedAt: overrides.updatedAt ?? createdAt,
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

  it("归档后从历史和待关注移出，只出现在已归档 Tab", () => {
    const archived = item({
      readAt: "2026-11-15T12:00:00.000Z",
      archivedAt: "2026-11-15T13:00:00.000Z",
    });
    expect(filterByViewTab([archived], "attention")).toHaveLength(0);
    expect(filterByViewTab([archived], "history")).toHaveLength(0);
    expect(filterByViewTab([archived], "archived")).toHaveLength(1);
    expect(groupInboxItems([archived], { tab: "archived" })).toHaveLength(1);
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

  it("打开聚合行结算组内全部未读，不只最新一条", () => {
    const groups = groupInboxItems(
      [
        item({ id: "older", createdAt: "2026-11-15T10:00:00.000Z" }),
        item({ id: "newer", createdAt: "2026-11-15T11:00:00.000Z" }),
      ],
      { tab: "attention" },
    );
    expect(groups[0]?.latest.id).toBe("newer");
    // 列表只展示最新一条；较早的未读没有单独入口，必须一起结算
    expect(unreadItemIdsOfGroup(groups[0]!)).toEqual(["newer", "older"]);
  });

  it("已读条目不再进入打开行时的结算", () => {
    const groups = groupInboxItems(
      [
        item({ id: "unread", createdAt: "2026-11-15T10:00:00.000Z" }),
        item({
          id: "read-action",
          createdAt: "2026-11-15T11:00:00.000Z",
          readAt: "2026-11-15T12:00:00.000Z",
          requiresAction: true,
        }),
      ],
      { tab: "attention" },
    );
    expect(groups[0]?.hasUnread).toBe(true);
    expect(unreadItemIdsOfGroup(groups[0]!)).toEqual(["unread"]);
  });

  it("已归档但未读的条目在查看后也能结算", () => {
    const groups = groupInboxItems(
      [
        item({
          id: "archived-unread",
          archivedAt: "2026-11-15T12:00:00.000Z",
        }),
      ],
      { tab: "archived" },
    );
    expect(groups[0]?.hasUnread).toBe(true);
    expect(unreadItemIdsOfGroup(groups[0]!)).toEqual(["archived-unread"]);
  });

  it("行级归档跳过 open 阻塞项，只结算可归档条目", () => {
    const groups = groupInboxItems(
      [
        item({
          id: "approval",
          kind: "approval",
          state: "open",
          requiresAction: true,
          actions: ["open", "approve", "deny", "mark_read"],
          createdAt: "2026-11-15T12:00:00.000Z",
        }),
        item({
          id: "automation",
          kind: "automation",
          state: "done",
          actions: ["open", "mark_read", "archive"],
          createdAt: "2026-11-15T10:00:00.000Z",
        }),
      ],
      { tab: "attention" },
    );
    expect(archivableItemIdsOfGroup(groups[0]!, true)).toEqual(["automation"]);
  });

  it("行级恢复返回组内全部已归档条目", () => {
    const groups = groupInboxItems(
      [
        item({ id: "a1", archivedAt: "2026-11-15T12:00:00.000Z" }),
        item({ id: "a2", archivedAt: "2026-11-15T13:00:00.000Z" }),
      ],
      { tab: "archived" },
    );
    expect(archivableItemIdsOfGroup(groups[0]!, false).sort()).toEqual([
      "a1",
      "a2",
    ]);
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

  it("按最近活动排序：老条目有新更新会上浮", () => {
    const groups = groupInboxItems(
      [
        item({
          id: "old-but-updated",
          sessionId: "s-old",
          createdAt: "2026-11-01T10:00:00.000Z",
          updatedAt: "2026-11-15T12:00:00.000Z",
        }),
        item({
          id: "new-but-stale",
          sessionId: "s-new",
          createdAt: "2026-11-14T10:00:00.000Z",
          updatedAt: "2026-11-14T10:00:00.000Z",
        }),
      ],
      { tab: "attention" },
    );
    expect(groups.map((g) => g.key)).toEqual(["session:s-old", "session:s-new"]);
  });

  it("未读组之间按最近活动倒序（最新未读在上）", () => {
    const groups = groupInboxItems(
      [
        item({
          id: "unread-old",
          sessionId: "s-unread-old",
          createdAt: "2026-11-15T10:00:00.000Z",
        }),
        item({
          id: "unread-new",
          sessionId: "s-unread-new",
          createdAt: "2026-11-15T12:00:00.000Z",
        }),
      ],
      { tab: "attention" },
    );
    expect(groups.map((g) => g.key)).toEqual([
      "session:s-unread-new",
      "session:s-unread-old",
    ]);
  });
});
