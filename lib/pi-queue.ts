"use client";

import { useSyncExternalStore } from "react";
import { getPiChannel } from "@/lib/pi-channel";

/**
 * prompt 排队 store（sidecar prompt-queue 的前端镜像，形态同 pi-todo）：
 * - 事实源在 sidecar（全局 FIFO 串行链）；prompt 流里的 data-queue chunk
 *   经 pi-transport 拦截进来（不进消息流）
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

/** 消费 prompt 流里的 data-queue chunk（pi-transport 调用） */
export function applyQueueChunk(
  requestId: string,
  threadId: string,
  data: unknown,
): void {
  const d = data as { phase?: string; position?: number } | null;
  if (!d || (d.phase !== "queued" && d.phase !== "active")) return;
  const map = entries.get(threadId);
  const entry = map?.get(requestId);
  if (d.phase === "active") {
    // 开跑：从排队条移除（消息流里自然可见）
    if (entry) {
      map!.delete(requestId);
      notify();
    }
    return;
  }
  const position = typeof d.position === "number" ? d.position : 0;
  if (entry) {
    // 已注册（sendMessages 时）：确认进可见队列
    map!.set(requestId, { ...entry, position });
  } else {
    // 理论上不发生（transport 一定先注册）：兜底建档
    map!.set(requestId, {
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
        .filter((e) => e.position > 0)
        .sort((a, b) => a.position - b.position);
      const value = visible.length ? visible : EMPTY;
      snapshotCache.set(threadId, { version, value });
      return value;
    },
    () => EMPTY,
  );
}

const EMPTY: QueuedPrompt[] = [];

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
