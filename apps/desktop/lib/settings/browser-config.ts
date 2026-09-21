"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiBrowserConfig } from "@/lib/pi/pi-bridge";

/**
 * 浏览器驱动开关（设置 → 通用 → 智能体工具）的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化，browser_* 工具 execute 内实时门控；
 * 这里只做镜像缓存：模块加载 get_browser 水合，保存走 set_browser（与记忆同款链路）。
 */

export type BrowserConfig = PiBrowserConfig;

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
};

let current: BrowserConfig = DEFAULT_BROWSER_CONFIG;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBrowserConfig(): BrowserConfig {
  return current;
}

export function useBrowserConfig(): BrowserConfig {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_BROWSER_CONFIG,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次；sidecar 不可用则保持默认） */
export async function initBrowserConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "browser"; settings: BrowserConfig }>({
      type: "get_browser",
    });
    current = { ...DEFAULT_BROWSER_CONFIG, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存开关：乐观更新本地镜像；sidecar 落 SQLite 即生效（execute 实时读），
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveBrowserConfig(next: BrowserConfig): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_browser", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initBrowserConfig();
