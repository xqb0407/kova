import { describe, expect, test } from "bun:test";
import { createPiLastThreadStorage } from "@/lib/pi/pi-last-thread";

/**
 * "最近打开的会话"指针的存取语义测试（刷新回切兜底的存储层防线）：
 * record/read/clear 往返一致；clear 是 2026-09-22 修复加的——用户切到新
 * 对话时作废指针，否则点完新对话刷新会被拉回切换前的旧会话。
 * 两种清空严格区分：clear 是写通（主线程状态同步，不计数），userNewThread
 * 是用户动作（清空并计数，启动回切的意图复查只看计数增量）。
 */

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function setup() {
  const store = memStorage();
  return { store, api: createPiLastThreadStorage(() => store) };
}

describe("pi-last-thread", () => {
  test("record 后可 read，read 即当前值", () => {
    const { api } = setup();
    expect(api.read()).toBeNull();
    api.record("session-a");
    expect(api.read()).toBe("session-a");
    api.record("session-b");
    expect(api.read()).toBe("session-b");
  });

  test("clear 作废后 read 为 null（新对话切走的回归防线）", () => {
    const { api } = setup();
    api.record("session-a");
    api.clear();
    expect(api.read()).toBeNull();
  });

  test("clear 无记录时是幂等空操作", () => {
    const { store, api } = setup();
    api.clear();
    expect(store.map.size).toBe(0);
  });

  test("存储槽不可用时读返回 null、写不抛", () => {
    const api = createPiLastThreadStorage(() => null);
    expect(() => api.record("session-a")).not.toThrow();
    expect(api.read()).toBeNull();
    expect(() => api.clear()).not.toThrow();
  });

  test("userNewThread 清空指针并计数；写通 clear 不计数", () => {
    const { api } = setup();
    expect(api.newThreadActionCount()).toBe(0);
    api.record("session-a");
    api.clear(); // 写通清空（如启动首帧停在草稿）：不算用户意图
    expect(api.read()).toBeNull();
    expect(api.newThreadActionCount()).toBe(0);
    api.record("session-a");
    api.userNewThread(); // 用户点"新对话"入口
    expect(api.read()).toBeNull();
    expect(api.newThreadActionCount()).toBe(1);
  });

  test("存储槽不可用时 userNewThread 不抛且仍计数", () => {
    const api = createPiLastThreadStorage(() => null);
    expect(() => api.userNewThread()).not.toThrow();
    expect(api.newThreadActionCount()).toBe(1);
  });
});
