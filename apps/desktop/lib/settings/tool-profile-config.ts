"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiToolProfileSettings } from "@/lib/pi/pi-bridge";

/**
 * 工具面档位（设置 → 智能体 → 智能体配置）的配置镜像。
 * 事实源在 sidecar——SQLite kv 持久化（pi.toolProfile），coding 档由 buildTools
 * 收掉创作/辅助类工具（文生图/视觉辅助/面板唤起），调试用的 browser/截图/
 * 知识库照常保留；这里只做镜像缓存：get_tool_profile 水合，保存走
 * set_tool_profile（与视觉辅助/文生图同款链路）。
 */

export type ToolProfileValue = PiToolProfileSettings["profile"];
export type ToolProfileSettings = PiToolProfileSettings;

export const DEFAULT_TOOL_PROFILE_SETTINGS: ToolProfileSettings = {
  profile: "full",
};

let current: ToolProfileSettings = DEFAULT_TOOL_PROFILE_SETTINGS;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToolProfileSettings(): ToolProfileSettings {
  return current;
}

export function useToolProfileSettings(): ToolProfileSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_TOOL_PROFILE_SETTINGS,
  );
}

/** 从 sidecar 拉最新档位（sidecar 不可用则保持当前镜像） */
export async function refreshToolProfileSettings(): Promise<void> {
  try {
    const res = await piRequest<{
      type: "tool_profile";
      settings: ToolProfileSettings;
    }>({ type: "get_tool_profile" });
    current = { ...DEFAULT_TOOL_PROFILE_SETTINGS, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存档位：乐观更新本地镜像；sidecar 落 SQLite 并热重建活动会话工具表，
 *  失败时回滚并抛出（设置页据此提示） */
export async function saveToolProfileSettings(next: ToolProfileSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_tool_profile", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void refreshToolProfileSettings();
