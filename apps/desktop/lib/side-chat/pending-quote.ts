"use client";

/**
 * 划词辅助会话的待应用引用：主会话选区 → 副屏 composer 预填。
 *
 * 不是一次性槽位而是可订阅的小 store：同一条副屏在引用未应用前又来一段选区，
 * 在**写入时**合并（两段并一个引用块）；应用侧（副屏挂载后）订阅自己 childId
 * 的变化逐条消费。引用只在内存里活到被应用；重启后副屏恢复为空草稿即可。
 */

export type PendingSideChatQuote = {
  text: string;
  /** 父会话里的来源消息 id（Composer QuoteInfo；仅用于展示/失效判断） */
  messageId?: string;
};

const pending = new Map<string, PendingSideChatQuote>();
const listeners = new Map<string, Set<() => void>>();

function emit(childSessionId: string): void {
  const set = listeners.get(childSessionId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch (error) {
      console.error("[side-chat] pending quote listener threw", error);
    }
  }
}

/** 写入引用；同一条副屏已有未应用引用时**合并文本**（\n\n 连接，来源消息 id
 *  保留首个）——连着划多段文字攒进同一个引用块 */
export function setPendingSideChatQuote(
  childSessionId: string,
  quote: PendingSideChatQuote,
): void {
  const existing = pending.get(childSessionId);
  const merged: PendingSideChatQuote = existing
    ? {
        text: `${existing.text}\n\n${quote.text}`,
        messageId: existing.messageId ?? quote.messageId,
      }
    : { ...quote };
  pending.set(childSessionId, merged);
  emit(childSessionId);
}

/** 只读查看（应用侧复核「写入没被初始化覆盖」用） */
export function peekPendingSideChatQuote(
  childSessionId: string,
): PendingSideChatQuote | undefined {
  return pending.get(childSessionId);
}

/** 应用复核通过后清除 */
export function clearPendingSideChatQuote(childSessionId: string): void {
  if (pending.delete(childSessionId)) emit(childSessionId);
}

/** 引用写入目标：现有引用 + 待应用段落 → 目标引用（幂等）。
 *  `alreadyApplied` = composer 里已经是这段引用（重试重入 / StrictMode 双跑 /
 *  重复投递），调用方只需清 pending，不能再合并一次（否则文本翻倍）。 */
export function resolvePendingQuoteTarget(
  existing: { text: string; messageId?: string } | undefined,
  pending: PendingSideChatQuote,
): { alreadyApplied: boolean; text: string; messageId: string } {
  if (
    existing?.text &&
    (existing.text === pending.text ||
      existing.text.endsWith(`\n\n${pending.text}`))
  ) {
    return {
      alreadyApplied: true,
      text: existing.text,
      messageId: existing.messageId ?? "selection",
    };
  }
  return {
    alreadyApplied: false,
    text: existing?.text
      ? `${existing.text}\n\n${pending.text}`
      : pending.text,
    messageId: existing?.messageId ?? pending.messageId ?? "selection",
  };
}

/** 订阅某条副屏的待应用引用变化（副屏视图挂载期间） */
export function subscribePendingSideChatQuote(
  childSessionId: string,
  cb: () => void,
): () => void {
  const set = listeners.get(childSessionId) ?? new Set<() => void>();
  set.add(cb);
  listeners.set(childSessionId, set);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(childSessionId);
  };
}
