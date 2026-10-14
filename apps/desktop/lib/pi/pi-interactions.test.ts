import { describe, expect, test, beforeEach, mock } from "bun:test";

/**
 * 挂起交互统一 store 测试（设计文档 §4）：三条进卡路径（直播 chunk /
 * 历史回放 pending / list_pending 快照替换）+ 结算竞态豁免。
 * pi-bridge/agent-events 打桩，piSessionRegistry 用真实单例（同模块内 Map）。
 */

const seenRequests: Record<string, unknown>[] = [];
let listPendingResolve: ((items: unknown[]) => void) | null = null;
let toolConfirmResolve: (() => void) | null = null;

// 打桩仅换 piRequest，其余运行时导出透传——mock.module 作用于整进程，
// 后载文件（automation-live 等）仍需真实模块的其余符号
const realPiBridge = await import("@/lib/pi/pi-bridge");
mock.module("@/lib/pi/pi-bridge", () => ({
  ...realPiBridge,
  piRequest: (req: Record<string, unknown>) => {
    seenRequests.push(req);
    if (req.type === "list_pending") {
      return new Promise((resolve) => {
        listPendingResolve = (items) => resolve({ type: "pending", items });
      });
    }
    if (req.type === "tool_confirm") {
      return new Promise((resolve) => {
        toolConfirmResolve = () => resolve({ type: "tool_confirmed" });
      });
    }
    return Promise.resolve({ type: "ok" });
  },
}));

// agent-events 用真实模块（纯发射器，无环境依赖）；mock 掉会拆掉
// 后载文件要用的 subscribeAgentEvents 具名导出
const agentEvents: { event: string; payload: unknown }[] = [];
const { subscribeAgentEvents } = await import("@/lib/pi/agent-events");
subscribeAgentEvents((e) => agentEvents.push({ event: e.name, payload: e.data }));

const store = await import("@/lib/pi/pi-interactions");
const { piSessionRegistry } = await import("@/lib/pi/pi-thread-adapter");
import type { PendingInteraction } from "pi-protocol";

const T = "thread-i1";
const permItem = (id: string): PendingInteraction => ({
  interactionId: id,
  kind: "permission",
  anchorToolCallId: `tc-${id}`,
  payload: { approvalId: id, toolCallId: `tc-${id}`, toolName: "bash", input: { command: "ls" } },
  createdAt: "2026-09-22T00:00:00.000Z",
});
const questionItem = (id: string): PendingInteraction => ({
  interactionId: id,
  kind: "question",
  anchorToolCallId: id,
  payload: { questionId: id, anchorToolCallId: id, questions: [{ title: "怎么办" }] },
  createdAt: "2026-09-22T00:00:00.000Z",
});

beforeEach(() => {
  store.resetInteractionsForTest();
  seenRequests.length = 0;
  agentEvents.length = 0;
  listPendingResolve = null;
  toolConfirmResolve = null;
  piSessionRegistry.clear();
});

describe("直播流进卡", () => {
  test("data-toolApproval chunk：入卡 + 0→非0 只发一次事件 + 按 id 去重", () => {
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc1", toolName: "bash", input: null });
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc1", toolName: "bash", input: null });
    expect(store.pendingApprovalsForTest(T).map((a) => a.approvalId)).toEqual(["a1"]);
    expect(agentEvents.filter((e) => e.event === "agent.approval.pending").length).toBe(1);
  });

  test("data-question chunk：坏形入参拒收", () => {
    store.applyQuestionChunk(T, { questionId: "q1" }); // questions 缺 → 弃
    store.applyQuestionChunk(T, { questions: [] });
    expect(store.pendingQuestionsForTest(T).length).toBe(0);
    store.applyQuestionChunk(T, { questionId: "q1", questions: [{ title: "t" }] });
    expect(store.pendingQuestionsForTest(T).length).toBe(1);
    store.removePendingQuestion(T, "q1");
    expect(store.pendingQuestionsForTest(T).length).toBe(0);
  });
});

