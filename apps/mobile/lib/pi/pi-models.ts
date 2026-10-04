"use client";

import { useSyncExternalStore } from "react";
import {
  piRequest,
  type PiModelSummary,
  type PiProviderSummary,
} from "@/lib/pi/pi-bridge";
import { syncSelectedModelFromSidecar } from "@/lib/model/model-settings";

/**
 * pi sidecar 的模型目录（内置 + 自定义服务），供对话页模型选择器等共享。
 * 惰性加载（首次订阅时拉取），设置变更后可 refreshPiModels() 强制刷新。
 *
 * 请求带 authedOnly：全目录是 1500+ 条 / 数百 KB 的单帧 NDJSON，桌面浏览器无感，
 * 但 iOS 的 WebSocket 收不下这么大的单帧——整帧丢失表现为「模型目录永远为空」。
 * 手机端选择器本来也只列已配凭据的厂商（与桌面端 model-picker 同一口径），
 * 按源过滤既修传输又把载荷缩到几 KB。
 */

type State = {
  models: PiModelSummary[];
  loaded: boolean;
  loading: boolean;
  failed: boolean;
};

let state: State = { models: [], loaded: false, loading: false, failed: false };
const listeners = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** 不再用 isTauri() 把这条路掐死：移动端虽然不是 Tauri 宿主，远程网关的
 *  list_models 一样通，掐掉的话对话页的模型切换永远是一颗空胶囊。
 *  拉取失败（未配对 / 网关不可达）就记 failed，不再随订阅者反复重试，
 *  显式重试的入口是 refreshPiModels()。 */
async function load() {
  if (state.loading) return;
  setState({ loading: true });
  try {
    const res = await piRequest<{
      type: "models";
      models: PiModelSummary[];
      providers: PiProviderSummary[];
    }>({ type: "list_models", authedOnly: true });
    setState({ models: res.models, loaded: true, loading: false, failed: false });
    // 顺带校准选中模型真值：sidecar 重启会丢失 currentModelKey（UI 却仍显示旧选择）
    void syncSelectedModelFromSidecar();
  } catch {
    // sidecar 不可用时保持空目录
    setState({ loading: false, failed: true });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!state.loaded && !state.loading && !state.failed) void load();
  return () => {
    listeners.delete(listener);
  };
}

/** 命令式读当前目录快照（发送路径等非 React 上下文查模型能力用）；
 *  未加载/远程模式为空数组——调用方须按「空目录不判定」处理 */
export function getPiModelsSnapshot(): PiModelSummary[] {
  return state.models;
}

/** 订阅模型目录；web 预览返回空数组 */
export function usePiModels(): PiModelSummary[] {
  return useSyncExternalStore(
    subscribe,
    () => state.models,
    () => [],
  );
}

/** 打开选择器时刷新（凭据/模型过滤可能在设置里改过），并清掉失败标记 */
export function refreshPiModels() {
  state = { ...state, failed: false };
  void load();
}
