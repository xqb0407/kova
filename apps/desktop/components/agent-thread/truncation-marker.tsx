"use client";

import { Marker, MarkerContent } from "../ui/marker";
import type { AssistantState } from "@assistant-ui/react";

/**
 * 「连续输出截断，任务已中止」分隔线：长度截断自动续跑预算
 * （MAX_LENGTH_CONTINUES）烧到头的那一轮截断回复，在消息尾部（操作栏之下）
 * 标记一条分隔线。标记本体是消息上的 data-truncation-stopped part，三条落
 * part 的路径同构：
 * - 直播：sidecar 在续跑预算耗尽收尾时发 data-truncation-stopped chunk
 *   （stream.ts turn_end，data-stopped 同款机制）；
 * - 刷新/快照：thread_snapshot 直出的原生行带 __truncationStopped 标注
 *   （sessions.ts 按 isTruncationStoppedRow 判定），messageProjection 转成
 *   同款 data part；
 * - 旧链路历史：get_history 的 historyToUiMessages 对同规则行补同款 part。
 * part 本身不就地渲染（未注册 data UI），由 AssistantMessage 检测存在后
 * 渲染在 ActionBar 之外（操作栏下方）。
 */
export function isTruncationStoppedMessageState(s: AssistantState): boolean {
  return s.message.content.some(
    (p) => p.type === "data" && p.name === "truncation-stopped",
  );
}

export const TruncationStoppedMarker = () => (
  <Marker
    variant="separator"
    className="text-muted-foreground/60 mt-1 my-4 text-xs"
  >
    <MarkerContent>连续输出截断，任务已中止</MarkerContent>
  </Marker>
);
