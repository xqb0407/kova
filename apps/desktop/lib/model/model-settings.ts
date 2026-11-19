"use client";

import { invoke } from "@/desktop-bridge/core";
import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";
import { piRequest } from "@/lib/pi/pi-bridge";
import { addPiChannelListener } from "@/lib/pi/pi-channel";
import { isRemoteMode } from "@/lib/remote";

/**
 * 默认模型（kv 表 pi.model）：新对话的**兜底**选择与从未在对话页定靶选过
 * 模型的会话的初始选择；仅由不带 sessionId 的 setSelectedModel（设置页/
 * 引导页）维护。
 * 对话页的模型选择走会话定靶（pi-session-model），不写这里——全局键一旦
 * 漂移，所有无记录会话的显示与运行模型会被一起盖掉。
 *
 * 最近使用（kv pi.model.lastUsed，sidecar 侧维护）：用户最后一次主动切换的
 * 模型，只用于**新对话**的首选。回退顺序：lastUsed（可用）→ 默认模型（可用）
 * → 未选择。缓存失效时 sidecar 直接把它改写成默认模型；默认也不可用则清空。
 * 已建会话仍只认自己的偏好列/转录行，不受 lastUsed 影响。
 *
 * 模型列表本身实时读 pi 的 ModelRegistry（含内置 + models.json 自定义），
 * 这里只存"默认选哪个/最近用哪个"——不写 pi 的配置文件，不影响 CLI。
 */
export type SelectedModel = { provider: string; modelId: string };

const KV_KEY = "pi.model";

let current: SelectedModel | null = null;
/** 最近使用缓存的前端镜像（事实源在 sidecar kv，经 get_model / set_* 同步） */
let lastUsed: SelectedModel | null = null;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSelectedModel(): SelectedModel | null {
  return current;
}

export function useSelectedModel(): SelectedModel | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** 最近使用模型（事实源在 sidecar kv；未同步到之前为 null） */
export function getLastUsedModel(): SelectedModel | null {
  return lastUsed;
}

export function useLastUsedModel(): SelectedModel | null {
  return useSyncExternalStore(
    subscribe,
    () => lastUsed,
    () => null,
  );
}

function sameSelected(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
): boolean {
  return (
    (a?.provider ?? "") === (b?.provider ?? "") &&
    (a?.modelId ?? "") === (b?.modelId ?? "")
  );
}

function setLastUsed(next: SelectedModel | null): void {
  if (sameSelected(lastUsed, next)) return;
  lastUsed = next;
  emit();
}

/** 以 sidecar 当前模型为准校准前端选择（启动恢复失败/选择被拒后的真值同步）。
 *  sidecar 未选择时返回空串 → 前端清空为 null（显示"选择模型"占位）。
 *  同一应答里的 lastUsed 一并同步（老 sidecar 不带这两个字段时保持现状）。 */
export async function syncSelectedModelFromSidecar(): Promise<void> {
  try {
    const res = await piRequest<{
      type: "model";
      provider: string;
      modelId: string;
      lastUsedProvider?: string;
      lastUsedModelId?: string;
    }>({ type: "get_model" });
    const next =
      res.provider && res.modelId
        ? { provider: res.provider, modelId: res.modelId }
        : null;
    const nextLastUsed =
      res.lastUsedProvider && res.lastUsedModelId
        ? { provider: res.lastUsedProvider, modelId: res.lastUsedModelId }
        : null;
    const hasLastUsedField =
      res.lastUsedProvider !== undefined ||
      res.lastUsedModelId !== undefined;
    const changed =
      !sameSelected(current, next) ||
      (hasLastUsedField && !sameSelected(lastUsed, nextLastUsed));
    if (!changed) return;
    current = next;
    if (hasLastUsedField) lastUsed = nextLastUsed;
    emit();
  } catch {
    // sidecar 不可用：保留本地现状
  }
}

/** 草稿期切换模型（还没有 sessionId）：只更新最近使用缓存，不改默认模型。
 *  失败时不更新本地镜像，保持与 sidecar 单一事实源一致。 */
