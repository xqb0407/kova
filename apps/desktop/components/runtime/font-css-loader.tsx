"use client";

import { useEffect } from "react";
import { getUiPrefs, subscribeUiPrefs } from "@/lib/settings/ui-prefs";
import { resolveFonts } from "@/lib/theme/palette";
import fontAssets from "@/lib/theme/font-assets.json";

type FontManifest = Record<
  string,
  { package: string; weights?: string[]; css?: string[] }
>;

const manifest = fontAssets as FontManifest;
/** UI/代码字体档位名 → 打包字体目录名（两者共用同一套 @fontsource 资源） */
const FAMILY_ALIAS: Record<string, string> = {
  jetbrains: "jetbrains-mono",
};

/** 这些档位自带中文字体（或显式选择系统 CJK），不需要预注入思源黑体。
 *  代码字体栈只用系统 CJK，不会反向要求思源黑体。 */
const NO_DEFAULT_NOTO = new Set([
  "yahei",
  "kai",
  "wenkai",
  "serif",
  "noto-sans-sc",
  "noto-serif-sc",
]);

const loaded = new Set<string>();

/** 清单条目 → 需要注入的 CSS 文件（weight 约定或显式 css 列表，如霞鹜文楷） */
function cssFilesFor(entry: { weights?: string[]; css?: string[] }): string[] {
  if (entry.css && entry.css.length > 0) return entry.css;
  return (entry.weights ?? []).map((weight) => `${weight}.css`);
}

function ensureFamily(family: string | undefined): void {
  if (!family) return;
  const key = FAMILY_ALIAS[family] ?? family;
  const entry = manifest[key];
  if (!entry) return; // 系统字体档（Segoe/雅黑/楷体等）不需要打包 CSS
  for (const cssFile of cssFilesFor(entry)) {
    const href = `/fonts/${key}/${cssFile}`;
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

  // Windows/Linux 的默认中文回退是随包思源黑体（mac 优先苹方，不加载）。
  // 预先注入是必须的：默认档走 :root 栈，不会经过 ensureFamily(fonts.ui)。
  // 显式系统/自带 CJK 的档位跳过，避免白解析 4×105KB 的 font-face CSS。
  if (
    /Windows NT|Linux/i.test(navigator.userAgent) &&
    !NO_DEFAULT_NOTO.has(fonts.ui)
  ) {
    ensureFamily("noto-sans-sc");
  }
  // 「衬线」档在 Windows 落思源宋体（SimSun 只作最后兜底）
  if (/Windows NT/i.test(navigator.userAgent) && fonts.ui === "serif") {
    ensureFamily("noto-serif-sc");
  }
}

/**
 * 非默认字体 CSS 的按需注入器。
 *
 * 首屏只加载 Geist（layout.tsx）；用户在外观设置里切到 Inter/Roboto/Noto/
 * 思源宋体/霞鹜文楷/JetBrains 时，这里按需挂 <link>，避免把几百 KB 的
 * font-face CSS 和所有字体文件压在首屏。Windows/Linux 额外预注入思源黑体，
 * 作为默认栈的中文回退。无 DOM 输出，SSR/水合无差异。
 */
export function FontCssLoader() {
  useEffect(() => {
    sync();
    return subscribeUiPrefs(sync);
  }, []);
  return null;
}
