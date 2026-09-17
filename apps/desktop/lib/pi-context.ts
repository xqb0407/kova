"use client";

import { piRequest, type PiCompacted, type PiContextInfo } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
import { setManualCompactionMarker } from "@/lib/pi-compaction-marker";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * 上下文面板的请求侧封装（事实源全在 sidecar：占用从 Agent 状态现算、
 * 命中率从 JSONL 用量行聚合，见 sidecar context.ts 的 contextInfo）。
 * threadId/sessionId 的携带方式与 pi-session-mode 一致。
 */

function threadPayload(threadId: string): { threadId: string; sessionId?: string; cwd?: string } {
  const sessionId = piSessionRegistry.get(threadId);
  // 带上当前工作目录：sidecar 侧会话若还没建（先点了面板/压缩），
  // 也能绑上用户选的目录而不是落到 homedir
  const cwd = getWorkspace() ?? undefined;
  return { threadId, ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) };
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
 * 手动压缩发起时打 start marker：即时渲染「正在压缩上下文…」（请求-响应期间
 * 的过程反馈）。anchorIndex 为打点时刻的消息数，分隔线锚定在当时的尾部消息
 * 之后（compact 走请求-响应、不产生消息流 chunk，见 lib/pi-compaction-marker）。
 * 响应回来后由 markManualCompaction 替换为完成态；失败由调用方清除。
 */
export function markManualCompactionStart(
  threadId: string,
  anchorIndex: number,
): void {
  setManualCompactionMarker({
    threadId,
    remoteId: piSessionRegistry.get(threadId),
    anchorIndex,
    data: { phase: "start" },
  });
}

/**
 * 手动压缩成功后替换 marker 为完成态。anchorIndex 沿用 start 时记录的值
 * （由调用方持有），不随压缩期间可能新增的消息漂移。重新装载历史后由
 * 检查点行重建接管。
 */
export function markManualCompaction(
  threadId: string,
  res: PiCompacted,
  anchorIndex: number,
): void {
  setManualCompactionMarker({
    threadId,
    remoteId: piSessionRegistry.get(threadId),
    anchorIndex,
    data: {
      phase: "complete",
      generation: res.generation,
      tokensBefore: res.tokensBefore,
      summarized: res.summarized,
      summary: res.summary,
    },
  });
}
