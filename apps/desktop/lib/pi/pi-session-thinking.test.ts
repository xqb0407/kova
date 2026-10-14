import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 会话级思考档位镜像 store 测试（与 pi-session-mode.test 同款桩形态）。
 * 钉住三条语义：
 * 1. 定靶 set_thinking 带 sessionId，绝不触碰默认档位（不带 sessionId 的形态）；
 * 2. 未发送草稿的选择只记内存（发请求会懒建空白会话——被禁止的危险链）；
 * 3. 首条消息绑定 sessionId 后 flushDraftThinkingSelection 把草稿记忆定靶落库。
 * 草稿记忆表模块私有、hydrate 不清草稿条目（语义如此），所以每个用例用各自
 * 唯一的草稿 threadId，避免用例间串味。
 */

type Req = Record<string, unknown>;

let responder: (req: Req) => unknown = () => ({ type: "thinking", level: "off" });
let calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

// pi-thread-adapter 牵出 tauri 整条链；桩只保留本模块用到的三块。
// piSessionIdForThread 与真实现同语义：registry 优先；__LOCALID_ 草稿返回
// undefined；其余 id 本身就是 sessionId。refreshSessionPrefs 的「服务端持久化」
// 效果由每个用例自己灌 prefs 模拟。
const registry = new Map<string, string>();
const prefs = new Map<string, { thinkingLevel?: string | null }>();
let refreshImpl: () => Promise<void> = async () => {};
const { isLocalDraftThreadId } = await import("@/lib/pi/pi-thread-identity");
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionRegistry: registry,
  piSessionPrefsMap: prefs,
  prefsSessionIdFor: (threadId: string) =>
    registry.get(threadId) ?? (prefs.has(threadId) ? threadId : undefined),
  piSessionIdForThread: (threadId: string) =>
    registry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId),
  refreshSessionPrefs: () => refreshImpl(),
}));

// 默认档位 store：可控回落值，验证「会话记忆优先、无记录回落默认」
let defaultLevel = "off";
mockModule("@/lib/settings/thinking-settings", () => ({
  THINKING_LEVELS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  getThinkingLevel: () => defaultLevel,
  setThinkingLevel: (level: string) => {
    calls.push({ type: "set_thinking_default", level });
    defaultLevel = level;
    return Promise.resolve();
  },
  useThinkingLevel: () => defaultLevel,
}));

afterAll(() => {
  restoreAllMocks();
});

const {
  flushDraftThinkingSelection,
  getThreadThinkingSnapshot,
  hydrateThreadThinking,
  setThreadThinking,
} = await import("@/lib/pi/pi-session-thinking");

/** 每用例重置：桩行为、请求记录、两张表；threadIds 用于清本用例的普通线程条目 */
function reset(...threadIds: string[]) {
  calls = [];
  responder = () => ({ type: "thinking", level: "off" });
  registry.clear();
  prefs.clear();
  refreshImpl = async () => {};
  defaultLevel = "off";
  for (const tid of threadIds) hydrateThreadThinking(tid); // 无 prefs → 清残留条目
}

