/**
 * 排队命令：清空/取消/立即发送/并入当前轮/弹出队首/快照。
 * 队列引擎本体在 sessions/prompt-queue.ts，steered 退化流见 prompt-pipeline.ts。
 * v3 简化：无暂停/恢复/编辑（编辑=前端取消+回填输入框）。
 */
import type { QueueAttachment } from "pi-protocol";
import { send } from "../stream";
import { abortRun, steerIntoActiveRun, hasPromptChain } from "../prompt-pipeline";
import { inlineQueueAttachment, queueImageAttachments } from "../prompt-attachments";
import { logErr } from "../../log";
import { running } from "../../sessions/sessions";
import {
  cancelAllEntries,
  cancelEntry,
  getQueueStateForThread,
  isTurnBusy,
  popFrontForDispatch,
  promoteEntry,
  rebroadcastAllQueueStates,
  steerOutEntry,
} from "../../sessions/prompt-queue";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  queue_clear: async (reqId, msg) => {
    // 整队清空（PiClient.clearQueue 契约，4a 实装）：先取快照拿被清条目
    //（文本 + 图片附件载荷）再取消全部条目（各自流 abort+finish 收尾，
    // 空快照广播随 queue_update 事件到达前端）。
    // items 供「停止生成」把排队内容原样回填输入框（cleared 保留：旧端只认它）
    const threadId = String(msg.threadId ?? "default");
    const snapshot = getQueueStateForThread(threadId);
    const items = (snapshot?.items ?? []).map((i) => ({
      reqId: i.reqId,
      text: i.text,
      ...(i.attachments && i.attachments.length > 0 ? { attachments: i.attachments } : {}),
    }));
    cancelAllEntries(threadId);
    send({
      id: reqId,
      type: "queue_cleared",
      threadId,
      cleared: items.map((i) => i.text),
      items,
    });
  },

  queue_cancel: async (reqId, msg) => {
    // 删除单个排队项：其流立即 abort+finish 收尾（前端同步移除线程内消息）。
    // 幂等：条目可能已被泵弹出/链节派发/并发取消——「没删到」= 无事可删，
    // 照常回执成功并对账广播现存快照（前端队列条自愈），不再把前后端
    // 队列视图分歧升级成 no queued prompt 红屏
    const requestId = String(msg.requestId ?? "");
    if (!cancelEntry(requestId)) {
      rebroadcastAllQueueStates();
    }
    send({ id: reqId, type: "queue_cancelled", requestId });
  },

  queue_promote: async (reqId, msg) => {
    // 立即发送：该项提到所属线程队首，中止该线程当前活跃 turn（其余排队项保留；
    // 其他线程的活跃 turn 不受影响，各自并行）。中止后当前轮的链节收尾让位，
    // 被提到的队首项由串行链立即接棒开跑。幂等同 queue_cancel：条目不存在
    // （已被派发/取消）时无事可提前，回执成功 + 对账广播，不抛错
    const requestId = String(msg.requestId ?? "");
    const entry = promoteEntry(requestId);
    if (!entry) {
      rebroadcastAllQueueStates();
      send({ id: reqId, type: "queue_promoted", requestId });
      return;
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
    // 返回 popped:null，泵转而在跑轮探测重挂。载荷带原图片附件（快照采纳
    // 项也有，见 snapshotOf）——泵直发重发不失真。
    // 附件按前端真实帧形状 { name, mimeType, data | path } 过滤（曾按不存在的
    // type:"image" 过滤，图片被整体丢弃）；path-only 项读盘内联成 data 再交付，
    // 前端重发链路只需要可直接进 prompt 的 data 载荷
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    let popped: {
      id: number;
      reqId: string;
      text: string;
      sessionId?: string;
      attachments?: QueueAttachment[];
    } | null = null;
    if (!isTurnBusy(threadId) && !hasPromptChain(threadId)) {
      const item = popFrontForDispatch(threadId);
      if (item) {
        const attachments = queueImageAttachments(item.msg).flatMap((att) => {
          if (att.data) return [att];
          const inlined = inlineQueueAttachment(att);
          if (!inlined) {
            logErr(`queue_pop: attachment unavailable (${att.name ?? att.mimeType}), dropped`);
            return [];
          }
          return [inlined];
        });
        popped = {
          id: item.id,
          reqId: item.reqId,
          text: item.text,
          sessionId:
            typeof item.msg.sessionId === "string"
              ? (item.msg.sessionId as string)
              : sessionId,
          ...(attachments.length > 0 ? { attachments } : {}),
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
