"use client";

import { useSyncExternalStore } from "react";
import {
  getLastUsedModel,
  getSelectedModel,
  rememberLastUsedModel,
  setSelectedModel,
  useLastUsedModel,
  useSelectedModel,
  type SelectedModel,
} from "@/lib/model/model-settings";
import {
  getPiModelsSnapshot,
  isModelSelectable,
  usePiModels,
} from "@/lib/pi/pi-models";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import { refreshSessionPrefs, piSessionIdForThread, piSessionPrefsMap } from "@/lib/pi/pi-thread-adapter";
import { isLocalDraftThreadId } from "@/lib/pi/pi-thread-identity";

/**
 * 会话级模型记忆的前端镜像：
 * - 事实源在 sidecar：sessions 表的 model_provider/model_id 列（定靶 set_model
 *   只写被点名会话的行），其余会话不受别人会话的选择影响；
 * - 这里只存 threadId -> 最近已知模型的显示快照，切回线程时从列表快照水合；
 * - 尚无会话级记忆时：新对话回落最近使用（lastUsed，可用）→ 默认模型；
 *   已建会话只回落默认模型。回退值按目录候选集校验，都不可用则显示「请选择模型」；
 * - 未发送草稿（还没有 sessionId）的选择只记内存：定靶 set_model 要求会话存在，
 *   首条消息派发前 initialize 绑定 sessionId 后经 flushDraftModelSelection 落库；
 *   草稿期每次切换还会走 set_last_used_model 更新 sidecar 的最近使用缓存。
 *   最近使用缓存与桌面端共用同一份 sidecar kv。
 */

/** threadId -> 该线程记住的模型（会话偏好列有值、或草稿期用户显式选过才有条目） */
const threadModels = new Map<string, SelectedModel>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameModel(a: SelectedModel | null | undefined, b: SelectedModel | null | undefined) {
  return (a?.provider ?? "") === (b?.provider ?? "") && (a?.modelId ?? "") === (b?.modelId ?? "");
}

/** 「新对话」判定：还没有绑定 sessionId 的草稿。绑定后即使 threadId 仍是
 *  `__LOCALID_` 形态，它也已经是一个真实会话，不能再跟 lastUsed 漂移。 */
export function isNewThread(threadId: string | undefined): boolean {
  if (!threadId) return true;
  if (!isLocalDraftThreadId(threadId)) return false;
  return !piSessionIdForThread(threadId);
}

/** 无会话级记忆时的回退：新对话 lastUsed → 默认；已建会话只认默认。
 *  目录已加载时按候选集校验，失效的回退值直接跳过去。 */
export function resolveThreadFallback(
  models: readonly PiModelSummary[],
  isNew: boolean,
  lastUsed: SelectedModel | null,
  fallback: SelectedModel | null,
): SelectedModel | null {
  const usable = (m: SelectedModel | null) =>
    m !== null && (models.length === 0 || isModelSelectable(models, m));
  if (isNew) {
    if (usable(lastUsed)) return lastUsed;
    if (usable(fallback)) return fallback;
    return null;
  }
  return usable(fallback) ? fallback : null;
}

/** 当前线程的模型显示值：会话级记忆优先，无则按新/旧线程回落 */
export function useThreadModel(threadId: string | undefined): SelectedModel | null {
  const own = useSyncExternalStore(
    subscribe,
    () => (threadId ? (threadModels.get(threadId) ?? null) : null),
    () => null,
  );
  const models = usePiModels();
  const lastUsed = useLastUsedModel();
  const fallback = useSelectedModel();
  return own ?? resolveThreadFallback(models, isNewThread(threadId), lastUsed, fallback);
}

/** 本线程有没有自己的模型记忆（不含 lastUsed/默认回退）：initialize 建会话
 *  后用它判断要不要补一次偏好回拉水合。 */
export function hasOwnThreadModel(threadId: string): boolean {
  return (threadModels.get(threadId) ?? null) !== null;
}

/** 用建会话快照里的模型补一次内存镜像（仅补空缺，不覆盖草稿显式选择）。 */
export function hydrateThreadModelFromSnapshot(
  threadId: string,
  model: SelectedModel | null,
): void {
  if (!model?.provider || !model.modelId) return;
  if (threadModels.get(threadId)) return;
  threadModels.set(threadId, model);
  notify();
}

/** 切线程时水合：取该会话持久化的模型；没有记忆的已建线程清掉陈旧条目回落默认。
 *  未落库草稿不清——草稿期的显式选择是本地记忆，跟随到其会话诞生 */
export function hydrateThreadModel(threadId: string): void {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  // 与桌面同口径：快照里没有这个会话 ≠ 会话没有模型——镜像可能还没拉过
  // （刚建的会话、列表回拉在途）。清条目会让绑定瞬间回落默认模型
  if (!prefs) return;
  const own =
    prefs.modelProvider && prefs.modelId
      ? { provider: prefs.modelProvider, modelId: prefs.modelId }
      : null;
  const current = threadModels.get(threadId) ?? null;
  if (sameModel(own, current)) return;
  if (own) threadModels.set(threadId, own);
  else threadModels.delete(threadId);
  notify();
}

/**
 * 在线程里选择模型：setSelectedModel 带本线程的 sessionId 定靶（sidecar 只对该
 * 会话落模型真值行/偏好列，不动默认模型，其余会话不受波及）；更新本线程记忆，
 * 回拉偏好确认落库后重水合。定靶被拒（模型已删/无凭据）回退到落库真值显示，
 * 由发送闸门引导重选。线程还没有 sessionId（未发送草稿）时只记内存，
 * 首条发送建会话后 flush。
 */
export async function setThreadModel(threadId: string, model: SelectedModel): Promise<void> {
  threadModels.set(threadId, model);
  notify();
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) {
    // 草稿期切换也属于「用户切了模型」：只更新最近使用缓存，不动默认模型
    await rememberLastUsedModel(model).catch(() => {});
    return;
  }
  try {
    await setSelectedModel(model, sessionId);
  } catch {
    hydrateThreadModel(threadId);
    notify();
    return;
  }
  await refreshSessionPrefs();
  hydrateThreadModel(threadId);
  notify();
}

/** 首条消息派发前（initialize 绑定 sessionId 后）把草稿期记忆的模型定靶写入新建会话 */
export function flushDraftModelSelection(threadId: string): void {
  const saved = threadModels.get(threadId);
  if (!saved) return;
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  if (prefs?.modelProvider && prefs?.modelId) return;
  void setThreadModel(threadId, saved);
}

/** 诊断/测试用：非 React 上下文直读。无会话级记忆时与新对话同口径：
 *  新草稿 lastUsed → 默认，已建会话只认默认。 */
export function getThreadModelSnapshot(threadId: string): SelectedModel | null {
  const own = threadModels.get(threadId) ?? null;
  if (own) return own;
  return resolveThreadFallback(
    getPiModelsSnapshot(),
    isNewThread(threadId),
    getLastUsedModel(),
    getSelectedModel(),
  );
}
