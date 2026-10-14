"use client";

import { useSyncExternalStore } from "react";
import { piRequest, type PiAutoReviewModel, type PiAutoReviewSettings } from "@/lib/pi/pi-bridge";

/**
 * AI 审查（权限档「AI 审查」）的配置镜像：审查模型覆盖与单次审查超时。
 * 事实源在 sidecar——SQLite kv（键 pi.autoReview，判定与用法见
 * permissions/auto-review.ts）；这里只做镜像缓存：client bundle 加载即
 * get_auto_review 水合，保存走 set_auto_review（与 memory/hooks 同款链路）。
 */

/** 线上类型单源在 pi-bridge（跨端载荷契约）；本地保留 AutoReview* 惯用名 */
export type AutoReviewModel = PiAutoReviewModel;
/** 缺省 model = 跟随会话当前模型；缺省 timeoutMs = 30s（sidecar 侧钳制 [5s, 120s]） */
export type AutoReviewSettings = PiAutoReviewSettings;

export const AUTO_REVIEW_DEFAULT_TIMEOUT_MS = 30_000;
export const AUTO_REVIEW_MIN_TIMEOUT_MS = 5_000;
export const AUTO_REVIEW_MAX_TIMEOUT_MS = 120_000;

let current: AutoReviewSettings = {};
const listeners = new Set<() => void>();
let initialized = false;

/** getServerSnapshot 的返回值必须是稳定引用：每次现造一个对象，React 会判定
 *  快照在两次调用之间变了（"should be cached"），严重时陷进无限重渲染。
 *  空对象 = 没有任何覆盖项，与 current 的缺省态同义 */
const SERVER_SNAPSHOT: AutoReviewSettings = {};

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAutoReviewSettings(): AutoReviewSettings {
  return current;
}

export function useAutoReviewSettings(): AutoReviewSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => SERVER_SNAPSHOT,
  );
}

/** 从 sidecar 水合镜像（client bundle 加载即调；sidecar 不可用则保持缺省） */
export async function initAutoReviewSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "auto_review"; settings: AutoReviewSettings }>({
      type: "get_auto_review",
    });
    current = res.settings ?? {};
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持缺省，保存时仍会尝试
  }
}

/** 全量覆盖：乐观更新 + 失败回滚（与 hooks 的 push 同款） */
export async function saveAutoReviewSettings(next: AutoReviewSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    const res = await piRequest<{ type: "auto_review"; settings: AutoReviewSettings }>({
      type: "set_auto_review",
      settings: next,
    });
    // 以 sidecar 回执为准：非法字段被剔除、超时被钳制，镜像跟着回落
    current = res.settings ?? {};
    emit();
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回缺省）
void initAutoReviewSettings();
