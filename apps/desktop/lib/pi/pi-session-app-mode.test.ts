import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 会话级工作模式镜像 store 测试（与 pi-session-thinking.test 同款桩形态）。
 * 钉住四条语义：
 * 1. 定靶 set_app_mode 带 sessionId，绝不触碰全局默认档（不带 sessionId 的形态）；
 * 2. 未发送草稿的选择只记内存（发请求会懒建空白会话——被禁止的危险链）；
 * 3. 首条消息绑定 sessionId 后 flushDraftAppModeSelection 把草稿记忆定靶落库；
 * 4. 无记忆的会话回落全局默认，且默认档变化要能被读到（新对话跟随设置 → 通用）。
 * 草稿记忆表模块私有、hydrate 不清草稿条目（语义如此），所以每个用例用各自
 * 唯一的草稿 threadId，避免用例间串味。
 */

type Req = Record<string, unknown>;

let responder: (req: Req) => unknown = () => ({ type: "app_mode", mode: "code" });
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
const prefs = new Map<string, { appMode?: string | null }>();
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

// 全局默认档 store（设置 → 通用）用**真实模块**：app-mode.test.ts 在文件顶层
// 解构它，这里 mockModule 会让那个文件拿到残缺替身（initAppMode undefined）。
// 回落值经 setAppMode 改（它走同一份 pi-bridge 桩，改完清一次 calls）。
afterAll(() => {
  restoreAllMocks();
});

const { setAppMode } = await import("@/lib/pi/app-mode");
const {
  flushDraftAppModeSelection,
  getThreadAppModeSnapshot,
  hydrateThreadAppMode,
  setThreadAppMode,
} = await import("@/lib/pi/pi-session-app-mode");

/** 改全局默认档：经真实 store（pi-bridge 桩应答同档），随后清空请求记录 */
async function setDefaultMode(mode: "work" | "code" | "design") {
  responder = () => ({ type: "app_mode", mode });
  await setAppMode(mode);
  calls = [];
}

/** 每用例重置：桩行为、请求记录、两张表、默认档；threadIds 清本用例的普通线程条目 */
async function reset(...threadIds: string[]) {
  calls = [];
  responder = () => ({ type: "app_mode", mode: "code" });
  registry.clear();
  prefs.clear();
  refreshImpl = async () => {};
  for (const tid of threadIds) hydrateThreadAppMode(tid); // 无 prefs → 清残留条目
  await setDefaultMode("code");
}

describe("setThreadAppMode：定靶语义", () => {
  test("已绑定会话：请求带 sessionId，绝不发默认形态（不漂移全局默认档）", async () => {
    await reset("thread-1");
    registry.set("thread-1", "sess-1");
    // 模拟服务端持久化：回拉的列表快照带上新档位（真 sidecar 的定靶
    // set_app_mode 会同步 await sessionPrefsSet，刷新必然读到新值）
    refreshImpl = async () => {
      prefs.set("sess-1", { appMode: "work" });
    };
    await setThreadAppMode("thread-1", "work");
    const req = calls.find((c) => c.type === "set_app_mode");
    expect(req).toMatchObject({ mode: "work", sessionId: "sess-1" });
    // 没有不带 sessionId 的 set_app_mode（A 会话切档牵连全局默认 = 本次要修的病灶）
    expect(calls.filter((c) => c.type === "set_app_mode" && !c.sessionId)).toEqual([]);
    expect(getThreadAppModeSnapshot("thread-1")).toBe("work");
  });

  test("成功回拉偏好后记忆与落库真值一致", async () => {
    await reset("thread-2");
    registry.set("thread-2", "sess-2");
    refreshImpl = async () => {
      prefs.set("sess-2", { appMode: "design" });
    };
    await setThreadAppMode("thread-2", "design");
    hydrateThreadAppMode("thread-2");
    expect(getThreadAppModeSnapshot("thread-2")).toBe("design");
  });

  test("定靶被拒（会话不存在等）：回退到落库真值，不留下假记忆", async () => {
    await reset("thread-3");
    registry.set("thread-3", "sess-3");
    prefs.set("sess-3", { appMode: "work" });
    responder = () => new Error("session not found");
    await setThreadAppMode("thread-3", "design");
    expect(getThreadAppModeSnapshot("thread-3")).toBe("work");
  });

  test("未发送草稿：只记内存，不发任何 set_app_mode（避免懒建空白会话）", async () => {
    await reset();
    await setThreadAppMode("__LOCALID_draft-a", "work");
    expect(calls.some((c) => c.type === "set_app_mode")).toBe(false);
    expect(getThreadAppModeSnapshot("__LOCALID_draft-a")).toBe("work");
  });
});

describe("hydrateThreadAppMode：水合与回落", () => {
  test("草稿条目不被水合清掉（显式记忆跟随到其会话诞生）", async () => {
    await reset();
    await setThreadAppMode("__LOCALID_draft-b", "design");
    hydrateThreadAppMode("__LOCALID_draft-b");
    expect(getThreadAppModeSnapshot("__LOCALID_draft-b")).toBe("design");
    // 没选过的草稿：无条目，回落全局默认档
    expect(getThreadAppModeSnapshot("__LOCALID_draft-c")).toBe("code");
  });

  test("偏好列为空的已建会话：清掉陈旧条目，回落全局默认档", async () => {
    await reset("thread-4");
    registry.set("thread-4", "sess-4");
    await setThreadAppMode("thread-4", "work"); // 乐观条目（prefs 未灌，refresh no-op）
    prefs.set("sess-4", { appMode: null });
    hydrateThreadAppMode("thread-4");
    await setDefaultMode("design");
    expect(getThreadAppModeSnapshot("thread-4")).toBe("design"); // 无记忆 → 跟随默认
  });

  test("偏好列脏值（白名单外）视同无记忆", async () => {
    await reset("thread-5");
    registry.set("thread-5", "sess-5");
    prefs.set("sess-5", { appMode: "ultra" });
    hydrateThreadAppMode("thread-5");
    expect(getThreadAppModeSnapshot("thread-5")).toBe("code");
  });
});

describe("flushDraftAppModeSelection：首条派发前的草稿落库", () => {
  test("绑定 sessionId 且无记录：把草稿记忆定靶写入新会话", async () => {
    await reset();
    await setThreadAppMode("__LOCALID_draft-d", "work");
    registry.set("__LOCALID_draft-d", "sess-new");
    flushDraftAppModeSelection("__LOCALID_draft-d");
    const req = calls.find(
      (c) => c.type === "set_app_mode" && c.sessionId === "sess-new",
    );
    expect(req).toMatchObject({ mode: "work" });
  });

  test("会话已有档位记录：不覆盖（以落库真值为准）", async () => {
    await reset();
    await setThreadAppMode("__LOCALID_draft-e", "work");
    registry.set("__LOCALID_draft-e", "sess-old");
    prefs.set("sess-old", { appMode: "design" });
    calls = [];
    flushDraftAppModeSelection("__LOCALID_draft-e");
    expect(calls.some((c) => c.type === "set_app_mode")).toBe(false);
  });

  test("未绑定会话（还没建会话）：不发请求、条目保留", async () => {
    await reset();
    await setThreadAppMode("__LOCALID_draft-f", "work");
    calls = [];
    flushDraftAppModeSelection("__LOCALID_draft-f");
    expect(calls.length).toBe(0);
    expect(getThreadAppModeSnapshot("__LOCALID_draft-f")).toBe("work");
  });
});
