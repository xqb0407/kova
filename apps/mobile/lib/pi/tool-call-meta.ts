import type { PiUsage } from "@/lib/pi/pi-runtime/types";

/**
 * 移动端工具行的耗时/用量元信息（与桌面 tool-call-meta.tsx 同口径）。
 * `timing` 是 assistant-ui 的标准字段；`artifact` 承载工具自身 usage /
 * MCP structuredContent（UI-only，不进模型上下文）。
 */
export type ToolCallMeta = {
  durationMs?: number;
  usage?: PiUsage;
};

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

export function toolCallStructuredContent(part: { artifact?: unknown }): unknown {
  const artifact = part.artifact as { structuredContent?: unknown } | undefined;
  return artifact?.structuredContent;
}

export function formatToolDuration(ms: number): string {
  return ms >= 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(2)}s`
      : `${Math.round(ms)}ms`;
}

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
    meta.durationMs !== undefined ? formatToolDuration(meta.durationMs) : null,
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
