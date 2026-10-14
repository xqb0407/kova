"use client";

import { makeAssistantDataUI, useAuiState } from "@assistant-ui/react";
import { type FC, type ReactNode, useEffect } from "react";
import {
  ArchiveRestoreIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { fmtTokens } from "@/lib/model/model-format";
import {
  clearManualCompactionMarker,
  compactionTakenOver,
  useManualCompactionMarker,
} from "@/lib/pi/pi-compaction-marker";
import { Marker, MarkerContent, MarkerIcon } from "../ui/marker";

/**
 * 上下文压缩分隔线（会话流中部）。三条呈现路径共用这里的渲染：
 * - 自动压缩（阈值/溢出）：sidecar 在同一条消息流里按同一 part id 发
 *   data-compaction 生命周期 chunk（start → complete/failed，见 sidecar
 *   protocol.ts），AI SDK 按 id 原地更新 data part，一个位置从「正在压缩
 *   上下文…」转成「上下文已压缩」。
 * - 刷新/重进会话：get_history 从 compaction 检查点行把「已压缩」分隔线重建
 *   进历史消息流（sidecar transcript.ts）。
 * - 手动压缩（context 弹层）：不走消息流，用 ManualCompactionTail 即时渲染
 *   在列表尾部并持续显示；检查点行被快照/历史重建进消息流后由分隔线接管、
 *   marker 退役（见 ManualCompactionTailAfter 的接管检测）。
 * 消息流里只保留分隔线 marker；summary 不在这里渲染——由右侧面板「活动」
 * 标签的「压缩摘要」小节汇总展示（agent-panel/compaction-section.tsx）。
 */

type CompactionData = {
  phase?: "start" | "complete" | "failed";
  generation?: number;
  tokensBefore?: number;
  summarized?: boolean;
  /** 压缩摘要文本（checkpoint 行 / compact 响应携带） */
  summary?: string;
};



export function CompactionBanner({ data }: { data: CompactionData }) {
  // 兼容缺省：无 phase 视为完成态
  const phase = data.phase ?? "complete";
  if (phase === "start") {
    return (
      <Marker variant="separator">
        <MarkerIcon>
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        </MarkerIcon>
        <MarkerContent className="shimmer">正在压缩上下文…</MarkerContent>
      </Marker>
    );
  }
  if (phase === "failed") {
    return (
      // <Divider>
      //   <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1.5">
      //     <TriangleAlertIcon className="size-3.5 shrink-0" />
      //     自动压缩未成功，按现有上下文继续
      //   </span>
      // </Divider>

      <Marker variant="separator">
        <MarkerIcon>
          <TriangleAlertIcon className="size-3.5 shrink-0" />
        </MarkerIcon>
        <MarkerContent className="shimmer">
          自动压缩未成功，按现有上下文继续
        </MarkerContent>
      </Marker>
    );
  }
  const details = [
    typeof data.generation === "number" ? `第 ${data.generation} 代` : null,
    typeof data.tokensBefore === "number"
      ? `压缩前 ${fmtTokens(data.tokensBefore)} tokens`
      : null,
    data.summarized === false
      ? "摘要失败，已保留最近对话"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Marker variant="separator">
      <MarkerIcon>
        <ArchiveRestoreIcon className="size-3.5 shrink-0" />
      </MarkerIcon>
      <MarkerContent>
        上下文已压缩{details && `（${details}）`}
      </MarkerContent>
    </Marker>
  );
}

export const CompactionDataUI = makeAssistantDataUI<CompactionData>({
  name: "compaction",
  render: CompactionBanner,
});

/**
 * 手动压缩的即时分隔线：marker 按 anchorIndex 钉在压缩发生时那条消息之后
 * （压缩发生在空闲边界，「其前全部已压缩」语义天然属于打点时刻的尾部），
 * 持续显示且位置固定——后续新消息排在它下面；锚点消息若被回滚删掉则兜底
 * 回到列表尾部。检查点行被快照/历史重建进消息流后由分隔线接管（见
 * compactionTakenOver），marker 就地退役。
 * 挂点由 ThreadPrimitive.Messages 的渲染回调提供（见 thread.tsx），
 * 与消息同处消息流内部，间距与宽度跟消息一致。
 */
export const ManualCompactionTailAfter: FC<{
  messageId: string;
  children: ReactNode;
}> = ({ messageId, children }) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const marker = useManualCompactionMarker(threadId ?? undefined);
  // 该消息是否就是分隔线的挂载点：优先锚点消息；锚点已被回滚删掉时兜底尾部
  const showHere = useAuiState((s) => {
    if (!marker) return false;
    const anchor = s.thread.messages[marker.anchorIndex - 1];
    return anchor
      ? anchor.id === messageId
      : s.thread.messages.at(-1)?.id === messageId;
  });
  // 流内分隔线已接管 → 不再渲染 marker，并从 store 退役（幂等，多实例并发清无害）
  const takenOver = useAuiState((s) =>
    marker ? compactionTakenOver(s.thread.messages, marker) : false,
  );
  useEffect(() => {
    if (takenOver && threadId) clearManualCompactionMarker(threadId);
  }, [takenOver, threadId]);
  if (!marker || !showHere || takenOver) return <>{children}</>;
  return (
    <>
      {children}
      <div className="mx-auto w-full max-w-(--thread-max-width) px-2 my-2">
        <CompactionBanner data={marker.data} />
      </div>
    </>
  );
};
