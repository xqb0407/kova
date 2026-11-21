"use client";

/**
 * 资料库查看器右键菜单：选中文本 → 复制。
 *
 * md 预览/编辑器是宿主 DOM，选区直接读 window.getSelection()；
 * HTML 预览是跨源 sandbox iframe，宿主读不到内部选区，由注入脚本把落点
 * 与选中文本 postMessage 上来（见 apps/electron/main/preview-inject.ts），
 * 父侧负责弹菜单并写剪贴板——子文档是不透明源，本身没有剪贴板权限。
 *
 * 菜单只为「复制」存在：Electron 没有系统默认右键菜单，查看器里选中一段
 * 文字后右键没有任何入口，这是补的那一块。
 */

import { useCallback, type FC } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { copyText } from "@/lib/remote";

/** 菜单落点（宿主视口坐标）与当前选区文本（iframe 后端由子文档上报） */
export type ViewerMenuState = {
  x: number;
  y: number;
  selection: string;
};

export const FileViewerContextMenu: FC<{
  menu: ViewerMenuState | null;
  onClose: () => void;
}> = ({ menu, onClose }) => {
  const t = useT();
  /** 原样拷贝（与浏览器一致）：trim 只用于「是否可复制」判定，
   *  真正进剪贴板的保留首尾空白/缩进 */
  const selection = menu?.selection ?? "";
  const hasSelection = selection.trim().length > 0;

  const copy = useCallback(() => {
    if (!selection.trim()) return;
    void copyText(selection).then((ok) => {
      if (!ok) toast.error(t("library.viewer.copyFailed"));
    });
    onClose();
  }, [selection, onClose, t]);

  return (
    <ContextMenu
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {menu && (
        <ContextMenuContent
          // 虚拟锚点：菜单落在鼠标右键的位置（与 thread-list 右键同款模式）
          anchor={{
            getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0),
          }}
          className="min-w-44"
        >
          <ContextMenuItem
            disabled={!hasSelection}
            onClick={copy}
            // 与文件树/会话列表右键同版式：36px 行、px-3、无行内图标
            className="focus:bg-accent justify-between gap-6 rounded-md px-3 py-2"
          >
            <span className="min-w-0 truncate">{t("library.viewer.copy")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
};
