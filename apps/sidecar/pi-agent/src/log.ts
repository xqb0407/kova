/** stderr 日志（stdout 走协议流，日志一律走 stderr 避免污染）。
 *
 * 迭代3（P3）分级过滤：PI_LOG_LEVEL = delta | event | error | silent
 * （默认 event）。流式期间 message_update 级 delta 日志（每 token 一行）
 * 不再落盘，pi-agent.log 行数从 token 级降到轮级；排障时
 * `PI_LOG_LEVEL=delta` 恢复全量。
 *
 * 注：sidecar 由 Rust 宿主拉起，其 env 继承宿主进程；未设置即默认 event
 * （生产形态）。
 */
export type LogLevel = "delta" | "event" | "error" | "silent";

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, event: 2, delta: 3 };

const threshold = (() => {
  const raw = (process.env.PI_LOG_LEVEL ?? "").trim().toLowerCase();
  return raw in RANK ? RANK[raw as LogLevel] : RANK.event;
})();

/** 按级别落一行 stderr（低于阈值静默） */
export function logAt(level: Exclude<LogLevel, "silent">, ...args: unknown[]) {
  if (RANK[level] <= threshold) console.error("[pi-agent]", ...args);
}

/** 常规日志（含一次性诊断信息）：默认级别下始终可见 */
export const logErr = (...args: unknown[]) => logAt("error", ...args);
