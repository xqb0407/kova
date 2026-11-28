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
  // 原生笔记没有 Material 图标：「浅色内页 + 实色书脊」的笔记图形。两层 fill
  // 都走 currentColor（内页压 30% 实度当浅色内页），外层 text-primary 跟主题色，
  // 深浅主题自动适配——不用 lucide 描边图标是因为这枚是填色形状，16px 下更稳
  if (/\.knote$/iu.test(path)) {
    return (
      <span
        aria-hidden
        className={cn("inline-block size-4 shrink-0 text-primary", className)}
      >
        <svg viewBox="0 0 1024 1024" className="size-full">
          <path
            d="M243.2 64.8704h537.6a102.4 102.4 0 0 1 102.4 102.4v716.8a102.4 102.4 0 0 1-102.4 102.4H243.2a102.4 102.4 0 0 1-102.4-102.4v-716.8a102.4 102.4 0 0 1 102.4-102.4z"
            fill="currentColor"
            fillOpacity={0.3}
          />
          <path
            d="M243.2 64.8704h113.408v921.6H294.4a153.6 153.6 0 0 1-153.6-153.6v-665.6a102.4 102.4 0 0 1 102.4-102.4z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 shrink-0 [&>svg]:size-full", className)}
      // eslint-disable-next-line react/no-danger -- 图标字符串来自本地打包的静态数据集，非用户输入
      dangerouslySetInnerHTML={{ __html: iconSvg(baseOf(path)) }}
    />
  );
});
