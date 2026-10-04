import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 会话级模型记忆镜像 store 测试（与 pi-session-thinking.test 同款桩形态）。
 * 钉住三条语义：
 * 1. 定靶 set_model（经 setSelectedModel 带 sessionId）绝不触碰「默认模型」
 *    全局 store——漂移正是「A 对话切模型、新对话/B 对话跟着变」的病灶；
 * 2. 未发送草稿的选择只记内存（发请求会懒建空白会话——被禁止的危险链）；
 * 3. 首条消息绑定 sessionId 后 flushDraftModelSelection 把草稿记忆定靶落库。
 * 草稿记忆表模块私有、hydrate 不清草稿条目（语义如此），每个用例用各自
 * 唯一的草稿 threadId，避免用例间串味。
 */

type Req = Record<string, unknown>;

const calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    return Promise.resolve({ type: "model" });
  },
}));

// model-settings 桩：全局「默认模型」store。setSelectedModel 记录调用并可注错，
// 用来断言定靶路径既不写默认 store（globalWrites）也不带缺 sessionId 的形态。
let globalSelection: { provider: string; modelId: string } | null = null;
const globalWrites: Req[] = [];
let setModelReject = false;
mockModule("@/lib/model/model-settings", () => ({
  getSelectedModel: () => globalSelection,
  useSelectedModel: () => globalSelection,
  setSelectedModel: (model: Req, sessionId?: string) => {
    const rec = { ...model, sessionId: sessionId ?? null };
    if (sessionId) {
      calls.push({ type: "set_model", ...model, sessionId });
    } else {
      globalWrites.push(rec);
      globalSelection = { provider: String(model.provider), modelId: String(model.modelId) };
    }
    if (setModelReject) return Promise.reject(new Error("model not found"));
    return Promise.resolve();
  },
  // mock.module 进程级泄漏：桩必须覆盖真实模块被别处 import 的全部具名导出
  // （pi-models.ts 引用 syncSelectedModelFromSidecar，缺它则批量跑测时
  // 后载文件报 "Export named not found"）——本文件不断言，no-op 即可。
  syncSelectedModelFromSidecar: async () => {},
}));

// pi-thread-adapter 桩（同 pi-session-mode.test 的语义复刻）
const registry = new Map<string, string>();
const prefs = new Map<string, { modelProvider?: string | null; modelId?: string | null }>();
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

afterAll(() => {
  restoreAllMocks();
});

const {
  flushDraftModelSelection,
  getThreadModelSnapshot,
  hydrateThreadModel,
  setThreadModel,
} = await import("@/lib/pi/pi-session-model");

const M1 = { provider: "prov-a", modelId: "m-1" };
const M2 = { provider: "prov-b", modelId: "m-2" };

/** 每用例重置：桩行为、请求记录、两张表与默认模型；threadIds 清本用例普通线程条目 */
function reset(...threadIds: string[]) {
  calls.length = 0;
  globalWrites.length = 0;
  globalSelection = null;
  setModelReject = false;
  registry.clear();
  prefs.clear();
  refreshImpl = async () => {};
  for (const tid of threadIds) hydrateThreadModel(tid); // 无 prefs → 清残留条目
}

describe("setThreadModel：定靶语义", () => {
  test("已绑定会话：setSelectedModel 带 sessionId，绝不写默认 store / 发默认形态", async () => {
    reset("thread-1");
    registry.set("thread-1", "sess-1");
    globalSelection = M2; // 默认模型 = B：定靶切 A 后它必须原样
    // 模拟服务端持久化：定靶 set_model 会同步 await sessionPrefsSet，
    // 紧接的偏好回拉必然带上新值
    refreshImpl = async () => {
      prefs.set("sess-1", { modelProvider: "prov-a", modelId: "m-1" });
    };
    await setThreadModel("thread-1", M1);
    const req = calls.find((c) => c.type === "set_model");
    expect(req).toMatchObject({ provider: "prov-a", modelId: "m-1", sessionId: "sess-1" });
    expect(globalWrites).toEqual([]); // 无 sessionId 的默认变更形态一条没有
    expect(globalSelection).toEqual(M2); // 默认模型不动
    expect(getThreadModelSnapshot("thread-1")).toEqual(M1);
  });

  test("成功回拉偏好后记忆与落库真值一致", async () => {
    reset("thread-2");
    registry.set("thread-2", "sess-2");
    refreshImpl = async () => {
      prefs.set("sess-2", { modelProvider: "prov-a", modelId: "m-1" });
    };
    await setThreadModel("thread-2", M1);
    hydrateThreadModel("thread-2");
    expect(getThreadModelSnapshot("thread-2")).toEqual(M1);
  });

  test("定靶被拒（模型已删/无凭据）：回退到落库真值，不留下假记忆", async () => {
    reset("thread-3");
    registry.set("thread-3", "sess-3");
    prefs.set("sess-3", { modelProvider: "prov-b", modelId: "m-2" });
    setModelReject = true;
    await setThreadModel("thread-3", M1);
    expect(getThreadModelSnapshot("thread-3")).toEqual(M2);
  });

  test("未发送草稿：只记内存，不发任何 set_model（避免懒建空白会话）", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-a", M1);
    expect(calls.some((c) => c.type === "set_model")).toBe(false);
    expect(getThreadModelSnapshot("__LOCALID_draft-a")).toEqual(M1);
  });
});

describe("hydrateThreadModel：水合与回落", () => {
  test("草稿条目不被水合清掉（显式记忆跟随到其会话诞生）", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-b", M1);
    hydrateThreadModel("__LOCALID_draft-b");
    expect(getThreadModelSnapshot("__LOCALID_draft-b")).toEqual(M1);
    // 没选过的线程：无条目 → 回落默认模型
    globalSelection = M2;
    expect(getThreadModelSnapshot("__LOCALID_draft-c")).toEqual(M2);
  });

  test("偏好列为空的已建会话：清掉陈旧条目，回落默认模型", async () => {
    reset("thread-4");
    registry.set("thread-4", "sess-4");
    await setThreadModel("thread-4", M1); // 乐观条目（prefs 未灌，refresh no-op）
    prefs.set("sess-4", { modelProvider: null, modelId: null });
    hydrateThreadModel("thread-4");
    globalSelection = M2;
    expect(getThreadModelSnapshot("thread-4")).toEqual(M2); // 无记忆 → 跟随默认
  });
});

describe("flushDraftModelSelection：首条派发前的草稿落库", () => {
  test("绑定 sessionId 且无记录：把草稿记忆定靶写入新会话", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-d", M1);
    registry.set("__LOCALID_draft-d", "sess-new");
    flushDraftModelSelection("__LOCALID_draft-d");
    const req = calls.find((c) => c.type === "set_model" && c.sessionId === "sess-new");
    expect(req).toMatchObject({ provider: "prov-a", modelId: "m-1" });
  });

  test("会话已有模型记录：不覆盖（以落库真值为准）", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-e", M1);
    registry.set("__LOCALID_draft-e", "sess-old");
    prefs.set("sess-old", { modelProvider: "prov-b", modelId: "m-2" });
    calls.length = 0;
    flushDraftModelSelection("__LOCALID_draft-e");
    expect(calls.some((c) => c.type === "set_model")).toBe(false);
  });

  test("未绑定会话（还没建会话）：不发请求、条目保留", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-f", M1);
    calls.length = 0;
    flushDraftModelSelection("__LOCALID_draft-f");
    expect(calls.length).toBe(0);
    expect(getThreadModelSnapshot("__LOCALID_draft-f")).toEqual(M1);
  });
});
