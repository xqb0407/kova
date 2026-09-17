"use client";

import { useEffect, useState, type FC } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { isMacPlatform, isTauri } from "@/lib/tauri";

/**
 * 自绘窗口控制按钮（最小化/最大化/关闭），Windows 风格。
 *
 * 仅在「桌面端且非 macOS」时渲染（Windows/Linux 由 tauri.windows.conf.json 关闭系统
 * 标题栏 decorations:false）；macOS 使用系统红绿灯，网页端无窗口 chrome。
 * 按钮内部自行判定环境，父组件可直接渲染，无需条件包裹。
 */
export const WindowControls: FC = () => {
  const enabled = isTauri() && !isMacPlatform();
  const [maximized, setMaximized] = useState(false);

  // 跟随窗口尺寸变化同步最大化状态（最大化/还原均有 resize 事件）
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then((v) => {
      if (!disposed) setMaximized(v);
    });
    void win
      .onResized(async () => {
        try {
          const v = await win.isMaximized();
          if (!disposed) setMaximized(v);
        } catch {
          // 窗口关闭过程中查询可能失败，忽略
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  const win = getCurrentWindow();
  const btn =
    "flex h-full w-11 shrink-0 items-center justify-center text-foreground/80 transition-colors";
  return (
    <div className="flex h-12 shrink-0 items-center">
      <button
        type="button"
        aria-label="最小化"
        className={`${btn} hover:bg-foreground/10`}
        onClick={() => void win.minimize()}
      >
        <MinusIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "还原" : "最大化"}
        className={`${btn} hover:bg-foreground/10`}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? (
          <CopyIcon className="size-3.5" />
        ) : (
          <SquareIcon className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label="关闭"
        className={`${btn} hover:bg-red-600 hover:text-white`}
        onClick={() => void win.close()}
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
};
