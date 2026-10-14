"use client";

import { useSyncExternalStore } from "react";
import {
  getSelectedModel,
  setSelectedModel,
  useSelectedModel,
  type SelectedModel,
} from "@/lib/model/model-settings";
import { refreshSessionPrefs, piSessionIdForThread, piSessionPrefsMap } from "@/lib/pi/pi-thread-adapter";

/**
 * 会话级模型记忆的前端镜像：
 * - 事实源在 sidecar：sessions 表的 model_provider/model_id 列（定靶 set_model
 *   只写被点名会话的行），其余会话不受别人会话的选择影响；
 * - 这里只存 threadId -> 最近已知模型的显示快照，切回线程时从列表快照水合；
 * - 无会话级记忆的线程回落**默认模型**（设置页选择，kv pi.model）——默认模型
 *   被删/不可用时 useModelGate 把显示收口成「请选择模型」占位并拦发送；
 * - 未发送草稿（还没有 sessionId）的选择只记内存：定靶 set_model 要求会话存在，
 *   首条消息派发前 initialize 绑定 sessionId 后经 flushDraftModelSelection 落库。
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

/** 当前线程的模型显示值：会话级记忆优先，无则回落默认模型 */
export function useThreadModel(threadId: string | undefined): SelectedModel | null {
  const own = useSyncExternalStore(
    subscribe,
    () => (threadId ? (threadModels.get(threadId) ?? null) : null),
    () => null,
  );
  const fallback = useSelectedModel();
  return own ?? fallback;
}

/** 切线程时水合：取该会话持久化的模型；没有记忆的已建线程清掉陈旧条目回落默认。
 *  未落库草稿不清——草稿期的显式选择是本地记忆，跟随到其会话诞生 */
export function hydrateThreadModel(threadId: string): void {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  const own =
    prefs?.modelProvider && prefs?.modelId
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
  if (!sessionId) return;
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

/** 诊断/测试用：全局默认选择的直读（未水合时为 null） */
export function getThreadModelSnapshot(threadId: string): SelectedModel | null {
  return threadModels.get(threadId) ?? getSelectedModel();
}
