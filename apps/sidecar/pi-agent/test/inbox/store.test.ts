import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "pi-protocol";
import {
  InboxError,
  getInboxCounts,
  getInboxItem,
  initInbox,
  listInbox,
  resetInboxForTest,
  setInboxDirForTest,
  removeInboxItemsForAutomationRuns,
  resolveInboxItem,
  resolveInboxItemsForAutomationTask,
  setInboxBroadcaster,
  updateInboxState,
  upsertInboxItem,
} from "../../src/inbox/store";

let dir = "";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  const now = new Date().toISOString();
  return {
    id: "approval:a1",
    kind: "approval",
    state: "open",
    outcome: "needs_action",
    priority: 0,
    requiresAction: true,
    title: "需要批准：bash",
    summary: "rm -rf build",
    sourceId: "a1",
    sessionId: "s1",
    threadId: "t1",
    createdAt: now,
    updatedAt: now,
    actions: ["open", "approve", "deny", "mark_read"],
    deepLink: { sessionId: "s1", threadId: "t1" },
    hasDetail: true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kova-inbox-"));
  resetInboxForTest();
  setInboxDirForTest(join(dir, "sessions", "inbox"));
  initInbox({ enabled: true });
  setInboxBroadcaster(null);
});

afterEach(() => {
  resetInboxForTest();
  // 不删临时目录：sessionsDirRoot 是模块级全局，删掉会让同进程后续测试文件
  // 写到已消失的目录（bun test 同进程共享模块状态）。/tmp 由系统回收。
});

