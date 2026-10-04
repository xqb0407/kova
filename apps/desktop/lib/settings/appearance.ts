"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * 窗口背景效果（穿透高斯模糊）：持久化到 SQLite（kv 表），
 * 双层应用——Rust 窗口材质（set_window_effect 命令）+ 前端根层透明标记。
 * 仅桌面端可设置；远程网页端无窗口材质概念，保持不透明。
 */
export type WindowEffectName = "none" | "acrylic" | "mica";

const KV_KEY = "appearance.effect";

let current: WindowEffectName = "none";
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 根节点打标，globals.css 据此让 body 透明露出窗口材质 */
function applyDom(effect: WindowEffectName) {
  if (effect === "none") {
    delete document.documentElement.dataset.windowEffect;
  } else {
    document.documentElement.dataset.windowEffect = effect;
  }
}

export function getWindowEffect(): WindowEffectName {
  return current;
}

export function useWindowEffect(): WindowEffectName {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => "none" as const,
  );
}

/** 切换效果：先应用窗口材质再透明根层（开启）/先恢复根层再移除材质（关闭），避免闪白 */
export async function setWindowEffect(effect: WindowEffectName): Promise<void> {
  if (!isTauri()) return;
  if (effect !== "none") {
    await invoke("set_window_effect", { effect });
    current = effect;
    applyDom(effect);
  } else {
    current = "none";
    applyDom("none");
    await invoke("set_window_effect", { effect: null });
  }
  emit();
}

/** 从 SQLite 恢复并应用，应用启动时调用（窗口材质已由 Rust setup 恢复，这里补透明标记） */
export async function initAppearance(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (value === "acrylic" || value === "mica") {
      current = value;
      applyDom(value);
      emit();
    }
  } catch {
    // 数据库不可用时保持不透明
  }
}

// client bundle 加载即恢复（SSR 端 isTauri() 为 false，直接跳过）
void initAppearance();
