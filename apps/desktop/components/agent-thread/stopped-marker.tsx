"use client";

import { makeAssistantDataUI } from "@assistant-ui/react";
import { Marker, MarkerContent } from "../ui/marker";

/**
 * 「已停止」分隔线：Stop / 立即发送（promote）中止的残缺回复，在消息尾部
 * 标记一条分隔线。两条呈现路径同构：
 * - 直播：sidecar 在 abort chunk 前发 data-stopped（runPromptTurn finally，
 *   见 protocol.ts）；
 * - 刷新/历史：transcript toUiMessage 对 stopReason "aborted" 的消息补同款
 *   part（get_history 重建）。
 */
export const StoppedDataUI = makeAssistantDataUI<Record<string, never>>({
  name: "stopped",
  render: () => (
    <Marker
      variant="separator"
      className="text-muted-foreground/60 my-2 text-xs"
    >
      <MarkerContent>已停止</MarkerContent>
    </Marker>
  ),
});
