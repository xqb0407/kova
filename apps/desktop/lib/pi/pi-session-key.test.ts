import { describe, expect, test } from "bun:test";
import { mainSessionIdOf, type MainSessionIdState } from "./pi-session-key";

/**
 * 会话键归一：checkpoint / per-session store 必须用 sidecar sessionId 读写。
 * 新建线程的 mainThreadId 是 __LOCALID_ 草稿 id，只有线程列表项 initialize
 * 落定的 remoteId 才是 sessionId——这里锁住换算与降级。
 */
const state = (
  mainThreadId: string | undefined,
  items: MainSessionIdState["threads"]["threadItems"],
): MainSessionIdState => ({
  threads: { mainThreadId, threadItems: items },
});

describe("mainSessionIdOf", () => {
  test("新建会话：草稿 mainThreadId → 初始化落定的 remoteId", () => {
    expect(
      mainSessionIdOf(
        state("__LOCALID_abc123", [
          { id: "__LOCALID_abc123", remoteId: "sess-new" },
        ]),
      ),
    ).toBe("sess-new");
  });

  test("刷新恢复的线程：mainThreadId 本身就是 sessionId", () => {
    expect(
      mainSessionIdOf(state("sess-old", [{ id: "sess-old", remoteId: "sess-old" }])),
    ).toBe("sess-old");
  });

  test("未初始化草稿/线程项缺失：undefined（无会话可查）", () => {
    expect(mainSessionIdOf(state("__LOCALID_x", []))).toBeUndefined();
    expect(
      mainSessionIdOf(
        state("__LOCALID_x", [{ id: "__LOCALID_x", remoteId: undefined }]),
      ),
    ).toBeUndefined();
    expect(mainSessionIdOf(state(undefined, []))).toBeUndefined();
  });

  test("多线程列表：按 mainThreadId 精确命中，不串别的会话", () => {
    expect(
      mainSessionIdOf(
        state("__LOCALID_draft", [
          { id: "sess-a", remoteId: "sess-a" },
          { id: "__LOCALID_draft", remoteId: "sess-draft" },
        ]),
      ),
    ).toBe("sess-draft");
  });
});
