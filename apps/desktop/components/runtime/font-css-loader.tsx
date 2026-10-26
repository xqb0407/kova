"use client";

import { useEffect } from "react";
import { getUiPrefs, subscribeUiPrefs } from "@/lib/settings/ui-prefs";
import { resolveFonts } from "@/lib/theme/palette";
import fontAssets from "@/lib/theme/font-assets.json";

type FontManifest = Record<string, { package: string; weights: string[] }>;

const manifest = fontAssets as FontManifest;
/** UI/代码字体档位名 → 打包字体目录名（两者共用同一套 @fontsource 资源） */
const FAMILY_ALIAS: Record<string, string> = {
  jetbrains: "jetbrains-mono",
};

const loaded = new Set<string>();

function ensureFamily(family: string | undefined): void {
  if (!family) return;
  const key = FAMILY_ALIAS[family] ?? family;
  const entry = manifest[key];
  if (!entry) return; // 系统字体档（Segoe/雅黑/楷体等）不需要打包 CSS
  for (const weight of entry.weights) {
    const href = `/fonts/${key}/${weight}.css`;
    if (loaded.has(href)) continue;
    loaded.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.kovaFont = key;
    document.head.appendChild(link);
  }
}

function sync(): void {
  const fonts = resolveFonts(getUiPrefs());
  ensureFamily(fonts.ui);
  ensureFamily(fonts.code);
  // Linux 默认 UI 栈用系统中文优先；没有系统 CJK 时由打包的思源黑体兜底。
  if (/Linux/i.test(navigator.userAgent)) ensureFamily("noto-sans-sc");
}

/**
 * 非默认字体 CSS 的按需注入器。
 *
 * 首屏只加载 Geist（layout.tsx）；用户在外观设置里切到 Inter/Roboto/Noto/
 * 思源宋体/JetBrains 时，这里按需挂 <link>，避免把 300KB 的 font-face CSS
 * 和所有字体文件压在首屏。无 DOM 输出，SSR/水合无差异。
 */
export function FontCssLoader() {
  useEffect(() => {
    sync();
    return subscribeUiPrefs(sync);
  }, []);
  return null;
}
