"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiAutoVerifySettings } from "@/lib/pi/pi-bridge";

/**
 * autoVerify（设置 → 模型 → 完成后自动验证）的配置镜像。
 * 事实源在 sidecar——SQLite kv（pi.autoVerify），agent_end 结算点实时读它
 * 决定是否注入只读验证 followUp；这里只做镜像缓存：模块加载 get_auto_verify
 * 水合，保存走 set_auto_verify（与视觉辅助/文生图同款链路）。
 * 默认关闭：关闭时 agent_end 不注入，行为与未引入该能力前逐字节一致。
 */

export type AutoVerifySettings = PiAutoVerifySettings;

export const DEFAULT_AUTO_VERIFY_SETTINGS: AutoVerifySettings = {
  enabled: false,
};

let current: AutoVerifySettings = DEFAULT_AUTO_VERIFY_SETTINGS;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAutoVerifySettings(): AutoVerifySettings {
  return current;
}

export function useAutoVerifySettings(): AutoVerifySettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_AUTO_VERIFY_SETTINGS,
  );
}

/** 从 sidecar 水合镜像（模块加载调用一次；sidecar 不可用则保持默认关） */
export async function initAutoVerifySettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{
      type: "auto_verify";
      settings: AutoVerifySettings;
    }>({ type: "get_auto_verify" });
    current = { ...DEFAULT_AUTO_VERIFY_SETTINGS, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存开关：乐观更新本地镜像；sidecar 落 SQLite 即生效（下一次 agent_end
 *  按新值判定），失败时回滚并抛出（设置页据此提示） */
export async function saveAutoVerifySettings(next: AutoVerifySettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_auto_verify", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 开关翻转（设置页 toggle 用） */
export async function setAutoVerifyEnabled(enabled: boolean): Promise<void> {
  await saveAutoVerifySettings({ enabled });
}

// 模块加载即水合（与 vision-tool-config 同款：sidecar 就绪后镜像与 kv 对齐）
void initAutoVerifySettings();
