"use client";

import { useCallback, type ReactNode } from "react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import { toFileUrl } from "@/lib/panels/artifacts";

/** 可用浏览器标签预览（file:// 喂原生 webview）的扩展名 */
const PREVIEW_RE = /\.(html?|svg)$/i;

/**
 * 文件树右键菜单的「浏览器预览」前置项：html/svg 时点开 browser 标签，
 * file:// URL 走内置浏览器（browser.rs 放行 file 协议）。
 * 「文件树」标签与文件预览右栏（FileRail）共用，避免两份实现漂移；
 * 根目录未就绪或非可预览扩展名返回 null（菜单不出现该项）。
 */
export function useFilePreviewMenuPrefix(
  rootCwd: string | null,
): (rel: string, name: string) => ReactNode | null {
  return useCallback(
    (rel: string, name: string): ReactNode | null => {
      if (!rootCwd || !PREVIEW_RE.test(name)) return null;
      return (
        <ContextMenuItem
          // 与 FileExplorer 的菜单项同版式（无图标、36px 行、px-3）
          className="justify-between gap-6 rounded-md px-3 py-2 focus:bg-accent"
          onClick={() =>
            openPanelTab("browser", {
              cwd: rootCwd,
              url: toFileUrl(rootCwd, rel),
              title: name,
            })
          }
        >
          浏览器预览
        </ContextMenuItem>
      );
    },
    [rootCwd],
  );
}
