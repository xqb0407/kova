/**
 * 上下文上限自动校准：从 provider 的 overflow 错误文案里解析真实窗口，
 * 写回模型行与内存模型对象，避免自定义模型永远停在 128K 默认值。
 *
 * 只在两种情况下生效：
 * - 模型行/目录里的 contextWindow 仍是缺省猜测值（用户没填）；
 * - 服务端报告的上限比当前值更小（当前值明显配大，再撑下去只会反复溢出）。
 * 用户明确配置且服务端没有报告更小值的，不覆盖。
 */
import { logAt, logErr } from "../log";
import {
  getModelDefaultedAttrs,
  isCustomProvider,
  setModelContextWindow,
} from "./catalog";
import { modelsSetContextWindow } from "../storage/hostdb";
import type { Running } from "../types";

const MIN_CONTEXT_TOKENS = 4_096;
const MAX_CONTEXT_TOKENS = 10_000_000;

/**
 * 从常见 overflow 文案解析上限。只认“上限”语义，避免把“你用了 150000 token”
 * 当成模型窗口。
 */
export function parseContextLimit(message: string | undefined | null): number | undefined {
  if (!message) return undefined;
  const patterns = [
    /maximum context length (?:is|of)\s*([\d,]{3,})/i,
    /maximum context length\s*\(?([\d,]{3,})\)?/i,
    /context (?:window|length)\s*(?:is|of|=|:)\s*([\d,]{3,})/i,
    /context length\s*\(([\d,]{3,})\s*tokens?\)/i,
    /prompt is too long:\s*[\d,]+\s*tokens?\s*>\s*([\d,]{3,})/i,
    /max_model_len\s*(?:is|of|=|:)?\s*([\d,]{3,})/i,
    /maximum number of tokens\s*(?:is|of|=|:)?\s*\(?([\d,]{3,})/i,
    /maximum (?:allowed input|prompt) length (?:is|of)\s*([\d,]{3,})/i,
    /configured context size is\s*([\d,]{3,})/i,
    /too large for model with\s*([\d,]{3,})\s*maximum context length/i,
    /range of input length should be \[\s*1\s*,\s*([\d,]{3,})\s*\]/i,
    /exceeded model token limit:\s*([\d,]{3,})/i,
    /exceeds the (?:maximum|model)(?: context)?(?: length| window)?(?:\s*(?:of|is|=|:))?\s*([\d,]{3,})/i,
    /exceeds the limit of\s*([\d,]{3,})/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (
      Number.isFinite(value) &&
      value >= MIN_CONTEXT_TOKENS &&
      value <= MAX_CONTEXT_TOKENS
    ) {
      return Math.floor(value);
    }
  }
  return undefined;
}

/** 是否值得写回：猜测值可改；显式值只有服务端报得更小才下调。 */
export function shouldCalibrateContextWindow(
  current: number,
  parsed: number,
  trackedDefault: boolean,
): boolean {
  if (!Number.isFinite(parsed) || parsed < MIN_CONTEXT_TOKENS) return false;
  if (parsed > MAX_CONTEXT_TOKENS) return false;
  if (current <= 0) return true;
  if (parsed === current) return false;
  return trackedDefault || parsed < current;
}

/**
 * 溢出发生时调用：解析并写回。返回解析出的新窗口（未校准则 undefined）。
 * 内存模型先更新，压缩/重试立即用新窗口；数据库失败只记日志。
 */
export async function calibrateContextWindowFromError(
  run: Running,
  message: string | undefined | null,
): Promise<number | undefined> {
  const parsed = parseContextLimit(message);
  if (parsed === undefined) return undefined;
  const model = run.agent.state.model;
  if (!model || !isCustomProvider(model.provider)) return undefined;
  const current = Math.round(model.contextWindow ?? 0);
  const tracked = getModelDefaultedAttrs(model.provider, model.id).includes(
    "contextWindow",
  );
  if (!shouldCalibrateContextWindow(current, parsed, tracked)) return undefined;
  if (!setModelContextWindow(model.provider, model.id, parsed)) return undefined;
  logAt(
    "event",
    `context-window calibrated: ${model.provider}/${model.id} ${current || "?"} -> ${parsed}`,
  );
  try {
    await modelsSetContextWindow(model.provider, model.id, parsed);
  } catch (err) {
    logErr("context-window calibration persist failed:", err);
  }
  return parsed;
}
