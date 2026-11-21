"use client";

import { useState, type FC, type ReactElement, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isDesktop, isMacPlatform, isWindowsPlatform } from "@/lib/desktop-env";
import { fsErrorText, projectReveal } from "@/lib/workspace/fs";
/**
 * 菜单行外壳：对齐会话「…」菜单的 MoreItemShell——系统菜单式排版
 * （不带行内图标、行更高、justify-between 给右侧留位），hover/focus/禁用
 * 与 destructive 变体共用同一套 token。
 */
const MenuItemRow: FC<{
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
}> = ({ label, onSelect, destructive, disabled, trailing }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onSelect}
    className={cn(
      destructive
        ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10"
        : "hover:bg-accent focus:bg-accent",
      "flex w-full cursor-pointer items-center justify-between gap-6 rounded-md px-3 py-2 text-sm outline-none select-none disabled:cursor-not-allowed disabled:opacity-50",
    )}
  >
    <span className="min-w-0 truncate">{label}</span>
    {trailing}
  </button>
);

/** 「在文件管理器中显示」按平台叫法：macOS = Finder，Windows = 资源管理器 */
function revealLabel(): string {
  if (isMacPlatform()) return "在 Finder 中显示";
  if (isWindowsPlatform()) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

/**
 * 项目操作菜单（紧贴项目行的 Popover），形态对齐会话行的 ⋯ 菜单：
 * 纯菜单项（置顶项目 / 编辑项目 / Finder / 复制路径 / 归档 / 从侧栏移除）。
 * 文件夹管理全部收进「编辑项目…」的 WorkspaceCreateDialog，菜单不再
 * 维护第二套目录入口。
 */
export const ProjectSettingsPopover: FC<{
  cwd: string;
  label: string;
  /** ⋯ 触发按钮：base-ui 会把开合语义合并进这个元素 */
  children: ReactElement;
  /** 项目当前是否置顶（置顶项目卡里显示「取消置顶项目」） */
  pinned?: boolean;
  /** 置顶 / 取消置顶项目（无项目实体时不给这个入口） */
  onTogglePin?: () => void;
  /** 打开「编辑项目」弹窗（名称/目录/图标/颜色） */
  onEdit?: () => void;
  /** 仅从侧栏隐藏项目卡（不归档、不解绑会话） */
  onRemove?: () => void;
  /** 归档项目（含会话）。远程 cwd 分组没有项目实体，不给这个入口 */
  onArchive?: () => void;
}> = ({
  cwd,
  label,
  children,
  pinned = false,
  onTogglePin,
  onEdit,
  onRemove,
  onArchive,
}) => {
  const [open, setOpen] = useState(false);
  const desktop = isDesktop();

  /** 在系统文件管理器中定位项目目录（macOS=Finder / Windows=资源管理器）。
   *  项目目录未必是当前 workspace，因此走 project_reveal 而不是 fs_reveal */
  const revealProject = async () => {
    setOpen(false);
    const err = await projectReveal(cwd);
    if (err) toast.error(fsErrorText(err));
  };

  const copyProjectPath = async () => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(cwd);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={children} />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        // base-ui Popover 打开时默认把焦点移到第一个可聚焦元素（=「置顶项目」
        // 那个 button），配合 MenuItemRow 的 focus:bg-accent，看起来就像默认
        // 选中了第一项。菜单类浮层不需要预置焦点，交给 hover/Tab 即可
        initialFocus={false}
        // gap-1 覆盖 PopoverContent 基类的 gap-2.5：菜单行间距对齐会话 ⋯ 菜单
        //（否则行间出现 10px 空隙，分隔线两侧尤其实际上像断开的两组）
        className="min-w-56 gap-1 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
        aria-label={`${label} 项目操作`}
      >
        {onTogglePin ? (
          <MenuItemRow
            label={pinned ? "取消置顶项目" : "置顶项目"}
            onSelect={() => {
              setOpen(false);
              onTogglePin();
            }}
          />
        ) : null}
        {onEdit ? (
          <MenuItemRow
            label="编辑项目…"
            onSelect={() => {
              setOpen(false);
              onEdit();
            }}
          />
        ) : null}

        {/* 文件管理 / 复制：只在桌面壳出现 */}
        {desktop ? (
          <>
            <MenuItemRow
              label={revealLabel()}
              onSelect={() => void revealProject()}
            />
            <MenuItemRow
              label="复制路径"
              onSelect={() => void copyProjectPath()}
            />
          </>
        ) : null}

        {/* 分隔线与会话「…」菜单同款：-mx-1 铺满卡片内宽（容器已有 p-1） */}
        {onArchive ? (
          <>
            <div className="bg-border/70 -mx-1 h-px" />
            {/* 归档：破坏性动作单独分隔收在菜单最末，红色文字与普通行区分 */}
            <MenuItemRow
              label="归档项目"
              destructive
              onSelect={() => {
                setOpen(false);
                onArchive();
              }}
            />
          </>
        ) : null}
        {/* 移除：只隐藏侧栏卡片，不归档、不解绑会话（设置页可恢复显示） */}
        {onRemove ? (
          <MenuItemRow
            label="从侧栏移除"
            onSelect={() => {
              setOpen(false);
              onRemove();
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
