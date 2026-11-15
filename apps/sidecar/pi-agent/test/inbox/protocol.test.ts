import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "pi-protocol";
import { dispatch } from "../../src/protocol/protocol";
import {
  initInbox,
  resetInboxForTest,
  setInboxDirForTest,
  setInboxBroadcaster,
  upsertInboxItem,
} from "../../src/inbox/store";

const tmp = mkdtempSync(join(tmpdir(), "kova-inbox-protocol-"));
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
  setInboxDirForTest(join(tmp, "sessions", "inbox"));
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
});
