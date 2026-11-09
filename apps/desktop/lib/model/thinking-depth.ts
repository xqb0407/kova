import type { ThinkingLevel } from "@/lib/settings/thinking-settings";

/** 滑杆下方的三档粗粒度提示（精确档位仍由标题右侧文字显示） */
export const THINKING_DEPTH_LABELS = ["简单", "中度", "深度"] as const;

/** 精确思考档位 → 三档提示下标；off 不落档 */
export function thinkingDepthZone(level: ThinkingLevel): number | undefined {
  if (level === "off") return undefined;
  if (level === "medium") return 1;
  if (level === "high" || level === "xhigh" || level === "max") return 2;
  return 0; // minimal / low
}

/**
 * 思考深度滑杆的彗星强度：关闭档为 0，第二档起至少 0.25，随档位升高递增，
 * 最后一档为 1。滑块条数与渐变透明度都按这个值缩放。
 */
export function thinkingCometLevel(shownIndex: number, levelCount: number): number {
  if (shownIndex <= 0 || levelCount <= 1) return 0;
  return Math.max(0.25, shownIndex / Math.max(1, levelCount - 1));
}
