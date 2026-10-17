"use client";

import { createContext, useContext } from "react";
import type { PiUsage } from "@/lib/pi/pi-runtime/types";

/**
 * 工具行的耗时/用量元信息。
 *
 * 数据来源：
 * - `timing`：assistant-ui ToolCallMessagePart 的标准字段，由
 *   messageProjection 从 pi-agent-core 的 durationMs 反推（历史 toolResult
 *   消息带 timestamp + durationMs，直播 end 帧带 durationMs + completedAt）。
 * - `artifact`：UI-only 附加数据，承载工具自身 usage（如图片生成 token）
 *   与 MCP structuredContent；不进模型上下文。
 *
 * 用 context 而不是给每个工具组件加 props：AGENT_TOOL_UI 里有二十多个工具行，
 * 统一在 assistant-message 分发处包一层，ToolRow 自己读，避免逐个改签名。
 */
export type ToolCallMeta = {
  durationMs?: number;
  usage?: PiUsage;
};

const ToolCallMetaContext = createContext<ToolCallMeta | null>(null);

export const ToolCallMetaProvider = ToolCallMetaContext.Provider;

export function useToolCallMeta(): ToolCallMeta | null {
  return useContext(ToolCallMetaContext);
}

export function toolCallMetaFromPart(part: {
  timing?: { startedAt: number; completedAt?: number };
  artifact?: unknown;
}): ToolCallMeta | null {
  const durationMs =
    part.timing?.completedAt !== undefined
      ? Math.max(0, part.timing.completedAt - part.timing.startedAt)
      : undefined;
  const artifact = part.artifact as { usage?: PiUsage } | undefined;
  const usage = artifact?.usage;
  return durationMs !== undefined || usage !== undefined
    ? { durationMs, usage }
    : null;
}

/** 工具耗时：>=10s 一位小数、>=1s 两位小数、否则毫秒（与 loop 视图同口径）。 */
export function formatToolDuration(ms: number): string {
  return ms >= 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(2)}s`
      : `${Math.round(ms)}ms`;
}

/** token 紧凑写法：12.3k / 1.2M。 */
export function formatToolTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

export function toolCallMetaText(meta: ToolCallMeta | null): string {
  if (!meta) return "";
  return [
    meta.durationMs !== undefined
      ? formatToolDuration(meta.durationMs)
      : null,
    meta.usage !== undefined
      ? `${formatToolTokens(meta.usage.totalTokens)} tok`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function toolCallMetaTitle(meta: ToolCallMeta | null): string | undefined {
  if (!meta) return undefined;
  if (!meta.usage) return "工具执行耗时";
  const u = meta.usage;
  return [
    `输入 ${formatToolTokens(u.input)} tok`,
    `输出 ${formatToolTokens(u.output)} tok`,
    ...(u.cacheRead > 0 ? [`缓存读 ${formatToolTokens(u.cacheRead)} tok`] : []),
    ...(u.cacheWrite > 0 ? [`缓存写 ${formatToolTokens(u.cacheWrite)} tok`] : []),
    `合计 ${formatToolTokens(u.totalTokens)} tok`,
  ].join(" · ");
}
