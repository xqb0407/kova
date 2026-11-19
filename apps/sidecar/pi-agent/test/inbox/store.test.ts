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
  setInboxItemsArchivedForSession,
  removeInboxItemsForAutomationRuns,
  resolveInboxItem,
  resolveInboxItemsForAutomationTask,
  setInboxBroadcaster,
  updateInboxState,
  updateInboxStateForFilter,
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

  it("归档 → 已归档 → 恢复：条目回到历史，archived 计数归零", () => {
    upsertInboxItem(item());
    resolveInboxItem("approval:a1", "approved");
    updateInboxState(["approval:a1"], { archived: true });
    expect(listInbox({ tab: "archived" }).items.map((x) => x.id)).toEqual(["approval:a1"]);

    // 已归档 Tab 的「恢复」按钮走同一条 updateInboxState(archived:false)
    updateInboxState(["approval:a1"], { archived: false });
    expect(listInbox({ tab: "archived" }).items).toHaveLength(0);
    expect(listInbox({ tab: "done" }).items.map((x) => x.id)).toEqual(["approval:a1"]);
    expect(getInboxCounts().archived).toBe(0);
  });

  it("已归档条目可墓碑删除：列表/计数/详情消失，源再次 upsert 不复活", () => {
    upsertInboxItem(item());
    resolveInboxItem("approval:a1", "approved");
    updateInboxState(["approval:a1"], { archived: true });
    updateInboxState(["approval:a1"], { deleted: true });

    expect(listInbox({ tab: "archived" }).items).toHaveLength(0);
    expect(listInbox({ tab: "all" }).items).toHaveLength(0);
    expect(getInboxCounts()).toEqual({
      needsAction: 0,
      unread: 0,
      attention: 0,
      open: 0,
      done: 0,
      archived: 0,
    });
    // 详情也当不存在；删除后不能再被操作
    expect(getInboxItem("approval:a1")).toBeUndefined();

    // 源侧同 ID 再次上报（标题有实质更新）也不能把墓碑顶掉
    upsertInboxItem(item({ title: "更新后的标题" }));
    expect(listInbox({ tab: "all" }).items).toHaveLength(0);
    expect(getInboxItem("approval:a1")).toBeUndefined();
  });

  it("历史条目（已读已结束）可直接删除", () => {
    upsertInboxItem(item());
    resolveInboxItem("approval:a1", "approved");
    // resolve 自动置已读：条目在「历史」里且未归档
    expect(listInbox({ tab: "history" }).items.map((x) => x.id)).toEqual(["approval:a1"]);

    updateInboxState(["approval:a1"], { deleted: true });
    expect(listInbox({ tab: "history" }).items).toHaveLength(0);
    expect(getInboxItem("approval:a1")).toBeUndefined();
  });

  it("open 条目不允许删除（避免误删仍在等处理的事项）", () => {
    upsertInboxItem(item());
    expect(() => updateInboxState(["approval:a1"], { deleted: true })).toThrow(InboxError);
  });

  it("墓碑删除跨重启保持：state.json 回放后仍然隐藏", () => {
    upsertInboxItem(item());
    resolveInboxItem("approval:a1", "approved");
    updateInboxState(["approval:a1"], { archived: true });
    updateInboxState(["approval:a1"], { deleted: true });

    resetInboxForTest();
    setInboxDirForTest(join(dir, "sessions", "inbox"));
    initInbox({ enabled: true });

    expect(listInbox({ tab: "all" }).items).toHaveLength(0);
    expect(getInboxItem("approval:a1")).toBeUndefined();
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

  it("归档会清掉 snooze：条目不会既归档又被 snooze 藏起来", () => {
    upsertInboxItem(
      item({
        id: "automation:t:s1",
        kind: "automation",
        state: "done",
        outcome: "success",
        requiresAction: false,
        priority: 2,
        sourceId: "s1",
        actions: ["open", "mark_read", "archive"],
      }),
    );
    updateInboxState(["automation:t:s1"], {
      snoozedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    updateInboxState(["automation:t:s1"], { archived: true });
    const archived = listInbox({ tab: "archived" });
    expect(archived.items.map((x) => x.id)).toEqual(["automation:t:s1"]);
    expect(archived.items[0]?.snoozedUntil).toBeUndefined();
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

  it("attention / history 服务端分页：历史条目不占待关注名额", () => {
    const done = (suffix: string, hour: number, read: boolean) => {
      const id = `automation:t:${suffix}`;
      upsertInboxItem(
        item({
          id,
          kind: "automation",
          state: "done",
          outcome: "success",
          requiresAction: false,
          priority: 2,
          sourceId: id,
          sessionId: `s-${id}`,
          threadId: `t-${id}`,
          createdAt: `2026-11-15T${hour}:00:00.000Z`,
          updatedAt: `2026-11-15T${hour}:00:00.000Z`,
          actions: ["open", "mark_read", "archive"],
        }),
      );
      if (read) updateInboxState([id], { read: true });
    };
    done("r1", 10, true);
    done("r2", 11, true);
    done("r3", 12, false);

    const attention = listInbox({ tab: "attention" }, 50);
    expect(attention.items.map((x) => x.id)).toEqual(["automation:t:r3"]);
    expect(attention.nextCursor).toBeUndefined();
    const history = listInbox({ tab: "history" }, 50);
    expect(history.items.map((x) => x.id)).toEqual([
      "automation:t:r2",
      "automation:t:r1",
    ]);

    // 归档后必须从历史移出，只在已归档 Tab 出现（否则“归档了还在”）
    updateInboxState(["automation:t:r1"], { archived: true });
    expect(listInbox({ tab: "history" }, 50).items.map((x) => x.id)).toEqual([
      "automation:t:r2",
    ]);
    expect(listInbox({ tab: "archived" }, 50).items.map((x) => x.id)).toEqual([
      "automation:t:r1",
    ]);
  });

  it("全部已读跨分页生效：未加载的历史未读不再从「加载更多」冒出来", () => {
    const total = 120;
    for (let i = 0; i < total; i += 1) {
      const minute = String(i % 60).padStart(2, "0");
      const hour = String(10 + Math.floor(i / 60)).padStart(2, "0");
      upsertInboxItem(
        item({
          id: `automation:bulk:r${i}`,
          kind: "automation",
          state: "done",
          outcome: "success",
          requiresAction: false,
          priority: 2,
          sourceId: `r${i}`,
          sessionId: `s${i}`,
          threadId: `t${i}`,
          createdAt: `2026-11-15T${hour}:${minute}:00.000Z`,
          updatedAt: `2026-11-15T${hour}:${minute}:00.000Z`,
          actions: ["open", "mark_read", "archive"],
        }),
      );
    }
    const first = listInbox({ tab: "attention" }, 50);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();

    // 只清第一页的旧实现会留下 70 条未读，下一页一拉又回到待关注
    const result = updateInboxStateForFilter({ tab: "attention" }, { read: true });
    expect(result.itemIds).toHaveLength(total);
    expect(getInboxCounts().unread).toBe(0);
    expect(getInboxCounts().attention).toBe(0);
    const after = listInbox({ tab: "attention" }, 50);
    expect(after.items).toHaveLength(0);
    expect(after.nextCursor).toBeUndefined();
  });

  it("会话归档联动：收起可归档条目，阻塞项保留；取消归档只恢复随会话归档的条目", () => {
    const regular = (id: string) =>
      item({
        id,
        kind: "automation",
        state: "done",
        outcome: "success",
        requiresAction: false,
        priority: 2,
        sourceId: id,
        sessionId: "s-archive",
        threadId: "s-archive",
        actions: ["open", "mark_read", "archive"],
      });
    upsertInboxItem(regular("automation:s-archive:done"));
    upsertInboxItem(
      item({
        id: "approval:blocking",
        sourceId: "blocking",
        sessionId: "s-archive",
        threadId: "s-archive",
      }),
    );
    // 另一个会话的条目不应被误伤
    upsertInboxItem(
      item({
        id: "automation:other:done",
        kind: "automation",
        state: "done",
        outcome: "success",
        requiresAction: false,
        priority: 2,
        sourceId: "other",
        sessionId: "s-other",
        threadId: "s-other",
        actions: ["open", "mark_read", "archive"],
      }),
    );

    expect(setInboxItemsArchivedForSession("s-archive", true)).toBe(1);
    expect(getInboxItem("automation:s-archive:done")?.archivedAt).toBeTruthy();
    // 未结算的阻塞审批不能被会话归档藏掉
    expect(getInboxItem("approval:blocking")?.archivedAt).toBeUndefined();
    expect(getInboxItem("automation:other:done")?.archivedAt).toBeUndefined();

    // 归档联动标记要跨重启保留：重启后取消会话归档仍能恢复
    resetInboxForTest();
    setInboxDirForTest(join(dir, "sessions", "inbox"));
    initInbox({ enabled: true });
    expect(getInboxItem("automation:s-archive:done")?.archivedAt).toBeTruthy();
    expect(setInboxItemsArchivedForSession("s-archive", false)).toBe(1);
    expect(getInboxItem("automation:s-archive:done")?.archivedAt).toBeUndefined();

    // 用户手动归档过的条目不会被“取消会话归档”翻出来
    updateInboxState(["automation:s-archive:done"], { archived: true });
    expect(setInboxItemsArchivedForSession("s-archive", false)).toBe(0);
    expect(getInboxItem("automation:s-archive:done")?.archivedAt).toBeTruthy();
  });
});
