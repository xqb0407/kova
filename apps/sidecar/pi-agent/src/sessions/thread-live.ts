/**
 * 线程存活查询（后台任务旁路专用，避免反向依赖 sessions/registry）。
 *
 * bg-tasks 在收到宿主退出通知时要判断「这条线程还在不在」：会话已删除的
 * 线程不再补台账/发快照（事件发给已删会话是纯噪声，还会留下指向已删
 * 线程的台账行）。但「重启后宿主通知先于会话物化」是合法时序——台账允许
 * 先记账，等会话物化/水合时自然对上，所以这里只排除「确认已删」的线程。
 *
 * registry 是 sessions 的权威表；bg-tasks 不能 import sessions（registry →
 * resolve → tools 的环），所以用注入：registry.ts 在模块加载后回填判断函数。
 * 未注入时（测试/极早期）按「存活」处理，宁可多记一条也不丢存活任务的终态。
 */

type ThreadLiveCheck = (threadId: string) => boolean;

let check: ThreadLiveCheck | null = null;

/** registry.ts 装配后回填（传 null 退回「全存活」口径） */
export function setThreadLiveCheck(fn: ThreadLiveCheck | null): void {
  check = fn;
}

/** 线程是否仍然存在（未注入 = 恒 true） */
export function isThreadLive(threadId: string): boolean {
  if (!check) return true;
  try {
    return check(threadId);
  } catch {
    return true;
  }
}
