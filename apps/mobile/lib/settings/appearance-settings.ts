/**
 * 外观偏好（主题档位）：与桌面端 ui-prefs 的 `theme` 同语义的移动端版。
 *
 * 桌面端把偏好写 localStorage，移动端走 syncStorage 垫片（AsyncStorage 播种 +
 * 内存 Map 同步读），键名带 `pi.` 前缀才会被 hydrateStorage 捞回来。
 * 引导页的「外观」步骤与 ThemeProvider 读的是同一份数据：改完即时生效，
 * 不需要重启（ThemeProvider 订阅这里的变化）。
 */
import { useSyncExternalStore } from "react";
import { syncStorage } from "@/lib/mobile/storage";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "pi.appearance.mode";

function read(): ThemeMode {
  const raw = syncStorage.getItem(KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** 播种值延迟到首次访问才读：模块加载早于 hydrateStorage，加载期读会拿到空 Map */
let current: ThemeMode | null = null;
const listeners = new Set<() => void>();

export function getThemeMode(): ThemeMode {
  if (current === null) current = read();
  return current;
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === getThemeMode()) return;
  current = mode;
  syncStorage.setItem(KEY, mode);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 渲染期读当前档位；setThemeMode 后订阅者即时重渲染 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, getThemeMode);
}
