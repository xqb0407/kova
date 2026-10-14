"use client";

import { type FC } from "react";
import { getIcon } from "material-file-icons";
import { cn } from "@/lib/utils";

/**
 * VS Code 同款彩色文件图标：material-file-icons 打包了 Material Icon Theme
 * 的完整图标集（getIcon 原生解析 ".gitignore"/"Dockerfile"/扩展名，未知类型
 * 自动回退默认文档图标），返回内联 SVG 字符串直接注入。
 * 返回的 svg 自带 width/height:100%，容器尺寸即图标尺寸；不做缓存，
 * getIcon 是纯查表。git 状态由 StatusDot（左缘彩点）表达，见 git-files。
 */

const baseOf = (path: string) => {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
};

export const FileTypeIcon: FC<{ path: string; className?: string }> = ({
  path,
  className,
}) => (
  <span
    aria-hidden
    className={cn("inline-block size-4 shrink-0 [&>svg]:size-full", className)}
    // eslint-disable-next-line react/no-danger -- 图标字符串来自本地打包的静态数据集，非用户输入
    dangerouslySetInnerHTML={{ __html: getIcon(baseOf(path)).svg }}
  />
);
