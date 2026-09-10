"use client";

import { useSyncExternalStore } from "react";

/**
 * 手动压缩的即时分隔线标记（per-thread，进程内不落盘）。
 * compact 命令走请求-响应、不产生消息流 chunk，前端把结果暂存为 marker；
 * 线程消息数仍等于压缩时数量（即列表尾部没被新消息推进）就渲染在消息列表末尾。
 * 重新装载历史（切换线程/重启）时由 pi-thread-adapter 清除——此时分隔线已由
 * get_history 从 compaction 检查点行重建进消息流，位置以历史为准。
 */

export type ManualCompactionData = {
  phase: "complete";
  generation: number;
  tokensBefore: number;
  summarized: boolean;
};

export type ManualCompactionMarker = {
  threadId: string;
  /** pi session remoteId：历史装载按它反查清除 */
  remoteId: string | undefined;
  /** 打标记时的消息条数，列表一旦变长即失效（分隔线语义只属于当时的尾部） */
  atCount: number;
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
