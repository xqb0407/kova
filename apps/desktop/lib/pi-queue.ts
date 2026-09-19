"use client";

import { useSyncExternalStore } from "react";
import { getPiChannel } from "@/lib/pi-channel";

/**
 * prompt 排队 store（sidecar prompt-queue 的前端镜像，形态同 pi-todo）：
 * - 事实源在 sidecar（按线程隔离：每线程一条 FIFO，线程内串行、跨线程并行）；
 *   prompt 流里的 data-queue chunk 经 pi-transport 拦截进来（不进消息流）
 * - 注册发生在 transport.sendMessages（拿到 requestId → 线程消息 id 的映射），
 *   收到 data-queue(queued) 才进可见队列，active/finish/error/abort 移除
 * - 排队条 UI（components/agent-thread/prompt-queue-bar.tsx）渲染在 composer 上方，
 *   支持 修改 / 删除 / 立即发送（对应 queue_update / queue_cancel / queue_promote）
 */

export type QueuedPrompt = {
  /** transport 请求 id（sidecar 队列项的 key） */
  requestId: string;
  threadId: string;
  /** 线程内对应用户消息的 id（编辑/删除时同步消息流） */
  messageId: string;
  text: string;
  position: number;
};

/** threadId -> (requestId -> entry)；未确认（还没收到 data-queue）的不进这层 */
const entries = new Map<string, Map<string, QueuedPrompt>>();
const listeners = new Set<() => void>();
/** 快照缓存：useSyncExternalStore 要求 getSnapshot 返回引用稳定的值 */
let version = 0;
const snapshotCache = new Map<string, { version: number; value: QueuedPrompt[] }>();

function notify() {
  version += 1;
  for (const l of listeners) l();
}

function threadMap(threadId: string): Map<string, QueuedPrompt> {
  let m = entries.get(threadId);
  if (!m) {
    m = new Map();
    entries.set(threadId, m);
  }
  return m;
}

/** transport 注册：sendMessages 时调用（此时还不知道是否真的排队） */
export function registerQueuedPrompt(entry: {
  requestId: string;
  threadId: string;
  messageId: string;
  text: string;
}): void {
  threadMap(entry.threadId).set(entry.requestId, {
    ...entry,
    position: 0, // 0 = 未确认（data-queue 未到），不显示
  });
  notify();
}

/** 消费 prompt 流里的 data-queue chunk（pi-transport 调用）。
 *  phase: "steered"（并入当前轮的退化流标记）不进排队条，走到兜底 return */
export function applyQueueChunk(
  requestId: string,
  threadId: string,
  data: unknown,
): void {
  const d = data as { phase?: string; position?: number } | null;
  if (!d || (d.phase !== "queued" && d.phase !== "active")) return;
  // threadMap 兜底建档：map 可能不存在——刷新后重连重放 data-queue（entries
  // 是纯内存的）、取消最后一项后的重发竞态等场景，直接 map! 会崩
  //（"undefined is not an object (evaluating 'map.set')"）
  const map = threadMap(threadId);
  const entry = map.get(requestId);
  if (d.phase === "active") {
    // 开跑：从排队条移除（消息流里自然可见），并通知激活回调修正消息顺序
    if (entry) {
      map.delete(requestId);
      notify();
      activationListener?.({ ...entry });
    }
    return;
  }
  const position = typeof d.position === "number" ? d.position : 0;
  if (entry) {
    // 已注册（sendMessages 时）：确认进可见队列
    map.set(requestId, { ...entry, position });
  } else {
    // 未注册的 ghost（刷新重连重放等）：建档占位，messageId/text 不可知，
    // 排队条对空文本条目不渲染，收尾时随流清理
    map.set(requestId, {
      requestId,
      threadId,
      messageId: "",
      text: "",
      position,
    });
  }
  notify();
}

/** 流终结（finish/error/abort）时移除登记 */
export function unregisterQueuedPrompt(requestId: string, threadId: string): void {
  const map = entries.get(threadId);
  if (map?.delete(requestId)) notify();
}

/** 订阅当前线程的可见排队项（按 position 排序） */
export function useThreadQueue(threadId: string | undefined): QueuedPrompt[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => {
      if (!threadId) return EMPTY;
      const cached = snapshotCache.get(threadId);
      if (cached && cached.version === version) return cached.value;
      const visible = [...(entries.get(threadId)?.values() ?? [])]
        // 空文本 = 刷新重连重放的 ghost 占位（messageId/text 不可恢复），不渲染
        .filter((e) => e.position > 0 && e.text)
        .sort((a, b) => a.position - b.position);
      const value = visible.length ? visible : EMPTY;
      snapshotCache.set(threadId, { version, value });
      return value;
    },
    () => EMPTY,
  );
}

const EMPTY: QueuedPrompt[] = [];

/** 排队项激活回调：data-queue(active) 到达时通知（PromptQueueBar 注册）。
 *  用途：先发消息、后出回复的场景下，乐观追加把用户消息排在回复前面——
 *  激活时把气泡移到列表末尾，修正阅读顺序 */
type QueueActivationListener = (entry: QueuedPrompt) => void;
let activationListener: QueueActivationListener | null = null;

/** 注册/注销激活回调（组件卸载时传 null） */
export function setQueueActivationListener(cb: QueueActivationListener | null) {
  activationListener = cb;
}

let queuedIdsCache: { version: number; value: Set<string> } | null = null;
const EMPTY_IDS = new Set<string>();

/** 订阅「确认排队中」的用户消息 id 集合（消息列表渲染抑制用，ChatGPT 式：
 *  排队中的消息不进消息列表，只出现在排队条；开跑 active 后条目移出集合，
 *  消息自动出现）。position=0（未确认，含不会排队的空闲发送）不抑制 */
export function useQueuedMessageIds(): Set<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => {
      if (queuedIdsCache?.version === version) return queuedIdsCache.value;
      const ids = new Set<string>();
      for (const map of entries.values()) {
        for (const e of map.values()) {
          if (e.position > 0 && e.messageId) ids.add(e.messageId);
        }
      }
      queuedIdsCache = { version, value: ids };
      return ids;
    },
    () => EMPTY_IDS,
  );
}

/* ----------------------------- 队列管理操作 ----------------------------- */

/** 修改排队消息文本（sidecar 队列项 + 本地镜像一起改；线程内消息由 UI 层同步） */
export async function updateQueuedPrompt(requestId: string, text: string): Promise<void> {
  await getPiChannel().request({ type: "queue_update", requestId, text });
  for (const map of entries.values()) {
    const entry = map.get(requestId);
    if (entry) {
      map.set(requestId, { ...entry, text });
      notify();
      break;
    }
  }
}

/** 删除排队消息（sidecar 侧流立即 abort+finish 收尾；线程内消息由 UI 层移除） */
export async function cancelQueuedPrompt(requestId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_cancel", requestId });
  for (const [threadId, map] of entries) {
    if (map.delete(requestId)) {
      if (map.size === 0) entries.delete(threadId);
      notify();
      break;
    }
  }
}

/** 立即发送：中止当前活跃 turn，该项提到队首马上执行（其余排队项保留） */
export async function promoteQueuedPrompt(requestId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_promote", requestId });
}

/** 并入当前轮：排队项注入该线程活跃轮（不中止不排队）；排队条随该项流
 *  finish 自动移除，线程内用户消息保留（线性转录） */
export async function steerQueuedPrompt(requestId: string): Promise<void> {
  await getPiChannel().request({ type: "queue_steer", requestId });
}