export async function rememberLastUsedModel(model: SelectedModel): Promise<void> {
  await piRequest({
    type: "set_last_used_model",
    provider: model.provider,
    modelId: model.modelId,
  });
  setLastUsed(model);
}

/** 选中模型。
 *  sessionId 提供 = 会话定靶选择（对话页选择器）：sidecar 只对该会话落模型真值
 *  行/偏好列，其余会话不动；**不更新本地默认值、不写 kv**——定靶失败原样抛出
 *  给调用方（pi-session-model 负责回退显示）。
 *  缺省 = 默认模型变更（设置页/启动恢复）：写本地态 + SQLite kv + sidecar，
 *  并只刷从未显式选过模型的驻留会话。sidecar 拒绝（模型不在目录/无凭据）时
 *  UI 回退到 sidecar 真值且不写 SQLite，避免"界面显示 A、请求用默认模型 B"的假象。 */
export async function setSelectedModel(
  model: SelectedModel | null,
  sessionId?: string,
) {
  if (sessionId) {
    if (!model) return;
    await piRequest({
      type: "set_model",
      sessionId,
      provider: model.provider,
      modelId: model.modelId,
    });
    // 会话定靶切换也是「用户主动切换」：sidecar 已把它记进 lastUsed 缓存，
    // 本地镜像跟着更新（不等下一次 get_model 回拉）
    setLastUsed(model);
    return;
  }

  const previous = current;
  current = model;
  emit();

  if (model) {
    try {
      await piRequest({
        type: "set_model",
        provider: model.provider,
        modelId: model.modelId,
        // 设置页/引导页的用户切换：同时更新「最近使用」缓存。启动恢复走的是
        // 不带该标记的裸请求，不会把 lastUsed 冲回默认模型。
        rememberAsLastUsed: true,
      });
      setLastUsed(model);
    } catch {
      if (current === model) {
        current = previous;
        emit();
      }
      void syncSelectedModelFromSidecar();
      return;
    }
  }

  if (!isDesktop()) return;
  const write =
    model == null
      ? invoke("kv_delete", { key: KV_KEY })
      : invoke("kv_set", { key: KV_KEY, value: JSON.stringify(model) });
  void write.catch(() => {});
}

/** 从 SQLite 恢复选中模型并同步 sidecar，应用启动时调用 */
export async function initModelSettings(): Promise<void> {
  if (initialized || !isDesktop()) return;
  initialized = true;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (value) {
      const model = JSON.parse(value) as SelectedModel;
      if (model?.provider && model?.modelId) {
        current = model;
        emit();
        try {
          // 启动恢复不是用户切换：不带 rememberAsLastUsed，别把缓存冲回默认模型
          await piRequest({
            type: "set_model",
            provider: model.provider,
            modelId: model.modelId,
          });
          // 恢复成功后补拉一次：get_model 同时带回 lastUsed（新对话首选）
          void syncSelectedModelFromSidecar();
        } catch {
          // 恢复被拒（模型已删/无凭据）或 sidecar 不可用：以 sidecar 真值校准 UI，
          // 避免界面显示 A 而请求实际走默认模型
          await syncSelectedModelFromSidecar();
        }
      }
    } else {
      // 无本地持久化（如远程模式/清空过）：sidecar 可能仍持有选择，校准 UI
      await syncSelectedModelFromSidecar();
    }
  } catch {
    // 数据库不可用时保持默认模型
  }
}

// client bundle 加载即恢复（SSR 端 isDesktop() 为 false，直接跳过）
void initModelSettings();

// 远程模式：无本地 kv，initModelSettings 整体跳过，sidecar 仍持有当前模型
// 选择却没人校准 UI（欢迎页会卡在「先选择模型」）——WS 通道注册后按 sidecar
// 真值同步一次（get_model 不在网关拒绝名单；桌面端走 kv 恢复既有路径，
// 测试/预览环境的假通道由 isRemoteMode 挡掉）
addPiChannelListener((ch) => {
  if (ch?.kind === "ws" && isRemoteMode()) void syncSelectedModelFromSidecar();
});
