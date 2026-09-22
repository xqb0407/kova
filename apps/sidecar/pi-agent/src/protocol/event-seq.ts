/**
 * 事件水印计数器（设计文档 §3）：per-session 单调 eventSeq。
 * 本模块零依赖（protocol/stream 与 sessions/registry 都单向引它，无环）。
 *
 * 代际语义：计数器活在 sidecar 进程内；重启换代由前端显式重置
 * （Tauri pi-exit / WS authed），不跨进程持久化——页面侧 lastSeq 同样
 * 随刷新清零，两端的生命周期天然对齐。种子取转录最大 seq（resolve 时
 * 传入 jsonlSeq），仅为号段可读性，不承担续号正确性。
 */
const counters = new Map<string, number>();

/** 物化会话时用转录号播种；已存在则不动（重绑/重复 resolve 幂等） */
export function seedEventSeq(sessionId: string, seed: number): void {
  if (!counters.has(sessionId)) counters.set(sessionId, seed);
}

/** 下一个号：确认要写出帧时才调用（静默丢弃的帧不占号） */
export function nextEventSeq(sessionId: string): number {
  const next = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, next);
  return next;
}

/** 盖章包装：给自发通知帧加 eventSeq（仅对确认广播的行使用） */
export function withEventSeq<T extends Record<string, unknown>>(
  sessionId: string,
  frame: T,
): T & { eventSeq: number } {
  return { ...frame, eventSeq: nextEventSeq(sessionId) };
}

/** 会话删除时清计数（防 Map 泄漏） */
export function dropEventSeq(sessionId: string): void {
  counters.delete(sessionId);
}
