import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "pi-protocol";
import { dispatch } from "../../src/protocol/protocol";
import {
  getInboxItem,
  initInbox,
  resetInboxForTest,
  resolveInboxItem,
  setInboxDirForTest,
  setInboxBroadcaster,
  updateInboxState,
  upsertInboxItem,
} from "../../src/inbox/store";

const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
  resetInboxForTest();
  // 同 store.test：不删全局 sessionsDirRoot 指向的目录，避免影响同进程后续文件
});

beforeEach(() => {
  resetInboxForTest();
  // 每个用例独立目录：journal/state 会跨用例累积，共享目录时前一个用例
  // 写入的条目（尤其墓碑）会污染后一个用例的计数断言
  setInboxDirForTest(join(mkdtempSync(join(tmpdir(), "kova-inbox-protocol-")), "sessions", "inbox"));
  initInbox({ enabled: true });
  setInboxBroadcaster(null);
  lines.length = 0;
});

const last = (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}");

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
    hasDetail: true,
    ...overrides,
  };
}

describe("inbox protocol", () => {
  it("list_inbox 空库返回空清单与零计数", async () => {
    await dispatch("i1", { type: "list_inbox" });
    expect(last()).toEqual({
      id: "i1",
      type: "inbox",
      items: [],
      counts: { needsAction: 0, unread: 0, attention: 0, open: 0, done: 0, archived: 0 },
      sources: [],
    });
  });

  it("list_inbox 返回投影条目", async () => {
    upsertInboxItem(item());
    await dispatch("i2", { type: "list_inbox", filter: { tab: "action" } });
    const res = last() as {
      items: InboxItem[];
      counts: { needsAction: number };
      sources: string[];
    };
    expect(res.items[0]?.id).toBe("approval:a1");
    expect(res.counts.needsAction).toBe(1);
    expect(res.sources).toEqual(["task"]);

    // 来源过滤在后端完成，菜单 facets 仍是全量
    await dispatch("i2b", { type: "list_inbox", filter: { tab: "all", source: "github" } });
    const filtered = last() as { items: InboxItem[]; sources: string[] };
    expect(filtered.items).toEqual([]);
    expect(filtered.sources).toEqual(["task"]);
  });

  it("inbox_item 找不到时返回结构化错误码", async () => {
    await dispatch("i3", { type: "inbox_item", itemId: "approval:missing" });
    expect(last()).toEqual({
      id: "i3",
      type: "error",
      errorText: "inbox: item not found: approval:missing",
      error: { code: "INBOX_ITEM_NOT_FOUND", source: "runtime", retryable: false },
    });
  });

  it("未结算阻塞项归档被拒绝", async () => {
    upsertInboxItem(item());
    await dispatch("i4", {
      type: "inbox_update",
      itemIds: ["approval:a1"],
      patch: { archived: true },
    });
    expect(last()).toEqual({
      id: "i4",
      type: "error",
      errorText:
        "inbox: cannot archive an open actionable item; resolve it or snooze it first",
      error: { code: "INBOX_ACTION_NOT_ALLOWED", source: "runtime", retryable: false },
    });
  });

  it("已归档条目可删除：动作成功、计数归零、详情转为不存在", async () => {
    // 用独立 id：墓碑会落在共享的 state.json 里，复用 approval:a1 会污染后续用例
    upsertInboxItem(
      item({
        id: "approval:del-archived",
        sourceId: "del-archived",
        state: "done",
        outcome: "approved",
        requiresAction: false,
        actions: ["open", "mark_read", "archive"],
      }),
    );
    updateInboxState(["approval:del-archived"], { archived: true });

    await dispatch("i-del", {
      type: "inbox_action",
      itemId: "approval:del-archived",
      action: "delete",
    });
    const res = last() as {
      type: string;
      action: string;
      counts: { archived: number };
    };
    expect(res.type).toBe("inbox_action_done");
    expect(res.action).toBe("delete");
    expect(res.counts.archived).toBe(0);

    await dispatch("i-del-item", { type: "inbox_item", itemId: "approval:del-archived" });
    expect((last() as { error?: { code: string } }).error?.code).toBe(
      "INBOX_ITEM_NOT_FOUND",
    );
  });

  it("历史条目可直接删除", async () => {
    upsertInboxItem(item({ id: "approval:hist", sourceId: "hist" }));
    resolveInboxItem("approval:hist", "approved");

    await dispatch("i-del-hist", {
      type: "inbox_action",
      itemId: "approval:hist",
      action: "delete",
    });
    const res = last() as { type: string; counts: { done: number } };
    expect(res.type).toBe("inbox_action_done");
    expect(res.counts.done).toBe(0);
  });

  it("open 条目删除被拒绝", async () => {
    upsertInboxItem(item({ id: "approval:del-open", sourceId: "del-open" }));
    await dispatch("i-del-open", {
      type: "inbox_action",
      itemId: "approval:del-open",
      action: "delete",
    });
    const res = last() as { type: string; error?: { code: string } };
    expect(res.type).toBe("error");
    expect(res.error?.code).toBe("INBOX_ACTION_NOT_ALLOWED");
  });

  it("inbox_update 已读返回最新 counts", async () => {
    upsertInboxItem(item());
    await dispatch("i5", {
      type: "inbox_update",
      itemIds: ["approval:a1"],
      patch: { read: true },
    });
    expect(last()).toEqual({
      id: "i5",
      type: "inbox_updated",
      itemIds: ["approval:a1"],
      counts: { needsAction: 1, unread: 0, attention: 1, open: 1, done: 0, archived: 0 },
    });
  });

  it("inbox_action 非法动作返回结构化错误码", async () => {
    upsertInboxItem(item());
    await dispatch("i6", {
      type: "inbox_action",
      itemId: "approval:a1",
      action: "nope",
    });
    expect(last()).toEqual({
      id: "i6",
      type: "error",
      errorText: "inbox: invalid action: nope",
      error: { code: "INBOX_ACTION_NOT_ALLOWED", source: "runtime", retryable: false },
    });
  });

  it("inbox_external_sync 推送外部快照并返回计数", async () => {
    await dispatch("i7", {
      type: "inbox_external_sync",
      provider: "github",
      connectorId: "github",
      items: [
        {
          idKey: "github.com/o/r#1",
          key: "o/r#1",
          title: "Fix login redirect",
          url: "https://github.com/o/r/issues/1",
          requiresAction: true,
          priority: 1,
        },
      ],
      complete: true,
    });
    expect(last()).toEqual({
      id: "i7",
      type: "inbox_external_sync_done",
      provider: "github",
      upserted: 1,
      resolved: 0,
      total: 1,
    });
    expect(getInboxItem("external:github:github.com/o/r#1")?.state).toBe("done");
  });

  it("inbox_external_sync 非法载荷返回结构化错误码", async () => {
    await dispatch("i8", {
      type: "inbox_external_sync",
      provider: "",
      items: [],
    });
    const frame = last() as {
      type?: string;
      error?: { code?: string };
      errorText?: string;
    };
    expect(frame.type).toBe("error");
    expect(frame.error?.code).toBe("INBOX_INVALID_EXTERNAL_SYNC");
    expect(frame.errorText).toContain("invalid external sync");
  });
});
