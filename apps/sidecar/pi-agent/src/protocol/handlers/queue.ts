/**
 * 排队命令：取消/立即发送/并入当前轮/弹出队首/快照。
 * 队列引擎本体在 sessions/prompt-queue.ts，steered 退化流见 prompt-pipeline.ts。
 * v3 简化：无暂停/恢复/编辑（编辑=前端取消+回填输入框）。
 */
import { send } from "../stream";
import { abortRun, steerIntoActiveRun, hasPromptChain } from "../prompt-pipeline";
import { running } from "../../sessions/sessions";
import {
  cancelEntry,
  getQueueStateForThread,
  isTurnBusy,
  popFrontForDispatch,
  promoteEntry,
  steerOutEntry,
} from "../../sessions/prompt-queue";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  queue_cancel: async (reqId, msg) => {
    // 删除单个排队项：其流立即 abort+finish 收尾（前端同步移除线程内消息）
    const requestId = String(msg.requestId ?? "");
    if (!cancelEntry(requestId)) {
      throw new Error(`no queued prompt: ${requestId}`);
    }
    send({ id: reqId, type: "queue_cancelled", requestId });
  },

  queue_promote: async (reqId, msg) => {
    // 立即发送：该项提到所属线程队首，中止该线程当前活跃 turn（其余排队项保留；
    // 其他线程的活跃 turn 不受影响，各自并行）。中止后当前轮的链节收尾让位，
    // 被提到的队首项由串行链立即接棒开跑
    const requestId = String(msg.requestId ?? "");
    const entry = promoteEntry(requestId);
    if (!entry) {
      throw new Error(`no queued prompt: ${requestId}`);
    }
    if (isTurnBusy(entry.threadId)) {
      const active = running.get(entry.threadId);
      if (active) abortRun(active, entry.threadId);
    }
    send({ id: reqId, type: "queue_promoted", requestId });
  },

  queue_steer: async (reqId, msg) => {
    // 并入当前轮：排队项注入所属线程的活跃轮（agent.steer，不中止不排队）；
    // 该项自己的流走 steered 退化生命周期收尾（前端在宿主轮流收尾时回填气泡）。
    // 无活跃轮/正在收尾则报错、项原位保留
    const requestId = String(msg.requestId ?? "");
    const ok = steerOutEntry(requestId, (entry) => {
      const run = running.get(entry.threadId);
      if (!run || run.stopRequested) return false;
      return steerIntoActiveRun(run, entry.reqId, entry.msg);
    });
    if (!ok) {
      throw new Error(`no active turn to steer into: ${requestId}`);
    }
    send({ id: reqId, type: "queue_steered", requestId });
  },

  queue_pop: async (reqId, msg) => {
    // 弹出队首交由前端重发（前端接力泵的「踢一脚」RPC）。守卫双保险：
    // isTurnBusy（该线程有 turn 在跑）+ hasPromptChain（链节仍在——上一轮
    // 收尾与下一轮 markTurnStart 之间的空窗里 busy 位还没置上）。任一命中
    // 返回 popped:null，泵转而在跑轮探测重挂
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    let popped: { id: number; reqId: string; text: string; sessionId?: string } | null = null;
    if (!isTurnBusy(threadId) && !hasPromptChain(threadId)) {
      const item = popFrontForDispatch(threadId);
      if (item) {
        popped = {
          id: item.id,
          reqId: item.reqId,
          text: item.text,
          sessionId:
            typeof item.msg.sessionId === "string"
              ? (item.msg.sessionId as string)
              : sessionId,
        };
      }
    }
    send({ id: reqId, type: "queue_popped", threadId, popped });
  },

  get_queue_state: async (reqId, msg) => {
    // 队列快照：内存优先；内存为空则从 session 回放并采纳（不自动暂停）——
    // 前端线程挂载/刷新恢复时调用，补齐排队条
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const snapshot = getQueueStateForThread(threadId, sessionId);
    send({ id: reqId, type: "queue_state_snapshot", threadId, snapshot });
  },
};
