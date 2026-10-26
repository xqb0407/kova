"use client";

import { useEffect } from "react";

/**
 * Markdown/Shiki 的空闲预热。
 *
 * 时机很重要：根 layout 的 effect 在水合后就会跑；如果直接 requestIdleCallback，
 * 会赶在开屏/恢复会话的消息绘制之前加载 Shiki/Mermaid 并创建高亮器，反而抢占
 * 启动 LCP（实测 app-shell 806ms 后 150ms 就出现 Shiki 10 instances）。
 *
 * 现在的顺序：
 * 1. 等 BootSplash 摘掉（应用壳已提交）；
 * 2. 再等 1.5s，让恢复会话的首条消息先绘制；
 * 3. 最后才 idle 预取插件 chunk。
 *
 * 这里只预取 chunk（prewarmMarkdownPlugins），不调 prewarmShiki——Shiki 高亮器
 * 的预热由 Thread 挂载后的空闲 effect 负责，避免两处重复创建实例。
 */
export function MarkdownWarmup() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;

    const warm = () => {
      if (cancelled) return;
      void import("@/components/assistant-ui/elements/markdown-text")
        .then((m) => m.prewarmMarkdownPlugins())
        .catch(() => {});
    };

    const start = () => {
      if (cancelled) return;
      if (document.documentElement.hasAttribute("data-boot-splash")) {
        timer = setTimeout(start, 250);
        return;
      }
      timer = setTimeout(() => {
        if (cancelled) return;
        if (typeof window.requestIdleCallback === "function") {
          idleId = window.requestIdleCallback(warm, { timeout: 5000 });
        } else {
          warm();
        }
      }, 1500);
    };
    start();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
    };
  }, []);
  return null;
}
