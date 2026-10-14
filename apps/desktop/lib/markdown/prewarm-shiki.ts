import { code } from "@streamdown/code";
import type { HighlightOptions } from "@streamdown/code";

// Shiki 按「语言 + 主题对」惰性创建 highlighter 并在模块级缓存，流式输出中
// 某语言第一个代码围栏闭合时才触发 grammar 解析，会卡出一帧。用空代码在空闲
// 时逐个预建热点语言的缓存，真正的流式高亮即可同步命中。
const HOT_LANGS: HighlightOptions["language"][] = [
  "typescript",
  "tsx",
  "javascript",
  "json",
  "bash",
  "python",
  "html",
  "css",
  "markdown",
  "yaml",
];

let started = false;

export function prewarmShiki(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // 与 code 插件实际使用的主题保持一致，缓存 key 才会命中
  const themes = code.getThemes();
  let index = 0;

  const schedule = (task: () => void) => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(task, { timeout: 5000 });
    } else {
      setTimeout(task, 1500);
    }
  };

  const next = () => {
    if (index >= HOT_LANGS.length) return;
    const language = HOT_LANGS[index++]!;
    // 返回 null 表示尚未就绪；回调里加载完成后继续下一个，避免一次性占满空闲帧
    code.highlight({ code: "", language, themes }, () => schedule(next));
  };

  schedule(next);
}
