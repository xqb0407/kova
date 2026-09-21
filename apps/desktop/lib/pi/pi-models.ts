"use client";

import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";
import {
  piRequest,
  type PiModelSummary,
  type PiProviderSummary,
} from "@/lib/pi/pi-bridge";
import { syncSelectedModelFromSidecar } from "@/lib/model/model-settings";

/**
 * pi sidecar 的模型目录（内置 + 自定义服务），供对话页模型选择器等共享。
 * 惰性加载（首次订阅时拉取），设置变更后可 refreshPiModels() 强制刷新。
 */

type State = { models: PiModelSummary[]; loaded: boolean; loading: boolean };

let state: State = { models: [], loaded: false, loading: false };
const listeners = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function load() {
  if (!isTauri() || state.loading) return;
  setState({ loading: true });
  try {
    const res = await piRequest<{
      type: "models";
      models: PiModelSummary[];
      providers: PiProviderSummary[];
    }>({ type: "list_models" });
    setState({ models: res.models, loaded: true, loading: false });
    // 顺带校准选中模型真值：sidecar 重启会丢失 currentModelKey（UI 却仍显示旧选择）
    void syncSelectedModelFromSidecar();
  } catch {
    // sidecar 不可用时保持空目录，下次刷新重试
    setState({ loading: false });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!state.loaded && !state.loading) void load();
  return () => listeners.delete(listener);
}

/** 订阅模型目录；web 预览返回空数组 */
export function usePiModels(): PiModelSummary[] {
  return useSyncExternalStore(
    subscribe,
    () => state.models,
    () => [],
  );
}

/** 打开选择器时刷新（凭据/模型过滤可能在设置里改过） */
export function refreshPiModels() {
  void load();
}
