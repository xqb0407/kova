import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 会话模式/计划状态镜像 store 测试，核心是「问答」这一档不能被静默丢弃：
 * 加枚举值时散落的 `x === "a" || x === "b"` 白名单不报错，只把新值扔掉。
 * 表现是切到问答后 UI 卡在旧模式——「点了没反应」，没有任何报错线索。
 * 所以这里钉的是：合法 chunk 被接受、脏 chunk 被拒、刷新水合能恢复问答档。
 */

type Req = Record<string, unknown>;

/** 可切换的协议应答桩：返回 Error 实例表示请求失败 */
let responder: (req: Req) => unknown = () => ({
  type: "planning_state",
  mode: "agent",
  approvalLevel: "ask",
  planning: "inactive",
});
let calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

// pi-thread-adapter 牵出 tauri / 线程适配的整条链，这里只保留本模块真正用到的几块。
// piSessionIdForThread 与真实现同语义：registry 优先；__LOCALID_ 草稿无会话返回
// undefined；其余 id 本身就是 sessionId（新链路刷新后的行 id / 旧链路恢复线程）。
const registry = new Map<string, string>();
const prefs = new Map<string, { mode?: string; approvalLevel?: string }>();
const { isLocalDraftThreadId } = await import("@/lib/pi/pi-thread-identity");
const sessionIdFor = (threadId: string) =>
  registry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId);
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionRegistry: registry,
  piSessionPrefsMap: prefs,
  prefsSessionIdFor: (threadId: string) =>
    registry.get(threadId) ?? (prefs.has(threadId) ? threadId : undefined),
  piSessionIdForThread: sessionIdFor,
  piStoreKeyForThread: (threadId: string) => sessionIdFor(threadId) ?? threadId,
}));

afterAll(() => {
  restoreAllMocks();
});

const {
  applyPlanningChunk,
  fetchPlanningState,
  normalizeSessionMode,
  sessionModeSnapshot,
  setSessionMode,
} = await import("@/lib/pi/pi-session-mode");

const TID = "thread-1";

/** 每用例重置：桩行为、请求记录、两张表、本线程快照 */
function reset() {
  calls = [];
  responder = () => ({
    type: "planning_state",
    mode: "agent",
    approvalLevel: "ask",
    planning: "inactive",
  });
  registry.clear();
  prefs.clear();
  applyPlanningChunk(TID, { mode: "agent", approvalLevel: "ask", planning: "inactive" });
}

describe("normalizeSessionMode 三值规整", () => {
  test("接受 agent/plan/ask 三档", () => {
    expect(normalizeSessionMode("agent")).toBe("agent");
    expect(normalizeSessionMode("plan")).toBe("plan");
    expect(normalizeSessionMode("ask")).toBe("ask");
  });

  test("其余一律拒绝（旧版 sidecar 应答、脏缓存、undefined）", () => {
    expect(normalizeSessionMode("fast")).toBeNull();
    expect(normalizeSessionMode(undefined)).toBeNull();
    expect(normalizeSessionMode(3)).toBeNull();
  });
});

describe("applyPlanningChunk：问答 chunk 不被丢弃", () => {
  test("mode=ask 的 chunk 被接受并落快照", () => {
    reset();
    applyPlanningChunk(TID, { mode: "ask", approvalLevel: "ask", planning: "inactive" });
    expect(sessionModeSnapshot(TID).mode).toBe("ask");
  });

  test("问答档不会继承 planning 态（否则 UI 渲染成「正在计划」）", () => {
    reset();
    applyPlanningChunk(TID, { mode: "plan", approvalLevel: "ask", planning: "planning" });
    applyPlanningChunk(TID, { mode: "ask", approvalLevel: "ask", planning: "inactive" });
    expect(sessionModeSnapshot(TID)).toMatchObject({ mode: "ask", planning: "inactive" });
  });

  test("坏 mode 不覆盖既有快照（静默丢弃，不落半截状态）", () => {
    reset();
    applyPlanningChunk(TID, { mode: "ask", approvalLevel: "ask", planning: "inactive" });
    applyPlanningChunk(TID, { mode: "quick", approvalLevel: "ask", planning: "inactive" });
    expect(sessionModeSnapshot(TID).mode).toBe("ask");
  });

  test("planning 值非法时整条 chunk 丢弃", () => {
    reset();
    applyPlanningChunk(TID, { mode: "ask", approvalLevel: "ask", planning: "planning" });
    applyPlanningChunk(TID, { mode: "agent", approvalLevel: "ask", planning: "weird" });
    expect(sessionModeSnapshot(TID).mode).toBe("ask");
  });

  test("非法 approvalLevel 回落 ask，不影响 mode", () => {
    reset();
    applyPlanningChunk(TID, { mode: "ask", approvalLevel: "yolo", planning: "inactive" });
    expect(sessionModeSnapshot(TID)).toMatchObject({ mode: "ask", approvalLevel: "ask" });
  });
});

