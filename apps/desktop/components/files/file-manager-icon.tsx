"use client";

/**
 * 「在系统中打开 / 显示」类动作的图标，按平台给系统文件管理器的样子：
 * - macOS：访达（public/icons/finder.png）
 * - Windows：资源管理器（public/icons/explorer.png）
 * - 其余平台：通用文件夹搜索图标
 *
 * 两份都是仓库内的静态资产，前端直接 `<img>` 引用——**不要在运行时问系统要
 * 图标**：主进程的 `app.getFileIcon` 走 macOS 图标服务，实测在该环境触发
 * 原生断言、崩主进程（2026-10-19 的 Crashpad 转储）。静态资产没有原生调用。
 *
 * 菜单项只给 svg 定尺寸（[&_svg]:size-4），所以 img 必须自带 size-* 类。
 *
 * 平台检测读 navigator.userAgent：SSR/静态预渲染阶段没有 navigator，直接
 * 分支会渲染出与客户端不同的 <img> → hydration mismatch（dev-preview 页
 * 首屏报错就是它）。用 useSyncExternalStore 的服务端快照（恒为通用图标）
 * 让水合结果确定一致，水合完成后再切到真实平台的图标。
 */

import { useSyncExternalStore, type FC } from "react";
import { FolderSearchIcon } from "lucide-react";
import { isMacPlatform, isWindowsPlatform } from "@/lib/desktop-env";

const subscribeNoop = () => () => {};

export const FileManagerIcon: FC<{ className?: string }> = ({ className }) => {
  const isMac = useSyncExternalStore(subscribeNoop, isMacPlatform, () => false);
  const isWin = useSyncExternalStore(
    subscribeNoop,
    isWindowsPlatform,
    () => false,
  );
  if (isMac) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/icons/finder.png"
        alt=""
        draggable={false}
        className={className}
      />
    );
  }
  if (isWin) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/icons/explorer.png"
        alt=""
        draggable={false}
        className={className}
      />
    );
  }
  return <FolderSearchIcon className={className} />;
};
