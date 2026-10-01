"use client";

import { useMemo, type FC, type RefObject } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ArchiveRestoreIcon } from "lucide-react";
import { fmtTokens } from "@/lib/model/model-format";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { useManualCompactionMarker } from "@/lib/pi/pi-compaction-marker";
import { CountPill, PanelSection } from "./section-shell";

/**
 * 活动面板「压缩摘要」:上下文压缩的 summary 不再渲染在消息流分隔线下方
 * （见 compaction-banner.tsx，那里只保留 marker），汇总到这里按发生顺序展示。
 * 数据源与分隔线同源、无需 sidecar 改动：
 * - 自动压缩/历史重建：assistant 消息里的 data-compaction part（完成态带 summary）；
 * - 手动压缩：pi-compaction-marker store 的尾部 marker（历史装载清除 marker、
 *   分隔线重建为 data part 后由上一路接管，两路天然不重叠）。
 */

type CompactionSummaryEntry = {
  key: string;
  generation?: number;
  tokensBefore?: number;
  summary: string;
};

export function useThreadCompactionSummaries(): CompactionSummaryEntry[] {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const messages = useAuiState((s) => s.thread.messages);
  const marker = useManualCompactionMarker(threadId ?? undefined);
  return useMemo(() => {
    const entries: CompactionSummaryEntry[] = [];
    messages.forEach((m) => {
      m.content.forEach((part, pi) => {
        if (part.type !== "data" || part.name !== "compaction") return;
        const data = part.data as {
          summary?: string;
          generation?: number;
          tokensBefore?: number;
        };
        if (!data?.summary) return;
        entries.push({
          key: `${String(m.id)}:${pi}`,
          generation: data.generation,
          tokensBefore: data.tokensBefore,
          summary: data.summary,
        });
      });
    });
    // 手动压缩即时态：compact 请求-响应不进消息流，marker 即唯一载体
    if (marker?.data.summary) {
      entries.push({
        key: `manual:${marker.threadId}:${marker.anchorIndex}`,
        generation: marker.data.generation,
        tokensBefore: marker.data.tokensBefore,
        summary: marker.data.summary,
      });
    }
    return entries;
  }, [messages, marker]);
}

const SummaryRow: FC<{ entry: CompactionSummaryEntry }> = ({ entry }) => {
  const details = [
    typeof entry.generation === "number" ? `第 ${entry.generation} 代` : null,
    typeof entry.tokensBefore === "number"
      ? `压缩前 ${fmtTokens(entry.tokensBefore)} tokens`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="px-2.5 py-1.5 my-2">
      <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[11px]">
        <ArchiveRestoreIcon className="size-3 shrink-0" />
        <span>上下文已压缩{details && `（${details}）`}</span>
      </div>
      <div className="text-foreground/80 bg-muted/30 rounded-lg px-3 py-2 text-sm wrap-break-word">
        <MarkdownText text={entry.summary} />
      </div>
    </div>
  );
};

/** 当前线程的压缩摘要汇总；无摘要时整节不渲染 */
export const CompactionSection: FC<{
  /** 外层滚动容器 ref：PanelSection 吸顶判定（IntersectionObserver root） */
  scrollRoot?: RefObject<HTMLElement | null>;
}> = ({ scrollRoot }) => {
  const entries = useThreadCompactionSummaries();
  if (entries.length === 0) return null;
  return (
    <PanelSection
      scrollRoot={scrollRoot}
      icon={<ArchiveRestoreIcon className="size-4" />}
      title="压缩摘要"
      trailing={<CountPill>{entries.length}</CountPill>}
    >
      <div className="flex flex-col gap-1.5">
        {entries.map((e) => (
          <SummaryRow key={e.key} entry={e} />
        ))}
      </div>
    </PanelSection>
  );
};
