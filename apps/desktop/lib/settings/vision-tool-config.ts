"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiVisionToolSettings } from "@/lib/pi/pi-bridge";

/**
 * 视觉辅助配置（设置 → 模型 → 视觉辅助）的配置镜像。
 * 事实源在 sidecar——SQLite kv 整包持久化（pi.visionTool），see_image 的
 * 条件注册与 streamFn 占位替换都实时读它；这里只做镜像缓存：模块加载
 * get_vision_tool 水合，保存走 set_vision_tool（与文生图/浏览器驱动同款链路）。
 * 默认关闭：关闭时 sidecar 不注册工具、不替换图片占位，提示词零污染。
 */

export type VisionToolSettings = PiVisionToolSettings;

export const DEFAULT_VISION_TOOL_SETTINGS: VisionToolSettings = {
  enabled: false,
  provider: "",
  modelId: "",
};

let current: VisionToolSettings = DEFAULT_VISION_TOOL_SETTINGS;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVisionToolSettings(): VisionToolSettings {
  return current;
}

export function useVisionToolSettings(): VisionToolSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_VISION_TOOL_SETTINGS,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次；sidecar 不可用则保持默认关） */
export async function initVisionToolSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{
      type: "vision_tool";
      settings: VisionToolSettings;
    }>({ type: "get_vision_tool" });
    current = { ...DEFAULT_VISION_TOOL_SETTINGS, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存配置整包：乐观更新本地镜像；sidecar 落 SQLite 并重建活动会话工具表，
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveVisionToolSettings(next: VisionToolSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_vision_tool", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 非响应式读取（发送路径等非 React 上下文查开关用）；未水合时为默认关 */
export function isVisionToolEnabled(): boolean {
  return current.enabled;
}

/** 指定/清除视觉辅助模型（provider+modelId 成对传入；空对 = 自动挑选）。
 *  开关状态取当前镜像原样保留，不在此处改动。 */
export async function setVisionToolModel(
  provider: string,
  modelId: string,
): Promise<void> {
  await saveVisionToolSettings({ ...current, provider, modelId });
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initVisionToolSettings();
