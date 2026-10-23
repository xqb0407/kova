"use client";

import { useSyncExternalStore } from "react";
import {
  SUBAGENT_MAX_CONCURRENCY_DEFAULT,
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
} from "pi-protocol";
import { piRequest, type PiSubagentSettings } from "@/lib/pi/pi-bridge";

/**
 * 子智能体并发设置镜像：事实源在 sidecar kv（pi.subagentMaxConcurrency，
 * 判定见 subagent/settings.ts）；client bundle 加载即 get_subagent_settings
 * 水合，保存走 set_subagent_settings（与 sandbox/auto-review 同款链路）。
 */
export type SubagentSettings = PiSubagentSettings;

export const SUBAGENT_SETTINGS_DEFAULT: SubagentSettings = {
  maxConcurrency: SUBAGENT_MAX_CONCURRENCY_DEFAULT,
};
export {
  SUBAGENT_MAX_CONCURRENCY_DEFAULT,
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
};

let current: SubagentSettings = SUBAGENT_SETTINGS_DEFAULT;
const listeners = new Set<() => void>();
let initialized = false;

// getServerSnapshot 必须是稳定引用，避免 React 判定快照每次都在变。
const SERVER_SNAPSHOT: SubagentSettings = SUBAGENT_SETTINGS_DEFAULT;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSubagentSettings(): SubagentSettings {
  return current;
}

export function useSubagentSettings(): SubagentSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => SERVER_SNAPSHOT,
  );
}

/** 强制从 sidecar 刷新镜像；设置页每次挂载可再调一次，弥补启动早期 sidecar 未就绪 */
export async function refreshSubagentSettings(): Promise<void> {
  try {
    const res = await piRequest<{ type: "subagent_settings"; settings: SubagentSettings }>({
      type: "get_subagent_settings",
    });
    current = res.settings ?? SUBAGENT_SETTINGS_DEFAULT;
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持当前值，保存时仍会尝试
  }
}

/** 从 sidecar 水合镜像（client bundle 加载即调；sidecar 不可用则保持缺省） */
export async function initSubagentSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshSubagentSettings();
}

/** 全量覆盖：乐观更新 + 失败回滚（与 sandbox/auto-review 同款） */
export async function saveSubagentSettings(next: SubagentSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    const res = await piRequest<{ type: "subagent_settings"; settings: SubagentSettings }>({
      type: "set_subagent_settings",
      settings: next,
    });
    current = res.settings ?? SUBAGENT_SETTINGS_DEFAULT;
    emit();
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回缺省）
void initSubagentSettings();
