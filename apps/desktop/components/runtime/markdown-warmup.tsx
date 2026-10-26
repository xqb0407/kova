"use client";

import { useEffect } from "react";

/**
 * Markdown/Shiki 的空闲预热。
 *
 * 首屏仍不加载 Shiki/Mermaid/KaTeX（layout 只保留 MarkdownText 核心），但
 * 把重插件 chunk 和 Shiki 热点语言预热提前到应用壳落定后的 idle —— 用户第一次
 * 切到含代码的会话时不再同时付 chunk 加载 + 高亮初始化的钱。
 *
 * 只是提前，不改变任何渲染语义；预取失败保持纯文本代码块。
 */
export function MarkdownWarmup() {
  useEffect(() => {
    const warm = () => {
      void import("@/components/assistant-ui/elements/markdown-text")
        .then((m) => m.prewarmMarkdownPlugins())
        .catch(() => {});
      void import("@/lib/markdown/prewarm-shiki")
        .then((m) => m.prewarmShiki())
        .catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(id);
  }, []);
  return null;
}
