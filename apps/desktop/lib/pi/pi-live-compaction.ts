/**
 * 自动压缩进行中的实时 marker 载荷（纯函数，无 React/运行时依赖，便于单测）。
 *
 * 轮前阈值压缩发生在 agent.prompt 之前，用户消息的转录回显要等压缩结束；
 * 这段空窗里消息流没有任何新增内容。state.compaction 由 sidecar 的
 * compaction_start/compaction_end 线程事件驱动，流尾 marker 据此显示
 * 「正在压缩上下文…」。
 *
 * 只返回 start 态：压缩结束后 marker 消失，完成态仍由检查点行在随后的快照里
 * 重建（data-compaction part），因此同一次压缩不会出现两条线。
 * 手动压缩有自己的锚点 marker（ManualCompactionTailAfter），按 reason 排除。
 */

/** 压缩分隔线的展示载荷（CompactionBanner / data-compaction part 单源） */
export type CompactionBannerData = {
  phase?: "start" | "complete" | "failed";
  generation?: number;
  tokensBefore?: number;
  summarized?: boolean;
  /** 压缩摘要文本（checkpoint 行 / compact 响应携带） */
  summary?: string;
};

/** 实时 marker 的输入（PiThreadState["compaction"] 的结构子集） */
export type LiveCompactionState = {
  active: boolean;
  reason?: "manual" | "threshold" | "overflow";
};

export function liveCompactionBannerData(
  compaction: LiveCompactionState,
): CompactionBannerData | null {
  if (!compaction.active || compaction.reason === "manual") return null;
  return { phase: "start" };
}