describe("setThreadThinking：定靶语义", () => {
  test("已绑定会话：请求带 sessionId，绝不发默认形态（不漂移默认档位）", async () => {
    reset("thread-1");
    registry.set("thread-1", "sess-1");
    // 模拟服务端持久化：回拉的列表快照带上新档位（真 sidecar 的定靶
    // set_thinking 会同步 await sessionPrefsSet，刷新必然读到新值）
    refreshImpl = async () => {
      prefs.set("sess-1", { thinkingLevel: "high" });
    };
    await setThreadThinking("thread-1", "high");
    const req = calls.find((c) => c.type === "set_thinking");
    expect(req).toMatchObject({ level: "high", sessionId: "sess-1" });
    // 没有不带 sessionId 的 set_thinking（默认档位被对话页选择盖掉 = 本次要修的病灶）
    expect(calls.filter((c) => c.type === "set_thinking" && !c.sessionId)).toEqual([]);
    expect(calls.some((c) => c.type === "set_thinking_default")).toBe(false);
    expect(getThreadThinkingSnapshot("thread-1")).toBe("high");
  });

  test("成功回拉偏好后记忆与落库真值一致", async () => {
    reset("thread-2");
    registry.set("thread-2", "sess-2");
    refreshImpl = async () => {
      prefs.set("sess-2", { thinkingLevel: "low" });
    };
    await setThreadThinking("thread-2", "low");
    hydrateThreadThinking("thread-2");
    expect(getThreadThinkingSnapshot("thread-2")).toBe("low");
  });

  test("定靶被拒（会话不存在等）：回退到落库真值，不留下假记忆", async () => {
    reset("thread-3");
    registry.set("thread-3", "sess-3");
    prefs.set("sess-3", { thinkingLevel: "medium" });
    responder = () => new Error("session not found");
    await setThreadThinking("thread-3", "high");
    expect(getThreadThinkingSnapshot("thread-3")).toBe("medium");
  });

  test("未发送草稿：只记内存，不发任何 set_thinking（避免懒建空白会话）", async () => {
    reset();
    await setThreadThinking("__LOCALID_draft-a", "max");
    expect(calls.some((c) => c.type === "set_thinking")).toBe(false);
    expect(getThreadThinkingSnapshot("__LOCALID_draft-a")).toBe("max");
  });
});

describe("hydrateThreadThinking：水合与回落", () => {
  test("草稿条目不被水合清掉（显式记忆跟随到其会话诞生）", async () => {
    reset();
    await setThreadThinking("__LOCALID_draft-b", "xhigh");
    hydrateThreadThinking("__LOCALID_draft-b");
    expect(getThreadThinkingSnapshot("__LOCALID_draft-b")).toBe("xhigh");
    // 没选过的草稿：无条目，回落默认档位
    expect(getThreadThinkingSnapshot("__LOCALID_draft-c")).toBe("off");
  });

  test("偏好列为空的已建会话：清掉陈旧条目，回落默认档位", async () => {
    reset("thread-4");
    registry.set("thread-4", "sess-4");
    await setThreadThinking("thread-4", "high"); // 乐观条目（prefs 未灌，refresh no-op）
    prefs.set("sess-4", { thinkingLevel: null });
    hydrateThreadThinking("thread-4");
    defaultLevel = "low";
    expect(getThreadThinkingSnapshot("thread-4")).toBe("low"); // 无记忆 → 跟随默认
  });

  test("偏好列脏值（白名单外）视同无记忆", () => {
    reset("thread-5");
    registry.set("thread-5", "sess-5");
    prefs.set("sess-5", { thinkingLevel: "ultra" });
    hydrateThreadThinking("thread-5");
    expect(getThreadThinkingSnapshot("thread-5")).toBe("off");
  });
});

describe("flushDraftThinkingSelection：首条派发前的草稿落库", () => {
  test("绑定 sessionId 且无记录：把草稿记忆定靶写入新会话", async () => {
    reset();
    await setThreadThinking("__LOCALID_draft-d", "max");
    registry.set("__LOCALID_draft-d", "sess-new");
    flushDraftThinkingSelection("__LOCALID_draft-d");
    const req = calls.find(
      (c) => c.type === "set_thinking" && c.sessionId === "sess-new",
    );
    expect(req).toMatchObject({ level: "max" });
  });

  test("会话已有档位记录：不覆盖（以落库真值为准）", async () => {
    reset();
    await setThreadThinking("__LOCALID_draft-e", "max");
    registry.set("__LOCALID_draft-e", "sess-old");
    prefs.set("sess-old", { thinkingLevel: "low" });
    calls = [];
    flushDraftThinkingSelection("__LOCALID_draft-e");
    expect(calls.some((c) => c.type === "set_thinking")).toBe(false);
  });

  test("未绑定会话（还没建会话）：不发请求、条目保留", async () => {
    reset();
    await setThreadThinking("__LOCALID_draft-f", "max");
    calls = [];
    flushDraftThinkingSelection("__LOCALID_draft-f");
    expect(calls.length).toBe(0);
    expect(getThreadThinkingSnapshot("__LOCALID_draft-f")).toBe("max");
  });
});
