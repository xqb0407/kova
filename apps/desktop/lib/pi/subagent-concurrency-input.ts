import {
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
} from "pi-protocol";

/**
 * 设置页输入规整：空串/非数字回退当前值（而不是把空串当 0 再 clamp 成 1），
 * 合法值取整并钳到共享范围。抽成纯函数便于单测。
 */
export function normalizeSubagentConcurrencyInput(
  text: string,
  current: number,
): number {
  const trimmed = text.trim();
  if (!trimmed) return current;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return current;
  return Math.min(
    Math.max(Math.round(parsed), SUBAGENT_MAX_CONCURRENCY_MIN),
    SUBAGENT_MAX_CONCURRENCY_MAX,
  );
}
