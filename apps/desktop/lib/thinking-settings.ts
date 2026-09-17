"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";
import { piRequest } from "@/lib/pi-bridge";

/**
 * 深度思考档位：持久化到 SQLite（kv 表），同步 sidecar 运行态（set_thinking
 * 广播活动会话），与 model-settings 同款形态。composer 的下拉选档直接
 * setThinkingLevel；各 provider adapter 按 model.thinkingLevelMap 翻译成
 * effort/budget 等自家值，不支持的档位由 pi-ai 守门钳回 off。
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const KV_KEY = "pi.thinking";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

let current: ThinkingLevel = "off";
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getThinkingLevel(): ThinkingLevel {
  return current;
}

export function useThinkingLevel(): ThinkingLevel {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => "off",
  );
}

/** 设置档位：本地态 + sidecar set_thinking + SQLite 持久化 */
export async function setThinkingLevel(level: ThinkingLevel): Promise<void> {
  if (!THINKING_LEVELS.includes(level)) return;
  current = level;
  emit();

  try {
    await piRequest({ type: "set_thinking", level });
  } catch {
    // sidecar 不可用时仍保留本地选择，下次启动再同步
  }

  if (!isTauri()) return;
  void invoke("kv_set", { key: KV_KEY, value: level }).catch(() => {});
}

/** 从 SQLite 恢复档位并同步 sidecar，应用启动时自动调用 */
export async function initThinkingSettings(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (value && THINKING_LEVELS.includes(value as ThinkingLevel)) {
      current = value as ThinkingLevel;
      emit();
      void piRequest({ type: "set_thinking", level: current }).catch(() => {});
    }
  } catch {
    // 数据库不可用时保持默认（off）
  }
}

// client bundle 加载即恢复（SSR 端 isTauri() 为 false，直接跳过）
void initThinkingSettings();
