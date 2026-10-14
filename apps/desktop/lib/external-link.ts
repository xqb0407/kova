"use client";

import { safeDesktopCall } from "@/lib/desktop-env";

/**
 * 用系统默认浏览器打开外链：桌面壳 webview 里 target=_blank 无人处理
 * （点了没反应），必须走 Rust `open_external` 命令（原 Rust 宿主的 about.rs：
 * open / cmd start / xdg-open）；纯浏览器环境降级 window.open。
 * 与设置页「意见反馈」同款通道。
 */
export function openExternal(url: string): void {
  void safeDesktopCall(
    async () => {
      const { invoke } = await import("@/desktop-bridge/core");
      await invoke("open_external", { url });
    },
    async () => {
      window.open(url, "_blank", "noopener");
    },
  );
}
