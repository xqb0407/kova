"use client";

import { useSyncExternalStore } from "react";

/**
 * 手动压缩的即时分隔线标记（per-thread，进程内不落盘）。
 * compact 命令走请求-响应、不产生消息流 chunk，前端把结果暂存为 marker，
 * 按 anchorIndex 渲染在压缩发生时那条消息之后并持续显示（后续新消息排在其
 * 下）；重新装载历史（切换线程/重启）时由 pi-thread-adapter 清除——此时
 * 分隔线已由 get_history 从 compaction 检查点行重建进消息流，位置以历史为准。
 */

export type ManualCompactionData = {
  /** start：compact 请求进行中；complete/failed：响应回来后的终态 */
  phase: "start" | "complete" | "failed";
  generation?: number;
  tokensBefore?: number;
  summarized?: boolean;
  /** 本次压缩的摘要文本（消息流只留分隔线 marker，摘要在右侧「活动」面板汇总） */
  summary?: string;
};

export type ManualCompactionMarker = {
  threadId: string;
  /** pi session remoteId：历史装载按它反查清除 */
  remoteId: string | undefined;
  /**
   * 打点时刻线程的消息数：分隔线锚定在第 anchorIndex-1 条消息之后
   * （压缩发生在该前缀的空闲边界）。后续新消息渲染在它下面；若锚点消息
   * 被回滚删掉则兜底回到尾部。
   */
  anchorIndex: number;
  data: ManualCompactionData;
};

const markers = new Map<string, ManualCompactionMarker>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  for (const l of listeners) l();
}

export function setManualCompactionMarker(marker: ManualCompactionMarker): void {
  markers.set(marker.threadId, marker);
  notify();
}

export function clearManualCompactionMarker(threadId: string): void {
  if (markers.delete(threadId)) notify();
}

/** 往上翻历史（prepend）后平移锚点：下标基准随前面插入的旧消息同步后移，
 *  分隔线不会错位到别的消息下面 */
export function shiftManualCompactionAnchor(threadId: string, delta: number): void {
  if (delta === 0) return;
  const marker = markers.get(threadId);
  if (!marker) return;
  markers.set(threadId, { ...marker, anchorIndex: marker.anchorIndex + delta });
  notify();
}

/** 历史装载完成时调用：该会话的分隔线已在消息流里重建，撤掉尾部 marker */
export function clearManualCompactionMarkerForRemote(remoteId: string): void {
  let changed = false;
  for (const [threadId, m] of markers) {
    if (m.remoteId === remoteId) {
      markers.delete(threadId);
      changed = true;
    }
  }
  if (changed) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useManualCompactionMarker(
  threadId: string | undefined,
): ManualCompactionMarker | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return (threadId && markers.get(threadId)) || null;
}