describe("历史回放与权威快照", () => {
  test("applyHistoryPending：两类进卡、与直播流按 id 去重、载荷缺 questions 弃条目", () => {
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc", toolName: "bash" });
    store.applyHistoryPending(T, [
      permItem("a1"), // 与直播重复 → 不加
      permItem("a2"),
      questionItem("tc-q"),
      { ...questionItem("tc-bad"), payload: { questionId: "tc-bad", anchorToolCallId: "tc-bad" } }, // questions 缺 → 弃
    ]);
    expect(store.pendingApprovalsForTest(T).map((a) => a.approvalId)).toEqual(["a1", "a2"]);
    expect(store.pendingQuestionsForTest(T).map((q) => q.questionId)).toEqual(["tc-q"]);
  });

  test("refreshPendingInteractions：list_pending 应答整表替换（服务端没有的卡消失）", async () => {
    piSessionRegistry.set(T, "sess-1");
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc", toolName: "bash" });
    store.applyQuestionChunk(T, { questionId: "q9", questions: [{ title: "旧" }] });

    const pull = store.refreshPendingInteractions(T);
    expect(seenRequests.at(-1)).toMatchObject({ type: "list_pending", threadId: T, sessionId: "sess-1" });
    listPendingResolve?.([permItem("a2"), questionItem("q9"), permItem("a3")]);
    await pull;
    // a1 服务端已无 → 剔除；a2/a3 新进；q9 保留；进卡顺序按应答序
    expect(store.pendingApprovalsForTest(T).map((a) => a.approvalId)).toEqual(["a2", "a3"]);
    expect(store.pendingQuestionsForTest(T).map((q) => q.questionId)).toEqual(["q9"]);
  });

  test("结算在途豁免：确认未回时快照不许把刚点掉的卡拉回来", async () => {
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc", toolName: "bash" });
    const confirm = store.confirmToolApproval(T, "a1", true);
    // tool_confirm 在途时快照照旧回 a1（服务端结算行滞后）→ 豁免生效：
    // 不进新卡、也不给回途中的卡，整表替换后本线程审批为空
    const pull = store.refreshPendingInteractions(T);
    listPendingResolve?.([permItem("a1")]);
    await pull;
    expect(store.pendingApprovalsForTest(T).length).toBe(0); // 在途卡不被快照复活
    toolConfirmResolve?.();
    await confirm;
    expect(store.pendingApprovalsForTest(T).length).toBe(0); // 回包后依旧为空
  });

  test("tool_confirm 线形：原字段 + interactionId 寻址位（§4 加性）", async () => {
    piSessionRegistry.set(T, "sess-9");
    const p = store.confirmToolApproval(T, "a7", false);
    expect(seenRequests.at(-1)).toEqual({
      type: "tool_confirm",
      approvalId: "a7",
      interactionId: "a7",
      approved: false,
      threadId: T,
      sessionId: "sess-9",
    });
    toolConfirmResolve?.();
    await p;
  });
});

describe("结算广播收口（data-interactionResolved 的重放防复活）", () => {
  test("begin→resolved 重放序列收敛为空：提问与审批各自关闭，未知 id/重复帧 no-op 不误伤", () => {
    // 模拟刷新重放：发起帧先复活两卡
    store.applyQuestionChunk(T, { questionId: "q1", questions: [{ title: "t" }] });
    store.applyQuestionChunk(T, { questionId: "q2", questions: [{ title: "t2" }] });
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc", toolName: "bash" });
    // 未知 id（乱序/别的结算帧）不动任何卡
    store.removeResolvedInteraction(T, "unknown-id");
    expect(store.pendingQuestionsForTest(T).map((q) => q.questionId)).toEqual(["q1", "q2"]);
    expect(store.pendingApprovalsForTest(T).map((a) => a.approvalId)).toEqual(["a1"]);
    // 结算帧按 questionId / approvalId 命中两本台账
    store.removeResolvedInteraction(T, "q1");
    store.removeResolvedInteraction(T, "a1");
    store.removeResolvedInteraction(T, "a1"); // 重复帧幂等
    expect(store.pendingQuestionsForTest(T).map((q) => q.questionId)).toEqual(["q2"]);
    expect(store.pendingApprovalsForTest(T).length).toBe(0);
  });

  test("广播关闭不发 pending 事件（只是关卡，不是新挂起）", () => {
    store.applyQuestionChunk(T, { questionId: "q1", questions: [{ title: "t" }] });
    agentEvents.length = 0;
    store.removeResolvedInteraction(T, "q1");
    expect(store.pendingQuestionsForTest(T).length).toBe(0);
    expect(agentEvents.length).toBe(0);
  });

  test("resolved 后的权威快照不会复活该卡（scan 相减 + 本地已关，双保险）", async () => {
    piSessionRegistry.set(T, "sess-r1");
    store.applyQuestionChunk(T, { questionId: "q1", questions: [{ title: "t" }] });
    store.removeResolvedInteraction(T, "q1");
    const pull = store.refreshPendingInteractions(T);
    listPendingResolve?.([]); // 服务端 scan 已相减
    await pull;
    expect(store.pendingQuestionsForTest(T).length).toBe(0);
  });
});

describe("turn 结束清理", () => {
  test("clearToolApprovals / clearQuestions 按线程清空", () => {
    store.applyToolApprovalChunk(T, { approvalId: "a1", toolCallId: "tc", toolName: "bash" });
    store.applyQuestionChunk(T, { questionId: "q1", questions: [{ title: "t" }] });
    store.clearToolApprovals(T);
    store.clearQuestions("other-thread"); // 不误伤
    expect(store.pendingApprovalsForTest(T).length).toBe(0);
    expect(store.pendingQuestionsForTest(T).length).toBe(1);
    store.clearQuestions(T);
    expect(store.pendingQuestionsForTest(T).length).toBe(0);
  });
});
