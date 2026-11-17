import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  clearRunCheckpoint,
  clearRunCheckpointsForSession,
  pruneRunCheckpoints,
  pushRunCheckpoint,
  resetRunCheckpointsForTest,
  runCheckpointsForTest,
  type RunCheckpoint,
} from "@/lib/pi/pi-checkpoints";

/**
 * pushRunCheckpoint 去重规则（锚点改双键后）：
 * - 带稳定 id（pi-msg:<seq>）：同 id 重结算替换；同轮老条目（仅 index）一并替换
 * - 仅 index（老数据/降级）：沿用旧规则，同 index 替换、null 清 null
 */

const cp = (files: number): RunCheckpoint => ({
  cwd: "/w",
  hash: `hash-${files}-${Math.random().toString(36).slice(2, 8)}`,
  files,
  added: files,
  removed: 0,
});

describe("pushRunCheckpoint 去重", () => {
  test("同 anchorMessageId 重结算替换旧条目", () => {
    pushRunCheckpoint(
      "t-dedup-id",
      { anchorIndex: 2, anchorMessageId: "pi-msg:7" },
      cp(1),
    );
    pushRunCheckpoint(
      "t-dedup-id",
      { anchorIndex: 2, anchorMessageId: "pi-msg:7" },
      cp(5),
    );
    const list = runCheckpointsForTest("t-dedup-id");
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toBe(5);
    expect(list[0]?.anchorMessageId).toBe("pi-msg:7");
  });

  test("新条目带 id 时同轮老条目（仅 index）一并替换，防新老并存两张卡", () => {
    pushRunCheckpoint("t-dedup-mix", { anchorIndex: 3 }, cp(1));
    pushRunCheckpoint(
      "t-dedup-mix",
      { anchorIndex: 3, anchorMessageId: "pi-msg:9" },
      cp(2),
    );
    const list = runCheckpointsForTest("t-dedup-mix");
    expect(list).toHaveLength(1);
    expect(list[0]?.anchorMessageId).toBe("pi-msg:9");
  });

  test("不同轮（不同 id）互不影响", () => {
    pushRunCheckpoint(
      "t-dedup-multi",
      { anchorIndex: 0, anchorMessageId: "pi-msg:3" },
      cp(1),
    );
    pushRunCheckpoint(
      "t-dedup-multi",
      { anchorIndex: 4, anchorMessageId: "pi-msg:11" },
      cp(2),
    );
    expect(runCheckpointsForTest("t-dedup-multi")).toHaveLength(2);
  });

  test("锚点未知（null）清掉旧的未知锚点条目，避免末尾兜底堆叠", () => {
    pushRunCheckpoint("t-dedup-null", { anchorIndex: null }, cp(1));
    pushRunCheckpoint("t-dedup-null", { anchorIndex: null }, cp(2));
    const list = runCheckpointsForTest("t-dedup-null");
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toBe(2);
  });
});

/**
 * 持久层口径（重启后卡片仍在的根因回归）：
 * - 已结算列表必须落 localStorage——sessionStorage 的命名空间每次应用启动
 *   都换新 GUID，重启后读不到（现场：重启后检查点卡整批消失）；
 * - 老版本落在 sessionStorage 的数据首次读取时迁移；
 * - 撤销要同时清掉两处键。
 */

type MemStorage = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
};

function memoryStorage(): MemStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("持久层：跨应用重启存活", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  beforeAll(() => {
    // 只在本 describe 生命周期内提供 window（bun 测试环境没有 DOM）
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: session,
    };
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("已结算条目落 localStorage，模拟重启（清内存）后仍可读回", () => {
    const thread = "t-restart-cp";
    pushRunCheckpoint(
      thread,
      { anchorIndex: 1, anchorMessageId: "pi-msg:5" },
      cp(3),
    );
    expect(local.getItem(`pi-run-cp:${thread}`)).toBeTruthy();
    // 应用重启 = 渲染进程内存全丢，只剩持久层
    resetRunCheckpointsForTest();
    const list = runCheckpointsForTest(thread);
    expect(list).toHaveLength(1);
    expect(list[0]?.files).toBe(3);
    expect(list[0]?.anchorMessageId).toBe("pi-msg:5");
  });

  test("老 sessionStorage 数据首次读取即迁移到 localStorage", () => {
    const thread = "t-legacy-cp";
    const legacyEntry = {
      cwd: "/w",
      hash: "hash-legacy",
      files: 2,
      added: 4,
      removed: 1,
      anchorIndex: 0,
      anchorMessageId: "pi-msg:2",
    };
    session.setItem(`pi-run-cp:${thread}`, JSON.stringify([legacyEntry]));
    resetRunCheckpointsForTest();
    const list = runCheckpointsForTest(thread);
    expect(list).toHaveLength(1);
    expect(list[0]?.hash).toBe("hash-legacy");
    // 迁移完成：新键有值、老键已清（幂等，不会每次启动都迁）
    expect(local.getItem(`pi-run-cp:${thread}`)).toBeTruthy();
    expect(session.getItem(`pi-run-cp:${thread}`)).toBeNull();
  });

  test("新键是脏数据时回退老 sessionStorage，且只迁移可解析的数据", () => {
    const thread = "t-corrupt-cp";
    local.setItem(`pi-run-cp:${thread}`, "{bad json");
    session.setItem(
      `pi-run-cp:${thread}`,
      JSON.stringify([
        { cwd: "/w", hash: "hash-ok", files: 1, added: 1, removed: 0, anchorIndex: 0 },
      ]),
    );
    resetRunCheckpointsForTest();
    const list = runCheckpointsForTest(thread);
    expect(list).toHaveLength(1);
    expect(list[0]?.hash).toBe("hash-ok");
    // 损坏的新键被合法老数据覆盖，老键清掉
    expect(local.getItem(`pi-run-cp:${thread}`)).toContain("hash-ok");
    expect(session.getItem(`pi-run-cp:${thread}`)).toBeNull();
  });

  test("撤销同时清 localStorage 与遗留 sessionStorage 键", () => {
    const thread = "t-clear-cp";
    pushRunCheckpoint(
      thread,
      { anchorIndex: 2, anchorMessageId: "pi-msg:8" },
      { cwd: "/w", hash: "hash-clear", files: 1, added: 1, removed: 0 },
    );
    // 老版本遗留键（同 thread）不能在被撤销后又被迁移回来
    session.setItem(`pi-run-cp:${thread}`, "[]");
    clearRunCheckpoint(thread, "hash-clear");
    expect(local.getItem(`pi-run-cp:${thread}`)).toBeNull();
    expect(session.getItem(`pi-run-cp:${thread}`)).toBeNull();
    resetRunCheckpointsForTest();
    expect(runCheckpointsForTest(thread)).toHaveLength(0);
  });
});

