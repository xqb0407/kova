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

/** 选中模型：写 SQLite + 同步 sidecar（对活动会话立即 setModel，新会话生效） */
export async function setSelectedModel(model: SelectedModel | null) {
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
      // sidecar 不可用时仍保留本地选择，下次启动再同步
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
        void piRequest({
          type: "set_model",
          provider: model.provider,
          modelId: model.modelId,
        }).catch(() => {});
      }
    }
  } catch {
    // 数据库不可用时保持默认模型
  }
}

// client bundle 加载即恢复（SSR 端 isTauri() 为 false，直接跳过）
void initModelSettings();
