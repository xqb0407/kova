"use client";

import { Marker, MarkerContent } from "../ui/marker";
import type { AssistantState } from "@assistant-ui/react";

/**
 * 「已停止」分隔线：Stop / 立即发送（promote）中止的残缺回复，在消息尾部
 * （操作栏之下）标记一条分隔线。标记本体是消息上的 data-stopped part，
 * 两条落 part 的路径同构：
 * - 直播：sidecar 在 abort chunk 前发 data-stopped（runPromptTurn finally，
 *   见 protocol.ts）；
 * - 刷新/历史：transcript toUiMessage 对 stopReason "aborted" 的消息补同款
 *   part（get_history 重建）。
 * part 本身不就地渲染（未注册 data UI），由 AssistantMessage 检测存在后
 * 渲染在 ActionBar 之外（操作栏下方）。
 */
export function isStoppedMessageState(s: AssistantState): boolean {
  return s.message.content.some(
    (p) => p.type === "data" && p.name === "stopped",
  );
}

export const StoppedMarker = () => (
  <Marker
    variant="separator"
    className="text-muted-foreground/60 mt-1 mb-2 text-xs"
  >
    <MarkerContent>已停止</MarkerContent>
  </Marker>
);
