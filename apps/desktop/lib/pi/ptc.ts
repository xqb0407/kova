"use client";

import { useSyncExternalStore } from "react";
import { piRequest, type PiPtcSettings } from "@/lib/pi/pi-bridge";

/**
 * PTC（程序化工具调用）开关的镜像：事实源在 sidecar 的 SQLite kv（键 pi.ptc），
 * 这里只做缓存与设置页读取。开关在 sidecar 侧按「会话物化时快照」生效，
 * 所以 UI 必须提示「新建会话后生效」。
 */

const DEFAULT_SETTINGS: PiPtcSettings = Object.freeze({ enabled: false });

let current: PiPtcSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<() => void>();
let initialized = false;

/** getServerSnapshot 必须返回稳定引用，否则 React 会判定快照每帧都变。 */
const SERVER_SNAPSHOT: PiPtcSettings = DEFAULT_SETTINGS;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPtcSettings(): PiPtcSettings {
  return current;
}

export function usePtcSettings(): PiPtcSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => SERVER_SNAPSHOT,
  );
}

/** 从 sidecar 水合镜像（client bundle 加载即调；sidecar 不可用则保持缺省）。 */
export async function initPtcSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshPtcSettings();
}

/** 设置页挂载时补一次水合：启动早期 sidecar 未就绪时，模块级 init 可能停在缺省。 */
export async function refreshPtcSettings(): Promise<void> {
  try {
    const res = await piRequest<{ type: "ptc"; settings: PiPtcSettings }>({
      type: "get_ptc",
    });
    current = res.settings ?? { ...DEFAULT_SETTINGS };
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持当前值，保存时仍会尝试
  }
}

/** 乐观更新 + 失败回滚；以 sidecar 回执为准。 */
export async function savePtcSettings(next: PiPtcSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    const res = await piRequest<{ type: "ptc"; settings: PiPtcSettings }>({
      type: "set_ptc",
      settings: next,
    });
    current = res.settings ?? { ...DEFAULT_SETTINGS };
    emit();
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求）
void initPtcSettings();
