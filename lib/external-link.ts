"use client";

import { safeTauriCall } from "@/lib/tauri";

/**
 * 用系统默认浏览器打开外链：Tauri webview 里 target=_blank 无人处理
 * （点了没反应），必须走 Rust `open_external` 命令（src-tauri/src/about.rs：
 * open / cmd start / xdg-open）；纯浏览器环境降级 window.open。
 * 与设置页「意见反馈」同款通道。
 */
export function openExternal(url: string): void {
  void safeTauriCall(
    async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external", { url });
    },
    async () => {
      window.open(url, "_blank", "noopener");
    },
  );
}
