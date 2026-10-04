"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiImageGenConfig } from "@/lib/pi/pi-bridge";

/**
 * 文生图配置（设置 → 模型 → 文生图）的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化，generate_image 工具 execute 内实时
 * 门控；这里只做镜像缓存：模块加载 get_imagegen 水合，保存走 set_imagegen
 * （与浏览器驱动/记忆同款链路）。默认关闭：生图按张计费，需用户显式开启。
 */

export type ImageGenConfig = PiImageGenConfig;

export const DEFAULT_IMAGEGEN_CONFIG: ImageGenConfig = {
  enabled: false,
  provider: "",
  modelId: "",
  size: "1024x1024",
  imageModels: [],
};

let current: ImageGenConfig = DEFAULT_IMAGEGEN_CONFIG;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getImageGenConfig(): ImageGenConfig {
  return current;
}

export function useImageGenConfig(): ImageGenConfig {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_IMAGEGEN_CONFIG,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次；sidecar 不可用则保持默认） */
export async function initImageGenConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "imagegen"; settings: ImageGenConfig }>({
      type: "get_imagegen",
    });
    current = { ...DEFAULT_IMAGEGEN_CONFIG, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存配置整包：乐观更新本地镜像；sidecar 落 SQLite 即生效（execute 实时读），
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveImageGenConfig(next: ImageGenConfig): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_imagegen", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 勾选/取消模型的"可生图"标记（模型属性弹窗入口）：清单随整包配置落 sidecar kv，
 *  list_models 按它透出 t2i。无变化时静默 no-op；失败抛出（调用方提示并回滚镜像）。 */
export async function setModelImageCapable(
  provider: string,
  modelId: string,
  capable: boolean,
): Promise<void> {
  const key = `${provider}/${modelId}`;
  if (current.imageModels.includes(key) === capable) return;
  const imageModels = capable
    ? [...current.imageModels, key]
    : current.imageModels.filter((k) => k !== key);
  await saveImageGenConfig({ ...current, imageModels });
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initImageGenConfig();
