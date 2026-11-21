"use client";

import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";
import {
  piRequest,
  type PiModelSummary,
  type PiProviderSummary,
} from "@/lib/pi/pi-bridge";
import { addPiChannelListener } from "@/lib/pi/pi-channel";
import { isRemoteMode } from "@/lib/remote";
import { syncSelectedModelFromSidecar } from "@/lib/model/model-settings";

/**
 * pi sidecar 的模型目录（内置 + 自定义服务），供对话页模型选择器等共享。
 * 惰性加载（首次订阅时拉取），设置变更后可 refreshPiModels() 强制刷新。
 * 走模块级通道注册表：桌面端 桌面壳 invoke，远程网页端 WS 网关（list_models
 * 不在网关拒绝名单，与桌面同一份 sidecar 目录）。web 预览（既非桌面也无配对
 * 存档）不发请求——避免 getPiChannel 兜底注册假通道污染无通道环境的消费方。
 */

type State = { models: PiModelSummary[]; loaded: boolean; loading: boolean };

let state: State = { models: [], loaded: false, loading: false };
const listeners = new Set<() => void>();

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

// 在途期间的刷新请求不丢弃：记一笔，当前拉取结束（成功或失败）后补拉一次。
// 远程首帧尤其依赖这条：订阅触发的首次拉取可能落在 桌面壳 兜底通道上（15s
// 超时在途），WS 通道注册后的补水合若被 loading 吞掉，目录就要等到用户
// 点开选择器才出来。
let pendingReload = false;

async function load() {
  // 桌面走 桌面通道；远程网页端走 WS 通道（配对存档存在才算远程模式）。
  // 两者都不是（web 预览/测试环境）就不发请求，见文件头注释。
  if (!isDesktop() && !isRemoteMode()) return;
  if (state.loading) {
    pendingReload = true;
    return;
  }
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
  if (pendingReload) {
    pendingReload = false;
    void load();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!state.loaded && !state.loading) void load();
  return () => listeners.delete(listener);
}

/** 命令式读当前目录快照（发送路径等非 React 上下文查模型能力用）；
 *  未加载（含 web 预览无通道）为空数组——调用方须按「空目录不判定」处理 */
export function getPiModelsSnapshot(): PiModelSummary[] {
  return state.models;
}

/** 该选择是否仍在选择器的候选集里（有凭据 + 未被模型过滤隐藏）。
 *  空目录 = 未加载 → 调用方先判 `models.length === 0`，不要把空目录当「不可用」。 */
export function isModelSelectable(
  models: readonly PiModelSummary[],
  model: { provider: string; modelId: string } | null | undefined,
): boolean {
  if (!model) return false;
  return models.some(
    (m) =>
      m.provider === model.provider &&
      m.id === model.modelId &&
      m.authed &&
      m.enabled !== false,
  );
}

/** 空目录：getServerSnapshot 必须返回稳定引用——每次现造一个 [] 会让 React
 *  判定快照在两次调用之间变了（"should be cached"），严重时陷进无限重渲染 */
const NO_MODELS: PiModelSummary[] = [];

/** 订阅模型目录；web 预览（无 桌面壳 也无远程通道）拉取失败恒空 */
export function usePiModels(): PiModelSummary[] {
  return useSyncExternalStore(
    subscribe,
    () => state.models,
    () => NO_MODELS,
  );
}

/** 打开选择器时刷新（凭据/模型过滤可能在设置里改过） */
export function refreshPiModels() {
  void load();
}

// 远程模式：首帧订阅/惰性拉取都发生在 WS 通道注册之前（落到 桌面壳 兜底通道
// 失败），通道换代时补水合一次（桌面端走 桌面通道既有路径，无需重拉；
// 与 pi-sessions-sync 同款思路）
addPiChannelListener((ch) => {
  if (ch?.kind === "ws") void load();
});
