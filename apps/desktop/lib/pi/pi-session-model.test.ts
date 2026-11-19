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

// model-settings 桩：全局「默认模型」store + 「最近使用」缓存镜像。
// setSelectedModel 记录调用并可注错，用来断言定靶路径既不写默认 store
// （globalWrites）也不带缺 sessionId 的形态；切换成功时同步更新 lastUsed
// （与真实实现一致：sidecar 定靶 set_model 会记录最近使用）。
let globalSelection: { provider: string; modelId: string } | null = null;
let lastUsedSelection: { provider: string; modelId: string } | null = null;
const globalWrites: Req[] = [];
const rememberCalls: Req[] = [];
let setModelReject = false;
mockModule("@/lib/model/model-settings", () => ({
  getSelectedModel: () => globalSelection,
  useSelectedModel: () => globalSelection,
  getLastUsedModel: () => lastUsedSelection,
  useLastUsedModel: () => lastUsedSelection,
  setSelectedModel: (model: Req, sessionId?: string) => {
    const rec = { ...model, sessionId: sessionId ?? null };
    if (sessionId) {
      calls.push({ type: "set_model", ...model, sessionId });
    } else {
      globalWrites.push(rec);
      globalSelection = { provider: String(model.provider), modelId: String(model.modelId) };
    }
    if (setModelReject) return Promise.reject(new Error("model not found"));
    lastUsedSelection = {
      provider: String(model.provider),
      modelId: String(model.modelId),
    };
    return Promise.resolve();
  },
  rememberLastUsedModel: (model: Req) => {
    rememberCalls.push({ ...model });
    lastUsedSelection = {
      provider: String(model.provider),
      modelId: String(model.modelId),
    };
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
  localThreadIdForSession: (sessionId: string) => {
    for (const [threadId, bound] of registry) {
      if (bound === sessionId) return threadId;
    }
    return undefined;
  },
  refreshSessionPrefs: () => refreshImpl(),
}));

afterAll(() => {
  restoreAllMocks();
});

const {
  flushDraftModelSelection,
  getThreadModelSnapshot,
  hydrateThreadModel,
  hydrateThreadModelFromSnapshot,
  resolveThreadFallback,
  setThreadModel,
} = await import("@/lib/pi/pi-session-model");

const M1 = { provider: "prov-a", modelId: "m-1" };
const M2 = { provider: "prov-b", modelId: "m-2" };

/** 每用例重置：桩行为、请求记录、两张表与默认模型；threadIds 清本用例普通线程条目 */
function reset(...threadIds: string[]) {
  calls.length = 0;
  globalWrites.length = 0;
  rememberCalls.length = 0;
  globalSelection = null;
  lastUsedSelection = null;
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

  test("未发送草稿：只记内存，不发 set_model（避免懒建空白会话），但记录最近使用", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-a", M1);
    expect(calls.some((c) => c.type === "set_model")).toBe(false);
    expect(rememberCalls).toEqual([M1]);
    expect(getThreadModelSnapshot("__LOCALID_draft-a")).toEqual(M1);
  });
});

