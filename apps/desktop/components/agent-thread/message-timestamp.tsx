"use client";

import type { FC } from "react";
import { cn } from "@/lib/utils";
import {
  formatMessageTime,
  formatMessageTimeFull,
} from "@/lib/ui/message-time";

/**
 * 消息时间戳：用户发送时刻与 AI 收尾时刻共用（可见文案 / dateTime / 完整
 * 时刻 tooltip / 字号色值一处维护）。只负责渲染，显示时机由调用方决定：
 * 用户侧常显，回答侧挂在操作栏里随悬浮淡入。
 *
 * `variant` 只进 `data-variant`（诊断/截图断言按角色区分），不参与样式——
 * 两处外观一致，差异全部由调用方的布局类表达。
 *
 * 汉字文本（「昨天 / 11月5日」）必须 ≥12px——Windows 下 11px 中文会粘连，
 * 见 scripts/check-type-floor.mjs；这里固定 text-xs。
 */
export const MessageTimestamp: FC<{
  at: number;
  variant: "user" | "assistant";
  className?: string;
}> = ({ at, variant, className }) => {
  const label = formatMessageTime(at);
  if (!label) return null;
  return (
    <time
      data-slot="message-timestamp"
      data-variant={variant}
      dateTime={new Date(at).toISOString()}
      title={formatMessageTimeFull(at) ?? undefined}
      className={cn(
        // whitespace-nowrap：用户气泡只有一两个字时，绝对定位的时间行按气泡
        // 宽度收缩，"11月1日 14:01" 会被中文断行拆成三行，和下面的轮次摘要
        // 行挤成一团。时间戳宁可向左溢出（容器右侧锚定，overflow-x-clip 兜底），
        // 也不折行。
        "text-muted-foreground/60 text-xs leading-none whitespace-nowrap tabular-nums",
        className,
      )}
    >
      {label}
    </time>
  );
};
