import { beforeEach, describe, expect, test } from "bun:test";
import {
  configureSeqGuardDebounce,
  flushSeqGuardForTest,
  observeWireLine,
  resetSeqGuard,
  setSeqGuardDeps,
  type SeqGuardDeps,
} from "@/lib/pi/pi-seq-guard";

/**
 * 水印守卫行为测试（设计文档 §3）：登记/连号/跳号回拉/陈旧号忽略/换代清零。
 * deps 全打桩，断言"缺了哪类帧就回拉哪个权威接口、防抖窗内合并"。
 */

function makeDeps() {
  const calls: string[] = [];
  const deps: SeqGuardDeps = {
    refreshQueue: (t) => calls.push(`queue:${t}`),
    fetchPlanning: (t) => calls.push(`planning:${t}`),
    refreshPending: (t) => calls.push(`pending:${t}`),
    refreshContext: (t) => calls.push(`context:${t}`),
    resyncRunning: () => calls.push("running"),
    threadForSession: (sid) => (sid === "sess-1" ? "thread-1" : undefined),
  };
  return { deps, calls };
}

const sessionState = (seq: number) => ({
  type: "session_state",
  sessionId: "sess-1",
  phase: "idle",
  eventSeq: seq,
});
const queueState = (seq: number) => ({
  id: "pi-r1",
  chunk: { type: "data-queue-state", data: { threadId: "thread-1" } },
  sessionId: "sess-1",
  eventSeq: seq,
});
const planning = (seq: number) => ({
  id: "pi-r1",
  chunk: { type: "data-planningState", data: {} },
  sessionId: "sess-1",
  eventSeq: seq,
});
const toolApproval = (seq: number) => ({
  id: "pi-r1",
  chunk: { type: "data-toolApproval", data: { approvalId: "ap-1" } },
  sessionId: "sess-1",
  eventSeq: seq,
});
const contextChanged = (seq: number) => ({
  type: "context_changed",
  sessionId: "sess-1",
  usedTokens: 100,
  threshold: 1000,
  contextWindow: 2000,
  cacheHitRatio: null,
  eventSeq: seq,
});

beforeEach(() => {
  configureSeqGuardDebounce(10);
  resetSeqGuard();
  setSeqGuardDeps(null);
});

describe("pi-seq-guard", () => {
  test("首次见号只登记：不触发任何回拉", () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(500)); // 水合期首个号是大数也不报警
    flushSeqGuardForTest("sess-1");
    expect(calls).toEqual([]);
  });

  test("连号静默；跳号 → 按类别防抖回拉", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(1));
    observeWireLine(queueState(2)); // 连号：无事
    observeWireLine(planning(5)); // 2 → 5 缺口：planning +（反查线程）
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["planning:thread-1"]);
  });

  test("审批发起帧跳号 → 回拉 list_pending（§3/§4）", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(1));
    observeWireLine(toolApproval(4)); // 漏了 2,3 号的状态帧
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["pending:thread-1"]);
  });

  test("context_changed 跳号 → 回拉 context_info 修镜像（§7）", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(1));
    observeWireLine(contextChanged(6)); // 漏 2..5：占用镜像停在旧值
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["context:thread-1"]);
  });

  test("防抖窗内多缺口合并各拉一次", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(1));
    observeWireLine(queueState(4)); // 缺 2,3：queue 行自带线程
    observeWireLine(sessionState(9)); // 再跳：running
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.sort()).toEqual(["queue:thread-1", "running"]);
  });

  test("陈旧号（重放/换代残留）静默忽略、不回退登记", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(10));
    observeWireLine(queueState(3)); // attach 重放的旧行
    observeWireLine(planning(11)); // 从 10 续号：无事（证明 3 没把登记拉低）
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });

  test("resetSeqGuard：换代后新代际从首次登记重新开始", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(30));
    resetSeqGuard(); // pi-exit / WS authed
    observeWireLine(sessionState(1)); // 新代际小号码：不报缺口
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });

  test("未注线 deps：观察照常登记但缺口只记不修（不抛）", async () => {
    observeWireLine(sessionState(1));
    observeWireLine(sessionState(4));
    await new Promise((r) => setTimeout(r, 30));
    // 复位注线后同一会话再跳号，验证此前登记未被破坏
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine(sessionState(9));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["running"]);
  });

  test("非水印行零成本直通：未盖章帧完全不触发", async () => {
    const { deps, calls } = makeDeps();
    setSeqGuardDeps(deps);
    observeWireLine({ type: "turn_changed", sessionId: "sess-1", active: true });
    observeWireLine({ id: "pi-r1", chunk: { type: "text-delta", delta: "x" } });
    observeWireLine(undefined);
    observeWireLine("string");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });
});
