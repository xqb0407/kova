"use client";

import { useCallback, type FC } from "react";
import {
  activatePanelTab,
  getPanelTabs,
  openPanelTab,
} from "@/lib/panels/panel-tabs";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { FileExplorer, type ExplorerFileRef } from "@/components/files/file-explorer";

/**
 * 「文件」标签（explorer）：当前工作目录的文件树浏览。
 * 根 = usePanelCwd 三级解析：选了工作区就是工作区；没选（全局会话）落到
 * 该会话按隔离的任务目录 <task-workspace>/<sessionId>，与 agent 实际读写
 * 同源（Rust resolve_root 已放行任务工作区子树，fs_* 读写命令直接可用）。
 * 树本体与右键菜单/对话框在 components/files/FileExplorer（与资料库页共用）；
 * 本文件只提供面板侧的两处差别：点文件开面板标签、HTML/SVG 的浏览器预览。
 * 仅 桌面端出现（tab-registry 可见性过滤），web 端不渲染。
 */

/** 可用浏览器预览（browser 标签 file:// 加载）的扩展名 */
const PREVIEW_RE = /\.(html?|svg)$/i;

/**
 * rootCwd + 相对路径 → file:/// URL（浏览器标签预览本地 HTML/SVG）。
 * 逐段 encodeURIComponent，盘符冒号（"D:"）保留。
 */
function toFileUrl(cwd: string, rel: string): string {
  const segs = (p: string) =>
    p
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((s) => encodeURIComponent(s).replace(/%3A/g, ":"));
  return `file:///${[...segs(cwd), ...segs(rel)].join("/")}`;
}

export const FileTreeTab: FC = () => {
  const rootCwd = usePanelCwd();

  /** 打开文件标签：同 (cwd, path) 已有标签则聚焦，否则新开——不同文件并存
   *  多标签（此前走 focusPanelTab 按类型复用第一个，每次打开都覆盖同一个） */
  const openFile = useCallback(
    (file: ExplorerFileRef) => {
      if (!rootCwd) return;
      const existing = getPanelTabs().tabs.find(
        (t) => t.type === "file" && t.cwd === file.cwd && t.path === file.rel,
      );
      if (existing) {
        activatePanelTab(existing.id);
        return;
      }
      openPanelTab("file", {
        cwd: file.cwd,
        path: file.rel,
        title: file.name,
        focus: undefined,
      });
    },
    [rootCwd],
  );

  /** 浏览器标签预览：file:// URL 走原生子 webview（browser.rs 放行 file 协议） */
  const fileMenuPrefix = useCallback(
    (rel: string, name: string) => {
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

  return (
    <FileExplorer
      rootCwd={rootCwd}
      onOpenFile={openFile}
      fileMenuPrefix={fileMenuPrefix}
      stateKey="panel"
      ariaLabel="工作区文件"
      pendingText="正在准备任务目录…"
    />
  );
};