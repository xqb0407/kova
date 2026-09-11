"use client";

import { useSyncExternalStore } from "react";

/**
 * 界面外观偏好（主题/强调色/字号/对话宽度）：
 * 持久化于 localStorage，按客户端各自保存——桌面 WebView 与远程网页互不影响。
 * 生效链路：layout.tsx 预绘制脚本先行应用（防 FOUC），本模块在 client bundle
 * 加载时接管（initUiPrefs），负责读回数据、跟随系统主题监听与设置页的响应式更新。
 * 注意：预绘制脚本与本文件 applyPrefs 的字段/选择器需保持一致。
 * 窗口背景材质不在此列——需 Rust 侧启动恢复，持久化于 SQLite kv（lib/appearance.ts）。
 */
export type ThemeMode = "system" | "light" | "dark";
export type AccentName =
  | "default"
  | "blue"
  | "violet"
  | "green"
  | "orange"
  | "rose";
export type FontSizeName = "sm" | "md" | "lg";
export type ChatWidthName = "narrow" | "md" | "wide";
export type FontFamilyName =
  | "default"
  | "inter"
  | "segoe"
  | "roboto"
  | "open-sans"
  | "noto-sans-sc"
  | "serif"
  | "noto-serif-sc"
  | "kai"
  | "wenkai"
  | "mono"
  | "jetbrains";

export type UiPrefs = {
  theme: ThemeMode;
  accent: AccentName;
  fontSize: FontSizeName;
  chatWidth: ChatWidthName;
  fontFamily: FontFamilyName;
};

export const UI_PREFS_KEY = "ui.prefs";

export const DEFAULT_PREFS: UiPrefs = {
  theme: "system",
  accent: "default",
  fontSize: "md",
  chatWidth: "md",
  fontFamily: "default",
};

/** 字号档位 → 根元素 font-size（rem 体系下等比缩放整体界面）；md 为浏览器默认 16px */
const FONT_SIZE_PX: Record<Exclude<FontSizeName, "md">, string> = {
  sm: "15px",
  lg: "17px",
};

let prefs: UiPrefs = { ...DEFAULT_PREFS };
const listeners = new Set<() => void>();
let initialized = false;

const systemDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 将偏好落到 html 根元素：.dark 类 / data-accent / 根字号 / data-chat-width / data-font */
export function applyPrefs(p: UiPrefs) {
  const root = document.documentElement;
  root.classList.toggle(
    "dark",
    p.theme === "dark" || (p.theme === "system" && systemDark()),
  );
  if (p.accent === "default") delete root.dataset.accent;
  else root.dataset.accent = p.accent;
  if (p.fontSize === "md") root.style.removeProperty("font-size");
  else root.style.fontSize = FONT_SIZE_PX[p.fontSize];
  if (p.chatWidth === "md") delete root.dataset.chatWidth;
  else root.dataset.chatWidth = p.chatWidth;
  if (p.fontFamily === "default") delete root.dataset.font;
  else root.dataset.font = p.fontFamily;
}

/** 从 localStorage 恢复并应用，注册系统主题监听；模块加载即执行 */
export function initUiPrefs(): void {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (raw) prefs = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    // 数据损坏时回落默认值
  }
  applyPrefs(prefs);
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (prefs.theme === "system") applyPrefs(prefs);
    });
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUiPrefs(): UiPrefs {
  return prefs;
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(
    subscribe,
    getUiPrefs,
    () => DEFAULT_PREFS,
  );
}

export function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) {
  prefs = { ...prefs, [key]: value };
  applyPrefs(prefs);
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用时仅本次会话生效
  }
  emit();
}

void initUiPrefs();