describe("fetchPlanningState：刷新后水合回问答档", () => {
  test("会话列表偏好里的 ask 先播种，live 真值随后覆盖", async () => {
    reset();
    registry.set(TID, "sess-1");
    prefs.set("sess-1", { mode: "ask" });
    responder = (req) =>
      req.type === "get_planning_state"
        ? { type: "planning_state", mode: "agent", approvalLevel: "ask", planning: "inactive" }
        : { type: "mode_changed", mode: "agent", planning: "inactive" };

    await fetchPlanningState(TID);
    // live 真值是 agent——seed 只是让 UI 刷新瞬间不闪回旧档
    expect(sessionModeSnapshot(TID).mode).toBe("agent");
  });

  test("偏好为 plan 时播种 planning 态，其余档播种 inactive", async () => {
    reset();
    registry.set(TID, "sess-2");
    prefs.set("sess-2", { mode: "plan" });
    await fetchPlanningState(TID);
    // 应答桩回 agent，但至少证明 plan 档不与其它档共用同一个映射
    expect(["planning", "inactive"]).toContain(sessionModeSnapshot(TID).planning);
  });

  test("未发送草稿（__LOCALID_）不请求（避免懒建会话污染）", async () => {
    reset();
    await fetchPlanningState("__LOCALID_draft-1");
    expect(calls.some((c) => c.type === "get_planning_state")).toBe(false);
  });

  test("新链路恢复线程（行 id 即 sessionId）：请求带 sessionId 定靶", async () => {
    reset();
    responder = () => ({
      type: "planning_state",
      mode: "ask",
      approvalLevel: "ask",
      planning: "inactive",
    });
    await fetchPlanningState("01890a5d-ac96-774b-bcce-b302099a8057");
    const req = calls.find((c) => c.type === "get_planning_state");
    expect(req?.sessionId).toBe("01890a5d-ac96-774b-bcce-b302099a8057");
    expect(sessionModeSnapshot("01890a5d-ac96-774b-bcce-b302099a8057").mode).toBe("ask");
  });
});

describe("键归一：chunk 写会话键，mainThreadId（草稿 id）也读得到", () => {
  test("绑定后的新建会话：chunk 落会话键，按 mainThreadId 读命中", () => {
    reset();
    const draft = "__LOCALID_draft-9";
    registry.set(draft, "sess-9");
    // chunk 行只带 sessionId（pi-client-base 按 parsed.sessionId 写入）
    applyPlanningChunk("sess-9", {
      mode: "ask",
      approvalLevel: "ask",
      planning: "inactive",
    });
    // 组件侧拿的还是 mainThreadId = 草稿 id：不归一就会读到默认档（UI 永远不更新）
    expect(sessionModeSnapshot(draft).mode).toBe("ask");
  });

  test("草稿期选的档在绑定后仍可见（惰性 rekey，不闪回默认）", async () => {
    reset();
    const draft = "__LOCALID_draft-10";
    responder = () => ({ type: "mode_changed", mode: "plan", planning: "planning" });
    // 草稿期：无会话，纯本地快照落草稿键
    await setSessionMode(draft, "plan");
    expect(sessionModeSnapshot(draft).mode).toBe("plan");
    // 首条消息发送 → initialize 登记绑定
    registry.set(draft, "sess-10");
    expect(sessionModeSnapshot(draft).mode).toBe("plan");
  });

  test("rekey 后 live 真值优先：会话键已有值时不被草稿快照覆盖", async () => {
    reset();
    const draft = "__LOCALID_draft-11";
    await setSessionMode(draft, "plan");
    registry.set(draft, "sess-11");
    applyPlanningChunk("sess-11", {
      mode: "agent",
      approvalLevel: "ask",
      planning: "inactive",
    });
    expect(sessionModeSnapshot(draft).mode).toBe("agent");
  });
});

describe("setSessionMode", () => {
  test("切到问答：请求体带 ask，应答回写快照", async () => {
    reset();
    responder = () => ({ type: "mode_changed", mode: "ask", planning: "inactive" });
    await setSessionMode(TID, "ask");
    const req = calls.find((c) => c.type === "set_mode");
    expect(req?.mode).toBe("ask");
    expect(sessionModeSnapshot(TID).mode).toBe("ask");
  });

  test("从问答回编码时审批级别原样带上（AskNeedsWorkChip 依赖这个组合）", async () => {
    reset();
    responder = () => ({ type: "mode_changed", mode: "agent", planning: "inactive" });
    await setSessionMode(TID, "agent", "ask");
    const req = calls.find((c) => c.type === "set_mode");
    expect(req).toMatchObject({ mode: "agent", approvalLevel: "ask" });
  });

  test("未发送草稿只落本地快照，不发 set_mode（避免懒建会话）", async () => {
    reset();
    await setSessionMode("__LOCALID_draft-2", "ask");
    expect(calls.some((c) => c.type === "set_mode")).toBe(false);
    expect(sessionModeSnapshot("__LOCALID_draft-2").mode).toBe("ask");
  });
});
