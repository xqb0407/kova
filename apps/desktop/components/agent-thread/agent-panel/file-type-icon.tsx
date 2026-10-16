"use client";

import { memo } from "react";
import { getIcon } from "material-file-icons";
import { cn } from "@/lib/utils";

/**
 * VS Code 同款彩色文件图标：material-file-icons 打包了 Material Icon Theme
 * 的完整图标集（getIcon 原生解析 ".gitignore"/"Dockerfile"/扩展名，未知类型
 * 自动回退默认文档图标），返回内联 SVG 字符串直接注入。
 * 返回的 svg 自带 width/height:100%，容器尺寸即图标尺寸。git 状态由
 * StatusDot（左缘彩点）表达，见 git-files。
 * 性能：树行多且会整树重渲染，这里 memo 住组件（path/className 不变即
 * 跳过渲染），SVG 字符串按图标名去重缓存——getIcon 每次调用可能生成新
 * 字符串，缓存后同图标共享同一引用，React 比对 __html 引用相等直接跳过
 * DOM 更新；图标名数量以图标集为界，缓存有界。
 */

const baseOf = (path: string) => {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
};

const svgByName = new Map<string, string>();
function iconSvg(name: string): string {
  const hit = getIcon(name);
  let svg = svgByName.get(hit.name);
  if (!svg) {
    svg = hit.svg;
    svgByName.set(hit.name, svg);
  }
  return svg;
}

export const FileTypeIcon = memo(function FileTypeIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 shrink-0 [&>svg]:size-full", className)}
      // eslint-disable-next-line react/no-danger -- 图标字符串来自本地打包的静态数据集，非用户输入
      dangerouslySetInnerHTML={{ __html: iconSvg(baseOf(path)) }}
    />
  );
});
