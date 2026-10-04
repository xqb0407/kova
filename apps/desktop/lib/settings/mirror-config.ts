"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiMirrorConfig } from "@/lib/pi/pi-bridge";

/**
 * 访问加速设置（设置 → 系统 → 访问加速）的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化，WebFetch 与 bash 的 git 注入每次调用
 * 实时读配置；这里只做镜像缓存：模块加载 get_mirror 水合，保存走 set_mirror
 * （与 browser-config / 记忆同款链路）。
 */

export type MirrorConfig = PiMirrorConfig;

/** ghproxy 系加速站。前缀 + 原 URL 即得可直连地址；换一家在设置页改即可 */
export const DEFAULT_GITHUB_PREFIX = "https://ghfast.top";

export const DEFAULT_MIRROR_CONFIG: MirrorConfig = {
  enabled: true,
  githubPrefix: DEFAULT_GITHUB_PREFIX,
  gitInsteadOf: true,
  customRules: [],
};

let current: MirrorConfig = DEFAULT_MIRROR_CONFIG;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMirrorConfig(): MirrorConfig {
  return current;
}

export function useMirrorConfig(): MirrorConfig {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_MIRROR_CONFIG,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次，与 app-mode 同款可重入：sidecar 重启
 *  后再拉一次即收敛；SSR 端没有通道，直接跳过） */
export async function initMirrorConfig(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await piRequest<{ type: "mirror"; settings: MirrorConfig }>({
      type: "get_mirror",
    });
    current = { ...DEFAULT_MIRROR_CONFIG, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存设置：乐观更新本地镜像；sidecar 落 SQLite 即生效（每次调用实时读），
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveMirrorConfig(next: MirrorConfig): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_mirror", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initMirrorConfig();
