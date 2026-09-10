"use client";

import { piRequest, type PiCompacted, type PiContextInfo } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
import { setManualCompactionMarker } from "@/lib/pi-compaction-marker";

/**
 * 上下文面板的请求侧封装（事实源全在 sidecar：占用从 Agent 状态现算、
 * 命中率从 JSONL 用量行聚合，见 sidecar context.ts 的 contextInfo）。
 * threadId/sessionId 的携带方式与 pi-session-mode 一致。
 */

function threadPayload(threadId: string): { threadId: string; sessionId?: string } {
  const sessionId = piSessionRegistry.get(threadId);
  return { threadId, ...(sessionId ? { sessionId } : {}) };
}

/** 读取当前线程的上下文读数（popover 打开时调用） */
export function fetchContextInfo(threadId: string): Promise<PiContextInfo> {
  return piRequest<PiContextInfo>({ type: "context_info", ...threadPayload(threadId) });
}

/**
 * 手动压缩上下文：仅空闲回合边界可执行，运行中 sidecar 会拒绝
 * （"session is busy"），由调用方 toast 呈现。压缩要跑一次摘要请求，超时放宽。
 */
export function compactContext(threadId: string): Promise<PiCompacted> {
  return piRequest<PiCompacted>(
    { type: "compact", ...threadPayload(threadId) },
    120_000,
  );
}

/**
 * 手动压缩成功后打 marker：消息列表尾部即时渲染「上下文已压缩」分隔线
 * （compact 走请求-响应、不产生消息流 chunk，见 lib/pi-compaction-marker）。
 */
export function markManualCompaction(
  threadId: string,
  atCount: number,
  res: PiCompacted,
): void {
  setManualCompactionMarker({
    threadId,
    remoteId: piSessionRegistry.get(threadId),
    atCount,
    data: {
      phase: "complete",
      generation: res.generation,
      tokensBefore: res.tokensBefore,
      summarized: res.summarized,
    },
  });
}
