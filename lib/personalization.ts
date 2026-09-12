"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import type { PiPersonalization, PiPersonalizationStyle } from "@/lib/pi-bridge";

/**
 * 个性化（设置 → 个性化）：回复风格 / 称呼与身份 / 人设 / 自定义指令。
 * 事实源在 sidecar——SQLite kv 整包持久化 + 活动会话系统提示词热替换；
 * 这里只做镜像缓存：启动 get_personalization 水合，保存走 set_personalization。
 * 桌面与远程网页共用同一链路（远程经 WS 转发到同一 sidecar），桌面端无需
 * 直接读写 Tauri kv，远程改动也能持久化。
 */
export type Personalization = PiPersonalization;
export type PersonalizationStyle = PiPersonalizationStyle;

export const DEFAULT_PERSONALIZATION: Personalization = {
  style: "default",
  userName: "",
  assistantName: "",
  persona: "",
  customInstructions: "",
};

/** 回复风格档位（设置页选项；value 与 sidecar STYLE_PROMPTS 一一对应） */
export const PERSONALIZATION_STYLE_OPTIONS: {
  value: PersonalizationStyle;
  label: string;
  desc: string;
}[] = [
  { value: "default", label: "默认", desc: "平衡的日常协作语气" },
  { value: "professional", label: "专业", desc: "精炼、结构化、先给结论" },
  { value: "friendly", label: "亲和", desc: "轻松友好，更像伙伴" },
  { value: "imaginative", label: "天马行空", desc: "创意发散，先发散再收敛" },
  { value: "blunt", label: "直言不讳", desc: "有话直说，不绕弯子" },
  { value: "guiding", label: "启发引导", desc: "多提问引导，带你推导" },
];

let current: Personalization = DEFAULT_PERSONALIZATION;
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPersonalization(): Personalization {
  return current;
}

export function usePersonalization(): Personalization {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_PERSONALIZATION,
  );
}

/** 从 sidecar 水合镜像（启动时调用一次；sidecar 不可用则保持默认） */
export async function initPersonalization(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "personalization"; settings: Personalization }>({
      type: "get_personalization",
    });
    current = { ...DEFAULT_PERSONALIZATION, ...res.settings };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存个性化设置：乐观更新本地镜像；sidecar 落 SQLite 并热更新活动会话，
 *  失败时回滚并抛出（设置页据此提示） */
export async function savePersonalization(next: Personalization): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_personalization", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initPersonalization();