describe("hydrateThreadModel：水合与回落", () => {
  test("草稿条目不被水合清掉（显式记忆跟随到其会话诞生）", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-b", M1);
    hydrateThreadModel("__LOCALID_draft-b");
    expect(getThreadModelSnapshot("__LOCALID_draft-b")).toEqual(M1);
    // 没选过的线程：无条目 → 回落默认模型（先清掉上一步产生的最近使用）
    lastUsedSelection = null;
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

describe("getThreadModelSnapshot：sessionId 反查草稿键", () => {
  test("新会话首条消息按 sessionId 查模型：命中草稿选择，不回落默认模型", async () => {
    reset();
    globalSelection = M2; // 默认模型 = 纯文本 B
    await setThreadModel("__LOCALID_draft-vision", M1); // 草稿期选了视觉 A
    registry.set("__LOCALID_draft-vision", "sess-vision");
    expect(getThreadModelSnapshot("__LOCALID_draft-vision")).toEqual(M1);
    // 首条消息的 controller 按 sessionId 建；发送时发图提示走这条查询
    expect(getThreadModelSnapshot("sess-vision")).toEqual(M1);
  });

  test("没有草稿绑定的 sessionId 仍回落默认模型", async () => {
    reset();
    globalSelection = M2;
    registry.set("__LOCALID_draft-other", "sess-other");
    expect(getThreadModelSnapshot("sess-unbound")).toEqual(M2);
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

describe("resolveThreadFallback：新对话 lastUsed → 默认", () => {
  type Models = Parameters<typeof resolveThreadFallback>[0];
  const models = [
    { provider: "prov-a", id: "m-1", authed: true, enabled: true },
    { provider: "prov-b", id: "m-2", authed: true, enabled: true },
  ] as unknown as Models;
  const gone = { provider: "prov-gone", modelId: "deleted" };

  test("新对话命中可用的 lastUsed", () => {
    expect(resolveThreadFallback(models, true, M1, M2)).toEqual(M1);
  });

  test("lastUsed 已失效 → 回落默认模型", () => {
    expect(resolveThreadFallback(models, true, gone, M2)).toEqual(M2);
  });

  test("lastUsed 与默认都失效 → 未选择（请选择模型）", () => {
    expect(resolveThreadFallback(models, true, gone, gone)).toBeNull();
  });

  test("已建会话不吃 lastUsed，只认默认模型", () => {
    expect(resolveThreadFallback(models, false, M1, M2)).toEqual(M2);
  });

  test("已建会话默认模型失效 → 未选择", () => {
    expect(resolveThreadFallback(models, false, M1, gone)).toBeNull();
  });

  test("目录未加载时不否决任何回退值", () => {
    expect(resolveThreadFallback([], true, M1, null)).toEqual(M1);
    expect(resolveThreadFallback([], false, M1, M2)).toEqual(M2);
  });

  test("被模型过滤隐藏（enabled=false）/无凭据不算可用", () => {
    const hidden = [
      { provider: "prov-a", id: "m-1", authed: true, enabled: false },
      { provider: "prov-b", id: "m-2", authed: false, enabled: true },
    ] as unknown as Models;
    expect(resolveThreadFallback(hidden, true, M1, M2)).toBeNull();
  });
});

describe("hydrateThreadModelFromSnapshot：建会话快照补水合", () => {
  test("补空缺：绑定 sessionId 后立刻拿到会话模型，不等偏好回拉", () => {
    reset();
    hydrateThreadModelFromSnapshot("__LOCALID_draft-snap", M2);
    expect(getThreadModelSnapshot("__LOCALID_draft-snap")).toEqual(M2);
  });

  test("不覆盖草稿期显式选择", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-snap-own", M1);
    hydrateThreadModelFromSnapshot("__LOCALID_draft-snap-own", M2);
    expect(getThreadModelSnapshot("__LOCALID_draft-snap-own")).toEqual(M1);
  });

  test("空模型 / 空 provider 不落条目", () => {
    reset();
    hydrateThreadModelFromSnapshot("__LOCALID_draft-snap-empty", null);
    hydrateThreadModelFromSnapshot("__LOCALID_draft-snap-empty", {
      provider: "",
      modelId: "",
    });
    // 没有条目时仍按回退链走（此用例默认与 lastUsed 都为空 → null）
    expect(getThreadModelSnapshot("__LOCALID_draft-snap-empty")).toBeNull();
  });
});

describe("最近使用缓存：切换即记录", () => {
  test("草稿切换写入 lastUsed，并成为后续新对话首选", async () => {
    reset();
    await setThreadModel("__LOCALID_draft-last", M1);
    expect(rememberCalls).toEqual([M1]);
    expect(getThreadModelSnapshot("__LOCALID_draft-next")).toEqual(M1);
  });

  test("已建会话切换同样更新最近使用；无记录的旧会话仍回落默认", async () => {
    reset("thread-last");
    registry.set("thread-last", "sess-last");
    globalSelection = M2;
    await setThreadModel("thread-last", M1);
    expect(lastUsedSelection).toEqual(M1);
    // 新对话用最近使用
    expect(getThreadModelSnapshot("__LOCALID_draft-after")).toEqual(M1);
    // 已建会话没有自己的记录：仍回落默认，不被 lastUsed 带走
    expect(getThreadModelSnapshot("sess-old-no-prefs")).toEqual(M2);
  });
});
