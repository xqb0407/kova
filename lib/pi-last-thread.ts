"use client";

/**
 * "最近打开的会话"记录：localStorage 存当前主线程会话的 remoteId（pi sessionId）。
 *
 * 用途：启动回切的兜底——在飞登记（pi-resume-storage）只覆盖"任务还在跑"的场景；
 * 登记不存在（任务已结束/登记写入失败/webview 存储被清）时，仍应回到刷新前的那个
 * 对话，而不是停在空白新草稿（2026-09-14 用户报"刷新后消息都没渲染"的直接观感）。
 *
 * 用 localStorage 而非 sessionStorage：指针的有效期就是"应用这次运行"，但
 * sessionStorage 正是本次事故里怀疑会被整页清空的存储（重启 webview/隐私策略/
 * 配额连带），兜底不能建立在同一个可疑基座上。单窗桌面应用里跨重启回到最近会话
 * 也符合聊天客户端惯例；会话被删时 switchToThread 抛错、调用方静默跳过。
 *
 * 失败语义：写失败 console.warn 留痕——静默吞错会让续流/回切"凭空失效"无从排查
 * （同 pi-resume-storage 的教训）；读失败按无记录处理。
 */

const KEY = "pi-last-thread";

export function recordLastThread(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, sessionId);
  } catch (err) {
    console.warn("[pi-last-thread] record failed", String(err));
  }
}

export function readLastThread(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
