"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * Chrome(WebView2) 硬件加速开关：持久化于 SQLite kv（Rust 侧 gpu.rs），
 * 启动建窗时由 Rust 读取——关闭后为 WebView2 追加 --disable-gpu。
 * 本模块只负责设置页展示/保存「期望值」；当前进程实际生效与否在启动瞬间
 * 已定，改完必须重启应用（文案已注明）。仅 Windows 桌面端消费。
 */
let enabled = true;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGpuAccelEnabled(): boolean {
  return enabled;
}

export function useGpuAccelEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    getGpuAccelEnabled,
    () => true,
  );
}

export async function setGpuAccelEnabled(next: boolean): Promise<void> {
  if (!isTauri() || next === enabled) return;
  try {
    await invoke("set_gpu_acceleration", { enabled: next });
  } catch {
    // 写库失败不落本地状态，界面保持与持久值一致
    return;
  }
  enabled = next;
  emit();
}

/** 启动恢复已保存的开关值，client bundle 加载即执行（SSR 端 isTauri() 为 false，跳过） */
export async function initGpuAccel(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    const value = await invoke<boolean>("get_gpu_acceleration");
    if (value !== enabled) {
      enabled = value;
      emit();
    }
  } catch {
    // 命令不可用时保持默认开启
  }
}

void initGpuAccel();
