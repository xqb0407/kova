"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";
import { piRequest } from "@/lib/pi-bridge";

/**
 * 当前选中的 pi 模型：持久化到 SQLite（kv 表），同步到 sidecar 运行态。
 * 模型列表本身实时读 pi 的 ModelRegistry（含内置 + models.json 自定义），
 * 这里只存"选了哪个"——不写 pi 的配置文件，不影响 CLI。
 */
export type SelectedModel = { provider: string; modelId: string };

const KV_KEY = "pi.model";

let current: SelectedModel | null = null;
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

/** 以 sidecar 当前模型为准校准前端选择（启动恢复失败/选择被拒后的真值同步）。
 *  sidecar 未选择时返回空串 → 前端清空为 null（显示"选择模型"占位）。 */
export async function syncSelectedModelFromSidecar(): Promise<void> {
  try {
    const res = await piRequest<{
      type: "model";
      provider: string;
      modelId: string;
    }>({ type: "get_model" });
    const next =
      res.provider && res.modelId
        ? { provider: res.provider, modelId: res.modelId }
        : null;
    const changed =
      (current?.provider ?? "") !== (next?.provider ?? "") ||
      (current?.modelId ?? "") !== (next?.modelId ?? "");
    if (changed) {
      current = next;
      emit();
    }
  } catch {
    // sidecar 不可用：保留本地现状
  }
}

/** 选中模型：写 SQLite + 同步 sidecar（对活动会话立即 setModel，新会话生效）。
 *  sidecar 拒绝（模型不在目录/无凭据）时 UI 回退到 sidecar 真值且不写 SQLite，
 *  避免"界面显示 A、请求用默认模型 B"的假象。 */
export async function setSelectedModel(model: SelectedModel | null) {
  const previous = current;
  current = model;
  emit();

  if (model) {
    try {
      await piRequest({
        type: "set_model",
        provider: model.provider,
        modelId: model.modelId,
      });
    } catch {
      if (current === model) {
        current = previous;
        emit();
      }
      void syncSelectedModelFromSidecar();
      return;
    }
  }

  if (!isTauri()) return;
  const write =
    model == null
      ? invoke("kv_delete", { key: KV_KEY })
      : invoke("kv_set", { key: KV_KEY, value: JSON.stringify(model) });
  void write.catch(() => {});
}

/** 从 SQLite 恢复选中模型并同步 sidecar，应用启动时调用 */
export async function initModelSettings(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (value) {
      const model = JSON.parse(value) as SelectedModel;
      if (model?.provider && model?.modelId) {
        current = model;
        emit();
        try {
          await piRequest({
            type: "set_model",
            provider: model.provider,
            modelId: model.modelId,
          });
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

// client bundle 加载即恢复（SSR 端 isTauri() 为 false，直接跳过）
void initModelSettings();
