"use client";

/**
 * i18n 核心：界面语言（中/英）的解析、订阅与翻译函数。
 *
 * 与外观偏好同一套模式（lib/settings/ui-prefs.ts）：locale 偏好存在 ui.prefs
 * 里（"system" | "zh" | "en"，默认跟随系统语言），本模块订阅 ui-prefs 的
 * 变化把偏好解析成当前语言（current），持久化/跨窗口 storage 同步/防抖落盘
 * 全部复用 ui-prefs 现有链路，这里不碰 localStorage。
 *
 * 消费方式：
 *  - React 组件：`const t = useT()`——locale 变化触发重渲染，t 引用按 locale
 *    记忆化（同一 locale 恒定同一函数，可安全进依赖数组）。
 *  - 非 React 模块（toast/错误拼接等）：直接 `import { t }`——调用时取当前
 *    语言，字符串在调用点生成，切换语言后新生成的文案就是新语言。
 *  - 模块级常量**不要**在模块求值期调 t()：那会把语言烧死在求值时刻。常量只
 *    存 key，渲染/调用时再翻译。
 *
 * SSR：服务端 navigator 不存在，locale 恒为 zh（词典事实源语言）；客户端
 * bundle 求值时 initI18n() 同步读偏好，首个 client render 前就绪——与主题
 * 同策略，不闪旧语言。documentElement.lang 也在这里与预绘制脚本（layout.tsx
 * UI_PREFS_BOOTSTRAP）双保险地维护。
 */
import { useSyncExternalStore } from "react";
import { getUiPrefs, setUiPref, subscribeUiPrefs } from "@/lib/settings/ui-prefs";
import type { LocalePref } from "@/lib/settings/ui-prefs";
import { zh, type Dictionary } from "./locales/zh";
import { en } from "./locales/en";

export type Locale = "zh" | "en";
export type { LocalePref };

/** 翻译参数：插值占位 `{name}` 的取值 */
export type TParams = Record<string, string | number>;
export type TFunc = (key: string, params?: TParams) => string;

let current: Locale = "zh";
const listeners = new Set<() => void>();
let initialized = false;

/** 系统语言：navigator.languages 逐个看，zh 开头 → 中文，否则英文；
 *  运行环境没给任何语言标签（非浏览器/测试桩）时回中文事实源 */
export function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "zh";
  const candidates =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  let sawTag = false;
  for (const tag of candidates) {
    const lower = (tag ?? "").toLowerCase();
    if (!lower) continue;
    sawTag = true;
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return sawTag ? "en" : "zh";
}

function resolve(pref: LocalePref): Locale {
  return pref === "zh" || pref === "en" ? pref : systemLocale();
}

function applyLang(locale: Locale): void {
  if (typeof document === "undefined") return;
  const lang = locale === "zh" ? "zh-CN" : "en";
  if (document.documentElement.lang !== lang) {
    document.documentElement.lang = lang;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** ui-prefs 的任意变化都进来对一下：locale 字段真变了才广播 */
function syncFromPrefs(): void {
  const next = resolve(getUiPrefs().locale);
  if (next === current) return;
  current = next;
  applyLang(next);
  emit();
}

/** 从 ui-prefs 读初始语言并订阅后续变化；模块加载即执行（见文件头 SSR 注释） */
export function initI18n(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  current = resolve(getUiPrefs().locale);
  applyLang(current);
  subscribeUiPrefs(syncFromPrefs);
}
void initI18n();

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    name in params ? String(params[name]) : raw,
  );
}

/** 当前语言的 t()：非 React 模块用。缺 key 回落中文，再缺回落 key 本身 */
export function t(key: string, params?: TParams): string {
  const raw =
    lookup(current === "en" ? en : zh, key) ??
    lookup(zh, key) ??
    key;
  return interpolate(raw, params);
}

/** 指定语言的 t()：引用按 locale 记忆化，useT 的稳定返回靠它 */
const tByLocale = new Map<Locale, TFunc>();
function tFor(locale: Locale): TFunc {
  let fn = tByLocale.get(locale);
  if (!fn) {
    fn = (key, params) => {
      const raw =
        lookup(locale === "en" ? en : zh, key) ??
        lookup(zh, key) ??
        key;
      return interpolate(raw, params);
    };
    tByLocale.set(locale, fn);
  }
  return fn;
}

/** 按显式 locale 取词：纯函数（欢迎语/日期格式化等带 locale 参数的工具用），
 *  与组件订阅无关——调用方负责把 locale 传进来。 */
export function translateWith(
  locale: Locale,
  key: string,
  params?: TParams,
): string {
  return tFor(locale)(key, params);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocale(): Locale {
  return current;
}

/** 当前语言（SSR 快照恒 zh，与 t() 的服务端行为一致） */
export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    getLocale,
    () => "zh" as Locale,
  );
}

/** 组件用翻译函数：locale 变化触发重渲染，函数引用同 locale 下稳定 */
export function useT(): TFunc {
  return tFor(useLocale());
}

/** 切语言（写 ui.prefs.locale）：传 "system" 回到跟随系统 */
export function setLocalePref(pref: LocalePref): void {
  setUiPref("locale", pref);
}
