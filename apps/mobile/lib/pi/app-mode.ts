"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiAppMode } from "@/lib/pi/pi-bridge";
import { syncStorage } from "@/lib/mobile/storage";

/**
 * 全局工作模式（work / code / design，设置 → 通用）：事实源在 sidecar（SQLite kv +
 * set_app_mode 时活动会话系统提示词热替换），这里只做响应式镜像 store——
 * git UI 显隐与消息工具行形态在本进程内即时跟随。
 * 水合纪律同 pi-session-mode：localStorage 播种（sidecar 重启/断链也能恢复 UI），
 * 再向 sidecar 拉活动真值覆盖；请求失败（含旧版 sidecar 无此命令）静默保留
 * 播种值并置 degraded 标记，供设置页标注「sidecar 不支持，仅影响界面」。
 */

export type AppMode = PiAppMode;

const STORAGE_KEY = "app.mode";

const APP_MODES: readonly string[] = ["work", "code", "design"];

/** 任意来源（localStorage 播种 / sidecar 应答 / 本地切换）的宽松规整：仅接受三档字面量 */
function normalizeAppMode(raw: unknown): AppMode {
  return typeof raw === "string" && APP_MODES.includes(raw) ? (raw as AppMode) : "code";
}

let current: AppMode = "code";
/** true = 事实源仍由 sidecar 掌管；false = 水合/写入失败（旧版 sidecar 等），
 *  当前值只是本地缓存的影子，提示词不会跟随 */
let degraded = false;

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function emit(mode: AppMode) {
  current = mode;
  notify();
}

function readSeed(): AppMode {
  try {
    return normalizeAppMode(syncStorage.getItem(STORAGE_KEY));
  } catch {
    return "code";
  }
}

function writeSeed(mode: AppMode) {
  try {
    syncStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppMode(): AppMode {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => "code" as AppMode,
  );
}

/** 当前值快照（非响应式；测试与非 hook 上下文用） */
export function getAppMode(): AppMode {
  return current;
}

/** sidecar 是否仍在掌管真值（false = 旧版 sidecar / 通信失败，UI 与提示词可能不一致） */
export function useAppModeDegraded(): boolean {
  return useSyncExternalStore(subscribe, () => degraded, () => false);
}

/** 降级标记快照（非响应式；测试用） */
export function getAppModeDegraded(): boolean {
  return degraded;
}

/** 模块加载即播种并水合真值（与 ui-prefs 同款；SSR 安全：无 window 跳过） */
export function initAppMode(): void {
  if (typeof window === "undefined") return;
  current = readSeed();
  void piRequest<{ type: "app_mode"; mode: AppMode }>({ type: "get_app_mode" })
    .then((res) => {
      if (res.type !== "app_mode") return;
      degraded = false;
      emit(normalizeAppMode(res.mode));
    })
    .catch(() => {
      // 旧版 sidecar / 通信失败：保留播种值，UI 照常切换（提示词不跟随）
      degraded = true;
      notify();
    });
}

/** 切换工作模式：先发 sidecar（应答即真值），成功后更新镜像并写缓存；失败回弹 */
export function setAppMode(mode: AppMode): Promise<void> {
  return piRequest<{ type: "app_mode"; mode: AppMode }>({
    type: "set_app_mode",
    mode,
  })
    .then((res) => {
      if (res.type !== "app_mode") return;
      degraded = false;
      emit(normalizeAppMode(res.mode));
      writeSeed(res.mode);
    })
    .catch((err) => {
      // 写入失败：标记降级但仍本地生效（与 ui-prefs 断链语义一致），下次启动水合收敛
      degraded = true;
      emit(mode);
      writeSeed(mode);
      console.error("set_app_mode failed:", err);
    });
}

void initAppMode();
