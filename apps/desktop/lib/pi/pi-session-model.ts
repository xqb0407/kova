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
 * - 事实源在 sidecar：sessions 表的 model_provider/model_id 列，由 set_model
 *   （带 sessionId 定靶时只写被点名会话的行）与会话恢复（resolveSession 取行值）
 *   维护；其余会话不受别人会话的选择影响；
 * - 这里只存 threadId -> 最近已知模型的显示快照，切回线程时从列表快照水合；
 * - 无会话级记忆的线程回落全局当前选择（「最近一次使用」，新会话同款语义）。
 */

/** threadId -> 该线程记住的模型（仅当会话偏好里确实有值时才有条目） */
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

/** 当前线程的模型显示值：会话级记忆优先，无则回落全局当前选择 */
export function useThreadModel(threadId: string | undefined): SelectedModel | null {
  const own = useSyncExternalStore(
    subscribe,
    () => (threadId ? (threadModels.get(threadId) ?? null) : null),
    () => null,
  );
  const global = useSelectedModel();
  return own ?? global;
}

/** 切线程时水合：取该会话持久化的模型；没有记忆的线程清掉陈旧条目回落全局 */
export function hydrateThreadModel(threadId: string): void {
  const sessionId = piSessionIdForThread(threadId);
  const prefs = sessionId ? piSessionPrefsMap.get(sessionId) : undefined;
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
 * 会话落真值行/偏好列，并把全局 kv 更新为「最近一次使用」），其余会话不动；
 * 更新本线程记忆，其余线程的条目先清掉，等 refreshSessionPrefs 拉回各会话
 * 真实落库值后重水合（休眠会话保持各自原模型，从未选过的跟随新全局）。
 * 线程还没有 sessionId（首轮未落库的新草稿）时退化为纯全局选择。
 */
export async function setThreadModel(threadId: string, model: SelectedModel): Promise<void> {
  threadModels.set(threadId, model);
  for (const tid of [...threadModels.keys()]) {
    if (tid !== threadId) threadModels.delete(tid);
  }
  notify();
  await setSelectedModel(model, piSessionIdForThread(threadId));
  await refreshSessionPrefs();
  for (const tid of [...new Set([...threadModels.keys(), threadId])]) {
    hydrateThreadModel(tid);
  }
  notify();
}

/** 诊断/测试用：全局当前选择的直读（未水合时为 null） */
export function getThreadModelSnapshot(threadId: string): SelectedModel | null {
  return threadModels.get(threadId) ?? getSelectedModel();
}
