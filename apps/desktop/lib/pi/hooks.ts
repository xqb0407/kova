"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiHookConfig } from "@/lib/pi/pi-bridge";

/**
 * 生命周期钩子（设置 → 钩子）：Claude Code 式外部命令钩子的配置镜像。
 * 事实源在 sidecar——SQLite kv（键 pi.hooks）整包持久化，PreToolUse /
 * PermissionRequest 在工具调用/审批路径同步生效；这里只做镜像缓存：
 * 启动 get_hooks 水合，保存走 set_hooks（与 memory 同款链路）。
 */

export type HookConfig = PiHookConfig;

let current: HookConfig[] = [];
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHookConfigs(): HookConfig[] {
  return current;
}

export function useHookConfigs(): HookConfig[] {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => [] as HookConfig[],
  );
}

/** 从 sidecar 水合镜像（client bundle 加载即调；sidecar 不可用则保持空表） */
export async function initHookConfigs(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "hooks"; hooks: HookConfig[] }>({
      type: "get_hooks",
    });
    current = res.hooks;
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持空表，保存时仍会尝试
  }
}

async function push(next: HookConfig[]): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_hooks", hooks: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 新增一条钩子（id 在镜像侧生成，sidecar 兜底补缺） */
export async function addHookConfig(config: Omit<HookConfig, "id">): Promise<void> {
  const id = `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await push([...current, { ...config, id }]);
}

export async function updateHookConfig(id: string, next: HookConfig): Promise<void> {
  await push(current.map((h) => (h.id === id ? next : h)));
}

export async function removeHookConfig(id: string): Promise<void> {
  await push(current.filter((h) => h.id !== id));
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回空表）
void initHookConfigs();
