/**
 * 排队命令：修改/取消/立即发送/并入当前轮/暂停/恢复/快照。
 * 队列引擎本体在 sessions/prompt-queue.ts，steered 退化流见 prompt-pipeline.ts。
 */
import { send } from "../stream";
import { steerIntoActiveRun, hasPromptChain } from "../prompt-pipeline";
import { running } from "../../sessions/sessions";
import {
  cancelEntry,
  getQueueStateForThread,
  isTurnBusy,
  pauseThread,
  popFrontForDispatch,
  promoteEntry,
  resumeThread,
  steerOutEntry,
  updateEntryText,
} from "../../sessions/prompt-queue";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  queue_update: async (reqId, msg) => {
    // 修改排队项文本（仅 queued 状态可改；已开跑返回错误）
    const requestId = String(msg.requestId ?? "");
    const text = String(msg.text ?? "");
    if (!updateEntryText(requestId, text)) {
      throw new Error(`no queued prompt: ${requestId}`);
    }
    send({ id: reqId, type: "queue_updated", requestId });
  },

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
    // 其他线程的活跃 turn 不受影响，各自并行）
    const requestId = String(msg.requestId ?? "");
    const entry = promoteEntry(requestId);
    if (!entry) {
      throw new Error(`no queued prompt: ${requestId}`);
    }
    send({ id: reqId, type: "queue_promoted", requestId });
  },

  queue_steer: async (reqId, msg) => {
    // 并入当前轮：排队项注入所属线程的活跃轮（agent.steer，不中止不排队）；
    // 该项自己的流走 steered 退化生命周期收尾（前端排队条随 finish 自动移除，
    // 线程内用户消息保留——线性转录）。无活跃轮/正在收尾则报错、项原位保留
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

  queue_pause: async (reqId, msg) => {
    // 暂停派发：链节在队首等待（不打断正在跑的 turn），不清队列
    const threadId = String(msg.threadId ?? "default");
    pauseThread(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    send({ id: reqId, type: "queue_paused", threadId });
  },

  queue_resume: async (reqId, msg) => {
    // 恢复派发：唤醒等待的链节；线程空闲且队列非空时弹出队首交由前端
    // 重新发送（恢复项/无流项的派发只能由持有流的前端泵驱动）
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    resumeThread(threadId, sessionId);
    let resumed:
      | { id: number; text: string; sessionId?: string }
      | null = null;
    if (!isTurnBusy(threadId) && !hasPromptChain(threadId)) {
      const item = popFrontForDispatch(threadId);
      if (item) {
        resumed = {
          id: item.id,
          text: item.text,
          sessionId:
            typeof item.msg.sessionId === "string"
              ? (item.msg.sessionId as string)
              : sessionId,
        };
      }
    }
    send({ id: reqId, type: "queue_resumed", threadId, resumed });
  },

  get_queue_state: async (reqId, msg) => {
    // 队列快照：内存优先；内存为空则从 session 回放并采纳（自动暂停）——
    // 前端线程挂载/刷新恢复时调用，补齐排队条
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const snapshot = getQueueStateForThread(threadId, sessionId);
    send({ id: reqId, type: "queue_state_snapshot", threadId, snapshot });
  },
};