describe("会话删除清理", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: session,
    };
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("会话删除清掉该会话在持久层的条目（含遗留 sessionStorage 键）", () => {
    const thread = "t-delete-cp";
    pushRunCheckpoint(
      thread,
      { anchorIndex: 0, anchorMessageId: "pi-msg:1" },
      cp(2),
    );
    session.setItem(`pi-run-cp:${thread}`, "[]");
    clearRunCheckpointsForSession(thread);
    expect(local.getItem(`pi-run-cp:${thread}`)).toBeNull();
    expect(session.getItem(`pi-run-cp:${thread}`)).toBeNull();
    resetRunCheckpointsForTest();
    expect(runCheckpointsForTest(thread)).toHaveLength(0);
  });
});

describe("持久层 GC（归档超期 / 已删会话）", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: session,
    };
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const writeCp = (sid: string) =>
    pushRunCheckpoint(
      sid,
      { anchorIndex: 0, anchorMessageId: "pi-msg:1" },
      { cwd: "/w", hash: `h-${sid}`, files: 1, added: 1, removed: 0 },
    );

  test("归档超期/已删会话清掉；近活动、未归档、时间未知保留", () => {
    writeCp("t-gc-old-archived");
    writeCp("t-gc-recent-archived");
    writeCp("t-gc-active");
    writeCp("t-gc-gone");
    const now = Date.parse("2026-11-17T00:00:00.000Z");
    const old = new Date(now - 40 * 86_400_000).toISOString();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    pruneRunCheckpoints(
      [
        { sessionId: "t-gc-old-archived", archived: true, modified: old },
        { sessionId: "t-gc-recent-archived", archived: true, modified: recent },
        { sessionId: "t-gc-active", archived: false, modified: old },
      ],
      { pruneMissing: true, now },
    );
    expect(local.getItem("pi-run-cp:t-gc-old-archived")).toBeNull();
    expect(local.getItem("pi-run-cp:t-gc-recent-archived")).toBeTruthy();
    expect(local.getItem("pi-run-cp:t-gc-active")).toBeTruthy();
    // 快照里没有（别处已删）→ 清
    expect(local.getItem("pi-run-cp:t-gc-gone")).toBeNull();
  });

  test("归档但 modified 缺失：保守保留（不猜时间）", () => {
    writeCp("t-gc-no-time");
    pruneRunCheckpoints(
      [{ sessionId: "t-gc-no-time", archived: true }],
      { now: Date.now() },
    );
    expect(local.getItem("pi-run-cp:t-gc-no-time")).toBeTruthy();
  });

  test("pruneMissing 未开启时不清快照外的会话（分页/局部列表安全）", () => {
    writeCp("t-gc-outside");
    pruneRunCheckpoints([], { now: Date.now() });
    expect(local.getItem("pi-run-cp:t-gc-outside")).toBeTruthy();
  });
});

describe("内存缓存 LRU", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: local,
      sessionStorage: session,
    };
  });
  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("超过上限淘汰最久未访问的键，数据仍在持久层可读回", () => {
    resetRunCheckpointsForTest();
    for (let i = 0; i < 70; i += 1) {
      pushRunCheckpoint(
        `t-lru-${i}`,
        { anchorIndex: 0, anchorMessageId: `pi-msg:${i}` },
        { cwd: "/w", hash: `h-t-lru-${i}`, files: 1, added: 1, removed: 0 },
      );
    }
    // 最早的键已被淘汰出内存缓存，冷读回落到 localStorage 仍完整
    const first = runCheckpointsForTest("t-lru-0");
    expect(first).toHaveLength(1);
    expect(first[0]?.hash).toBe("h-t-lru-0");
    // 最近的键仍在（内容稳定）
    expect(runCheckpointsForTest("t-lru-69")).toHaveLength(1);
  });
});
