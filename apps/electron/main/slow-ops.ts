/**
 * 主进程慢操作自报与卡顿归因。
 *
 * 主进程有一类**看起来像死掉**的故障：同步 fs / 同步 SQLite 把事件循环按住，
 * 期间全部 IPC 排队、界面"哪里都点不了"，而且 crash.ts 自己也写了——同步阻塞
 * 期间同进程内没有任何代码能弹窗，用户只能看到卡死（2026-10 那次 42s 界面冻结
 * 就是这一族）。发生时唯一能指望的是日志，所以这里做两件事：
 *
 * - 每条慢命令/慢查询留痕：`[slow-op] <label> <ms>ms` 直接指出是谁卡住了主循环；
 * - 给 index.ts 的 lag 心跳提供归因：卡顿日志带上"最近一条慢操作"。
 *
 * 阈值只负责**发现**，不负责拦。要治的是把同步重活改异步（见 fs-cmds /
 * library-cmds 的 readdir/stat/cp 异步化，data.ts 的 host_query 计时）。
 */
import { logWarn } from "./logging";

/** 超过即留痕（1s：人已经能感觉到界面顿住） */
const SLOW_OP_WARN_MS = 1_000;
/** lag 心跳回溯窗口：慢操作结束后这么久内的卡顿仍归因给它 */
export const SLOW_OP_ATTRIBUTION_WINDOW_MS = 5_000;

export type SlowMainOp = { label: string; ms: number; at: number };

let lastSlowOp: SlowMainOp | null = null;

export function noteMainOp(label: string, ms: number): void {
  if (ms < SLOW_OP_WARN_MS) return;
  lastSlowOp = { label, ms, at: Date.now() };
  logWarn(`[slow-op] ${label} ${ms}ms`);
}

export function lastSlowMainOp(): SlowMainOp | null {
  return lastSlowOp;
}

/** 包住一段同步代码计时（同步 SQLite 查询等）；异常照旧上抛 */
export function measureSync<T>(label: string, fn: () => T): T {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    noteMainOp(label, Date.now() - t0);
  }
}