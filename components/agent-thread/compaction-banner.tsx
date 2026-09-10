"use client";

import { makeAssistantDataUI, useAuiState } from "@assistant-ui/react";
import type { FC } from "react";
import {
  ArchiveRestoreIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { fmtTokens } from "@/lib/model-format";
import { useManualCompactionMarker } from "@/lib/pi-compaction-marker";

/**
 * 上下文压缩分隔线（会话流中部）。三条呈现路径共用这里的渲染：
 * - 自动压缩（阈值/溢出）：sidecar 在同一条消息流里按同一 part id 发
 *   data-compaction 生命周期 chunk（start → complete/failed，见 sidecar
 *   protocol.ts），AI SDK 按 id 原地更新 data part，一个位置从「正在压缩
 *   上下文…」转成「上下文已压缩」。
 * - 刷新/重进会话：get_history 从 compaction 检查点行把「已压缩」分隔线重建
 *   进历史消息流（sidecar transcript.ts）。
 * - 手动压缩（context 弹层）：不走消息流，用 ManualCompactionTail 即时渲染
 *   在列表尾部，下次装载历史后由重建的分隔线接管。
 */

type CompactionData = {
  phase?: "start" | "complete" | "failed";
  generation?: number;
  tokensBefore?: number;
  summarized?: boolean;
};

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground my-1 flex w-full items-center gap-3 px-1 text-xs select-none">
      <div className="bg-border h-px flex-1" />
      {children}
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

export function CompactionBanner({ data }: { data: CompactionData }) {
  // 兼容缺省：无 phase 视为完成态
  const phase = data.phase ?? "complete";
  if (phase === "start") {
    return (
      <Divider>
        <span className="inline-flex items-center gap-1.5">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          正在压缩上下文…
        </span>
      </Divider>
    );
  }
  if (phase === "failed") {
    return (
      <Divider>
        <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1.5">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          自动压缩未成功，按现有上下文继续
        </span>
      </Divider>
    );
  }
  const details = [
    typeof data.generation === "number" ? `第 ${data.generation} 代` : null,
    typeof data.tokensBefore === "number"
      ? `压缩前 ${fmtTokens(data.tokensBefore)} tokens`
      : null,
    data.summarized === false ? "摘要失败，已开新窗口" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Divider>
      <span className="inline-flex items-center gap-1.5">
        <ArchiveRestoreIcon className="size-3.5 shrink-0" />
        上下文已压缩{details && `（${details}）`}
      </span>
    </Divider>
  );
}

export const CompactionDataUI = makeAssistantDataUI<CompactionData>({
  name: "compaction",
  render: CompactionBanner,
});

/**
 * 手动压缩的即时分隔线：marker 打在消息列表尾部（压缩发生在空闲边界，
 * 「其前全部已压缩」语义天然属于列表末尾）；用户发出下一条消息（列表变长）
 * 即隐藏，重新装载历史后由 get_history 重建的分隔线在正确位置接管。
 */
export const ManualCompactionTail: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const count = useAuiState((s) => s.thread.messages.length);
  const marker = useManualCompactionMarker(threadId ?? undefined);
  if (!marker || marker.atCount !== count || count === 0) return null;
  return <CompactionBanner data={marker.data} />;
};
