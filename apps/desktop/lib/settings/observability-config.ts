"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiObservabilityConfig } from "@/lib/pi/pi-bridge";

/**
 * 可观测性导出配置（设置 → 系统 → 追踪）的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化，otlp-exporter 每次 run 结算实时门控；
 * 这里只做镜像缓存：模块加载 get_observability 水合，保存走 set_observability
 * （与浏览器驱动开关同款链路）。
 */

export type ObservabilityConfig = PiObservabilityConfig;

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: false,
  endpoint: "",
  headers: {},
  sampleRate: 1,
  redactContent: true,
};

let current: ObservabilityConfig = DEFAULT_OBSERVABILITY_CONFIG;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getObservabilityConfig(): ObservabilityConfig {
  return current;
}

export function useObservabilityConfig(): ObservabilityConfig {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_OBSERVABILITY_CONFIG,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次；sidecar 不可用则保持默认） */
export async function initObservabilityConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{
      type: "observability";
      settings: ObservabilityConfig;
    }>({
      type: "get_observability",
    });
    current = { ...DEFAULT_OBSERVABILITY_CONFIG, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存配置：乐观更新本地镜像；sidecar 落 SQLite 即生效（exporter 实时读），
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveObservabilityConfig(next: ObservabilityConfig): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_observability", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initObservabilityConfig();