describe("inbox store", () => {
  it("upsert / list：open 条目进入待处理并计入 needsAction", () => {
    upsertInboxItem(item());
    const res = listInbox({ tab: "action" });
    expect(res.items.map((x) => x.id)).toEqual(["approval:a1"]);
    expect(res.counts.needsAction).toBe(1);
    expect(res.counts.unread).toBe(1);
    expect(res.counts.open).toBe(1);
  });

  it("重复 upsert 同一内容不产生第二条", () => {
    upsertInboxItem(item());
    upsertInboxItem(item());
    expect(listInbox({ tab: "action" }).items).toHaveLength(1);
  });

  it("resolve：条目转入 done，needsAction 归零", () => {
    upsertInboxItem(item());
    expect(resolveInboxItem("approval:a1", "approved")).toBe(true);
    const got = getInboxItem("approval:a1");
    expect(got?.state).toBe("done");
    expect(got?.outcome).toBe("approved");
    expect(got?.requiresAction).toBe(false);
    expect(got?.readAt).toBeTruthy();
    expect(got?.actions).toEqual(["open", "mark_read", "archive"]);
    expect(getInboxCounts().needsAction).toBe(0);
    expect(getInboxCounts().attention).toBe(0);
    expect(getInboxCounts().unread).toBe(0);
    expect(listInbox({ tab: "done" }).items.map((x) => x.id)).toEqual(["approval:a1"]);
  });

  it("resolve 不存在的条目返回 false（陈旧结算不报错）", () => {
    expect(resolveInboxItem("approval:missing", "cancelled")).toBe(false);
  });

  it("用户状态：已读/归档持久化，并在重启后恢复", () => {
    upsertInboxItem(item());
    updateInboxState(["approval:a1"], { read: true });
    expect(getInboxItem("approval:a1")?.readAt).toBeTruthy();
    expect(getInboxCounts().unread).toBe(0);

    // 模拟 sidecar 重启：清内存，重新初始化后从 events/state 回放
    resetInboxForTest();
    setInboxDirForTest(join(dir, "sessions", "inbox"));
    initInbox({ enabled: true });
    const got = getInboxItem("approval:a1");
    expect(got?.id).toBe("approval:a1");
    expect(got?.readAt).toBeTruthy();
  });

  it("未结算的阻塞项不允许归档", () => {
    upsertInboxItem(item());
    expect(() => updateInboxState(["approval:a1"], { archived: true })).toThrow(InboxError);
  });

  it("已结束条目可以归档，archived Tab 可见", () => {
    upsertInboxItem(item());
    resolveInboxItem("approval:a1", "approved");
    updateInboxState(["approval:a1"], { archived: true });
    expect(getInboxCounts().archived).toBe(1);
    expect(listInbox({ tab: "archived" }).items.map((x) => x.id)).toEqual(["approval:a1"]);
  });

  it("snooze 未到期时从默认列表隐藏，到期后重现", () => {
    upsertInboxItem(item());
    updateInboxState(["approval:a1"], {
      snoozedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(listInbox({ tab: "action" }).items).toHaveLength(0);
    expect(listInbox({ tab: "action", includeSnoozed: true }).items).toHaveLength(1);
    expect(getInboxCounts().needsAction).toBe(0);
  });

  it("snooze 中的审批结算后清掉 snooze，能进入历史", () => {
    upsertInboxItem(item());
    updateInboxState(["approval:a1"], {
      snoozedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(listInbox({ tab: "action" }).items).toHaveLength(0);
    resolveInboxItem("approval:a1", "approved");
    const done = listInbox({ tab: "done" });
    expect(done.items.map((x) => x.id)).toEqual(["approval:a1"]);
    expect(done.items[0]?.snoozedUntil).toBeUndefined();
  });

  it("tab 语义：失败但 done 的条目留在待处理，不混进已完成", () => {
    upsertInboxItem(
      item({
        id: "automation:task:run",
        kind: "automation",
        state: "done",
        outcome: "failed",
        priority: 1,
        requiresAction: true,
        title: "自动化失败：发布检查",
        sourceId: "run",
        actions: ["open", "retry", "mark_read", "archive"],
      }),
    );
    expect(listInbox({ tab: "action" }).items[0]?.id).toBe("automation:task:run");
    expect(listInbox({ tab: "done" }).items).toHaveLength(0);
  });

  it("同标题但 meta/优先级变化仍会覆盖（外部状态更新不能丢）", () => {
    upsertInboxItem(
      item({
        id: "external:github:o/r#1",
        kind: "external",
        state: "done",
        outcome: "success",
        requiresAction: false,
        sourceId: "o/r#1",
        sessionId: undefined,
        threadId: undefined,
        external: { provider: "github", key: "o/r#1", status: "open" },
        meta: { provider: "github", status: "open" },
      }),
    );
    upsertInboxItem(
      item({
        id: "external:github:o/r#1",
        kind: "external",
        state: "done",
        outcome: "success",
        requiresAction: true,
        priority: 1,
        sourceId: "o/r#1",
        sessionId: undefined,
        threadId: undefined,
        external: { provider: "github", key: "o/r#1", status: "changes_requested" },
        meta: { provider: "github", status: "changes_requested" },
      }),
    );
    const got = getInboxItem("external:github:o/r#1");
    expect(got?.requiresAction).toBe(true);
    expect(got?.priority).toBe(1);
    expect(got?.external?.status).toBe("changes_requested");
  });

  it("同一外部项更新后重新变为未读/待关注", () => {
    const base = item({
      id: "external:github:o/r#2",
      kind: "external",
      state: "done",
      outcome: "success",
      requiresAction: false,
      sourceId: "o/r#2",
      external: { provider: "github", key: "o/r#2", status: "open" },
    });
    upsertInboxItem(base);
    updateInboxState([base.id], { read: true });
    expect(getInboxCounts().attention).toBe(0);

    upsertInboxItem({
      ...base,
      external: { provider: "github", key: "o/r#2", status: "changes_requested" },
    });
    expect(getInboxItem(base.id)?.readAt).toBeUndefined();
    expect(getInboxCounts().attention).toBe(1);
  });

  it("批量更新里有一条非法时，前面的条目也不能被半改", () => {
    upsertInboxItem(
      item({
        id: "automation:t:r",
        kind: "automation",
        state: "done",
        outcome: "success",
        requiresAction: false,
        sourceId: "r",
        actions: ["open", "mark_read", "archive"],
      }),
    );
    upsertInboxItem(item({ id: "approval:a2", sourceId: "a2" }));
    expect(() =>
      updateInboxState(["automation:t:r", "approval:a2"], {
        read: true,
        archived: true,
      }),
    ).toThrow(InboxError);
    // 第一条 read/archived 都不能落内存
    expect(getInboxItem("automation:t:r")?.readAt).toBeUndefined();
    expect(getInboxItem("automation:t:r")?.archivedAt).toBeUndefined();
  });

  it("旧日志里被 Stop 的自动化迁移成 stopped 历史项", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "kova-inbox-legacy-"));
    const inbox = join(legacyDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const legacy = item({
      id: "automation:t:old",
      kind: "automation",
      state: "done",
      outcome: "failed",
      requiresAction: true,
      title: "自动化失败：每日天气",
      summary: "run aborted by stop request",
      actions: ["open", "retry", "mark_read", "archive"],
      meta: { taskId: "t", taskName: "每日天气", runId: "old", ok: false },
    });
    writeFileSync(
      join(inbox, "events.jsonl"),
      JSON.stringify({ v: 1, op: "upsert", at: new Date().toISOString(), item: legacy }) + "\n",
    );
    resetInboxForTest();
    setInboxDirForTest(inbox);
    initInbox({ enabled: true });
    const migrated = getInboxItem("automation:t:old");
    expect(migrated?.outcome).toBe("stopped");
    expect(migrated?.requiresAction).toBe(false);
    expect(migrated?.readAt).toBeTruthy();
    expect(getInboxCounts().attention).toBe(0);

    // 迁移只做一次：用户后来手动标未读，重启不能被迁移重新盖成已读
    updateInboxState(["automation:t:old"], { read: false });
    resetInboxForTest();
    setInboxDirForTest(inbox);
    initInbox({ enabled: true });
    expect(getInboxItem("automation:t:old")?.readAt).toBeUndefined();
  });

  it("游标所在条目被归档后，下一页从排序位置继续而不是从第一页重来", () => {
    for (const [id, hour] of [
      ["automation:t:r1", 10],
      ["automation:t:r2", 11],
      ["automation:t:r3", 12],
    ] as const) {
      upsertInboxItem(
        item({
          id,
          kind: "automation",
          state: "done",
          outcome: "success",
          requiresAction: false,
          sourceId: id,
          createdAt: `2026-11-15T${hour}:00:00.000Z`,
          updatedAt: `2026-11-15T${hour}:00:00.000Z`,
          actions: ["open", "mark_read", "archive"],
        }),
      );
    }
    const first = listInbox({ tab: "done" }, 2);
    expect(first.items.map((x) => x.id)).toEqual([
      "automation:t:r3",
      "automation:t:r2",
    ]);
    expect(first.nextCursor).toBeTruthy();
    updateInboxState(["automation:t:r2"], { archived: true });
    const second = listInbox({ tab: "done" }, 2, first.nextCursor);
    expect(second.items.map((x) => x.id)).toEqual(["automation:t:r1"]);
  });

  it("暂停自动化任务会收掉该任务的待处理失败项", () => {
    upsertInboxItem(
      item({
        id: "automation:weather:r1",
        kind: "automation",
        state: "done",
        outcome: "failed",
        requiresAction: true,
        sourceId: "r1",
        meta: { taskId: "weather", taskName: "每日天气", runId: "r1", ok: false },
      }),
    );
    expect(getInboxCounts().attention).toBe(1);
    expect(resolveInboxItemsForAutomationTask("weather")).toBe(1);
    const got = getInboxItem("automation:weather:r1");
    expect(got?.requiresAction).toBe(false);
    expect(got?.readAt).toBeTruthy();
    expect(getInboxCounts().attention).toBe(0);
  });

  it("删除运行记录会物理移除对应 Inbox 条目", () => {
    upsertInboxItem(
      item({
        id: "automation:weather:r9",
        kind: "automation",
        state: "done",
        outcome: "success",
        requiresAction: false,
        sourceId: "r9",
        meta: { taskId: "weather", taskName: "每日天气", runId: "r9", ok: true },
      }),
    );
    expect(getInboxItem("automation:weather:r9")).toBeTruthy();
    expect(removeInboxItemsForAutomationRuns("weather", new Set(["r9"]))).toBe(1);
    expect(getInboxItem("automation:weather:r9")).toBeUndefined();
    expect(getInboxCounts().done).toBe(0);
  });

  it("广播帧带最新 counts，且多次变更合并为一条", async () => {
    const frames: Array<{ type: string; counts: { needsAction: number } }> = [];
    setInboxBroadcaster((frame) => frames.push(frame));
    upsertInboxItem(item());
    upsertInboxItem(item({ id: "question:q1", kind: "question", sourceId: "q1" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("inbox_changed");
    expect(frames[0]?.counts.needsAction).toBe(2);
  });
});
