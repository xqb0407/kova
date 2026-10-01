"use client";

import { useSyncExternalStore } from "react";

/**
 * 手动压缩的即时分隔线标记（per-thread，进程内不落盘）。
 * compact 命令走请求-响应、不产生消息流 chunk，前端把结果暂存为 marker，
 * 按 anchorIndex 渲染在压缩发生时那条消息之后并持续显示（后续新消息排在其
 * 下）；检查点行被重建进消息流后退役：历史装载（切换线程/重启）由
 * pi-thread-adapter 清除，新链路（react-pi 快照派发，不经历史装载）由渲染端
 * 接管检测清除（见 compaction-banner.tsx 的 compactionTakenOver）。
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

/** 消息流条目的结构探针：只要求 content 部件带 type/name/data（ThreadMessage 兼容） */
export type CompactionStreamProbe = {
  content: readonly { type?: string; name?: string; data?: unknown }[];
};

/**
 * 接管检测：消息流里是否已出现本次压缩的完成态分隔线（分隔线重建进流后
 * marker 就该退役，否则同一次压缩渲染出两条线）。
 * 新链路（react-pi 快照权威）下，compaction 检查点行由 thread_snapshot 重建为
 * compactionSummary 消息、投影成 data-compaction part 直接进直播消息流
 * （订阅首帧 force / agent_start 补拉 / 收尾帧 / 事件源换代都会派发快照），
 * 这些路径都不经过历史装载的清除钩子，只能由渲染端按此判定退役 marker。
 * 判定优先 generation 匹配（compact 响应与检查点行同源、值一致）；
 * generation 缺位时按位置兜底：锚点之后（index >= anchorIndex，即锚点消息的
 * 下一条起）出现的完成态分隔线只可能是本次压缩的重建（更早代的分隔线必在锚点前，
 * 而嵌在锚点消息内部的旧线不算接管）。
 */
export function compactionTakenOver(
  messages: readonly CompactionStreamProbe[],
  marker: ManualCompactionMarker,
): boolean {
  if (marker.data.phase !== "complete") return false;
  const g = marker.data.generation;
  return messages.some((m, index) =>
    m.content.some((p) => {
      if (!(p.type === "data" && p.name === "compaction")) return false;
      const d = p.data as { phase?: string; generation?: number } | undefined;
      if (!d || d.phase === "start") return false;
      if (typeof g === "number" && d.generation === g) return true;
      return index >= marker.anchorIndex;
    }),
  );
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
