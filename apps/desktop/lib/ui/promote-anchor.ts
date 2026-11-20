"use client";

import { useSyncExternalStore } from "react";

/**
 * 「立即发送」的顶部锚点接管意图（模块级 store，跨组件共享）。
 *
 * 点击 promote 时按线程登记（带上当时最后一条消息的 id 作为基线）；消息真正
 * 起跑、新气泡上屏后由 PromoteTopAnchor 消费（给它登记一个临时 target，让框架
 * 立刻建出顶部锚点垫片并接管钉位），回复消息出现或线程回到空闲即清掉。
 *
 * 基线用「最后一条消息 id」而不是数量：promote 与派发之间可能插入压缩分隔线，
 * 数量会变；只有最后一条真的换成新气泡才该接管。
 *
 * 意图只服务一次：残留到下一次发送会把普通发送也变成即时落位。
 * 62s 看门狗兜住「promote 被拒绝 / 气泡永远没上屏」的病态路径。
 */
type PromoteAnchorIntent = { threadId: string; baselineLastId: string };

let intent: PromoteAnchorIntent | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

const clearExpiry = (): void => {
  if (expiry === null) return;
  clearTimeout(expiry);
  expiry = null;
};

/** 登记一次「立即发送」：该线程最后一条消息换成新气泡时接管顶部锚点 */
export const armPromoteAnchor = (
  threadId: string,
  baselineLastId: string,
): void => {
  intent = { threadId, baselineLastId };
  clearExpiry();
  expiry = setTimeout(() => {
    expiry = null;
    if (!intent) return;
    intent = null;
    notify();
  }, 62_000);
  notify();
};

/** 撤销意图（RPC 失败 / 回复已出现 / 线程回到空闲） */
export const clearPromoteAnchor = (): void => {
  if (!intent) return;
  clearExpiry();
  intent = null;
  notify();
};

/** 当前线程是否有待接管的 promote；有则返回点击时的最后一条消息 id */
export const usePromoteAnchorBaseline = (
  threadId: string | undefined,
): string | null =>
  useSyncExternalStore(
    subscribe,
    () => (intent && intent.threadId === threadId ? intent.baselineLastId : null),
    () => null,
  );
