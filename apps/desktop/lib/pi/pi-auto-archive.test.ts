/**
 * 自动归档测试：候选筛选纯函数（status/remoteId/置顶/未读/运行中/保留期
 * 边界/当前线程双键）与偏好 store 的归一化（脏天数回退默认）。
 * 不装伪 window——load/persist 对缺 window 均安全（与 pi-unread-sessions
 * 测试同款约定）。
 */
import { describe, expect, test } from "bun:test";
import {
  AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS,
  collectAutoArchiveCandidates,
  getAutoArchivePrefs,
  getRestoredSessions,
  recordSessionRestored,
  setAutoArchiveRetentionDays,
  type AutoArchiveCandidateInput,
  type AutoArchiveItemInput,
} from "./pi-auto-archive";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const item = (over: Partial<AutoArchiveItemInput> = {}): AutoArchiveItemInput => ({
  id: "t1",
  remoteId: "s1",
  status: "regular",
  lastMessageAt: new Date(NOW - 10 * DAY),
  ...over,
});

function collect(over: Partial<AutoArchiveCandidateInput> = {}): string[] {
  return collectAutoArchiveCandidates({
    items: [item()],
    pinnedIds: new Set(),
    unreadIds: new Set(),
    restoredAts: new Map(),
    isRunning: () => false,
    keepIds: new Set(),
    retentionDays: 7,
    nowMs: NOW,
    ...over,
  });
}

describe("collectAutoArchiveCandidates", () => {
  test("超过保留期的已完成会话入选", () => {
    expect(collect()).toEqual(["t1"]);
  });

  test("保留期边界：期内不选，恰好等于期长可选", () => {
    expect(
      collect({ items: [item({ lastMessageAt: new Date(NOW - 6 * DAY) })] }),
    ).toEqual([]);
    expect(
      collect({ items: [item({ lastMessageAt: new Date(NOW - 7 * DAY) })] }),
    ).toEqual(["t1"]);
  });

  test("置顶 / 未读 / 运行中一律排除", () => {
    expect(collect({ pinnedIds: new Set(["s1"]) })).toEqual([]);
    expect(collect({ unreadIds: new Set(["s1"]) })).toEqual([]);
    expect(collect({ isRunning: () => true })).toEqual([]);
  });

  test("new/archived 状态与未落盘（无 remoteId）不可归档", () => {
    expect(collect({ items: [item({ status: "new" })] })).toEqual([]);
    expect(collect({ items: [item({ status: "archived" })] })).toEqual([]);
    expect(collect({ items: [item({ remoteId: undefined })] })).toEqual([]);
  });

  test("缺 lastMessageAt 不归档（无从判断新旧）", () => {
    expect(collect({ items: [item({ lastMessageAt: undefined })] })).toEqual(
      [],
    );
  });

  test("当前打开线程双键保留：aui id 与绑定的 sessionId", () => {
    expect(collect({ keepIds: new Set(["t1"]) })).toEqual([]);
    expect(collect({ keepIds: new Set(["s1"]) })).toEqual([]);
    // 草稿线程（__LOCALID_ id 已绑定 remoteId）：id 命中即保留
    expect(
      collect({
        items: [item({ id: "__LOCALID_draft" })],
        keepIds: new Set(["__LOCALID_draft"]),
      }),
    ).toEqual([]);
  });

  test("保留天数参与判定：30 天档下 10 天前的会话不入选", () => {
    expect(collect({ retentionDays: 30 })).toEqual([]);
  });

  test("恢复后保留期重置：期内不选，计满后重新入选", () => {
    // lastMessageAt 虽已超期，恢复 1 天 → 完整宽限期，不归档
    expect(
      collect({ restoredAts: new Map([["s1", NOW - 1 * DAY]]) }),
    ).toEqual([]);
    // 恰好计满（与 lastMessageAt 边界同款语义）与超期 → 重新入选
    expect(
      collect({ restoredAts: new Map([["s1", NOW - 7 * DAY]]) }),
    ).toEqual(["t1"]);
    expect(
      collect({ restoredAts: new Map([["s1", NOW - 8 * DAY]]) }),
    ).toEqual(["t1"]);
  });

  test("恢复重置不豁免 lastMessageAt：近活动会话仍不入选", () => {
    expect(
      collect({
        items: [item({ lastMessageAt: new Date(NOW - 1 * DAY) })],
        restoredAts: new Map([["s1", NOW - 10 * DAY]]),
      }),
    ).toEqual([]);
  });

  test("多条混合：只返回命中的 id", () => {
    expect(
      collect({
        items: [
          item({ id: "a", remoteId: "sa" }),
          item({ id: "b", remoteId: "sb", status: "new" }),
          item({ id: "c", remoteId: "sc" }),
          item({
            id: "d",
            remoteId: "sd",
            lastMessageAt: new Date(NOW - 1 * DAY),
          }),
          item({ id: "e", remoteId: "se" }),
        ],
        pinnedIds: new Set(["se"]),
        unreadIds: new Set(["sc"]),
      }),
    ).toEqual(["a"]);
  });
});

describe("pi-auto-archive prefs", () => {
  test("保留天数只接受档位内的值，脏输入回退默认", () => {
    setAutoArchiveRetentionDays(999);
    expect(getAutoArchivePrefs().retentionDays).toBe(
      AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS,
    );
    setAutoArchiveRetentionDays(14);
    expect(getAutoArchivePrefs().retentionDays).toBe(14);
    setAutoArchiveRetentionDays(AUTO_ARCHIVE_DEFAULT_RETENTION_DAYS);
  });
});

describe("recordSessionRestored", () => {
  test("登记恢复时刻，并清掉早于最大保留档的旧条目", () => {
    recordSessionRestored("s-old", NOW - 40 * DAY);
    recordSessionRestored("s-keep", NOW);
    expect(getRestoredSessions().get("s-keep")).toBe(NOW);
    // 30 天档是保护上限：更旧的恢复条目对任何档位都无保护作用，登记时顺手清
    recordSessionRestored("s-late", NOW + DAY);
    expect(getRestoredSessions().has("s-old")).toBe(false);
    expect(getRestoredSessions().get("s-keep")).toBe(NOW);
    expect(getRestoredSessions().get("s-late")).toBe(NOW + DAY);
  });
});
