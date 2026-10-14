import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 问答档 chip 的键归一（回归）：chunk 只带 sessionId，渲染侧给的是 mainThreadId
 * ——本会话新建的线程 mainThreadId 恒为 __LOCALID_ 草稿 id（只有刷新恢复的线程
 * 才两者同值）。不归一就是「chip 不出现」+「点了清不掉」：读草稿键 miss，
 * 清草稿键 miss，而条目实际躺在会话键上。
 */

// pi-thread-adapter 牵出 tauri 整条链，这里只保留本模块用到的几块（语义与真实现一致）
const registry = new Map<string, string>();
const { isLocalDraftThreadId } = await import("@/lib/pi/pi-thread-identity");
const sessionIdFor = (threadId: string) =>
  registry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId);
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionRegistry: registry,
  piSessionPrefsMap: new Map(),
  piSessionIdForThread: sessionIdFor,
  piStoreKeyForThread: (threadId: string) => sessionIdFor(threadId) ?? threadId,
}));

afterAll(() => {
  restoreAllMocks();
});

const { applyAskNeedsWorkChunk, clearAskNeedsWork, askNeedsWorkForTest } =
  await import("@/lib/pi/pi-ask-needs-work");

const DRAFT = "__LOCALID_draft-chip";
const SESSION = "sess-chip";

describe("问答档 chip 的键归一", () => {
  test("chunk 落会话键，按 mainThreadId（草稿 id）也读得到", () => {
    registry.set(DRAFT, SESSION);
    applyAskNeedsWorkChunk(SESSION, { reason: "这活儿要动手改代码" });
    expect(askNeedsWorkForTest(DRAFT)?.reason).toBe("这活儿要动手改代码");
  });

  test("点掉 chip：按草稿 id 清的就是会话键上那条（否则提示挂死清不掉）", () => {
    registry.set(DRAFT, SESSION);
    applyAskNeedsWorkChunk(SESSION, { reason: "r" });
    clearAskNeedsWork(DRAFT);
    expect(askNeedsWorkForTest(DRAFT)).toBeNull();
    expect(askNeedsWorkForTest(SESSION)).toBeNull();
  });

  test("恢复线程（行 id 即 sessionId）原样命中，不需要 registry", () => {
    applyAskNeedsWorkChunk(SESSION, { reason: "恢复态" });
    expect(askNeedsWorkForTest(SESSION)?.reason).toBe("恢复态");
    clearAskNeedsWork(SESSION);
  });
});
