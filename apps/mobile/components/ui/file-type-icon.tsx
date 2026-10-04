import { useMemo } from "react";
import { SvgXml } from "react-native-svg";
import { FILE_ICON_FALLBACK, FILE_ICON_SVG } from "./file-icons.generated";

/**
 * 文件类型图标（VS Code 同款 Material Icon Theme，与桌面端
 * components/agent-thread/agent-panel/file-type-icon.tsx 同一份数据源）：
 * 桌面端整包用 material-file-icons（约 1.5MB），移动端把常用项固化成
 * file-icons.generated.ts 的本地表，SvgXml 渲染内联 SVG 字符串。
 *
 * 查表口径同 material-file-icons：先按完整文件名（Dockerfile/.gitignore/
 * package.json…），再按小写扩展名，都没有回退默认文档图标。
 */
/**
 * 图标 SVG 自带 `style="width:100%;height:100%"`（桌面端靠容器尺寸控制图标大小），
 * SvgXml 见到根标签上的 width/height/style 就不再吃组件的 width/height 属性——
 * 不剥掉的话图标会撑满整行。这里在模块加载时统一剥一遍，尺寸交回组件。
 */
const stripSizeAttrs = (svg: string): string =>
  svg.replace(/<svg([^>]*)>/, (_m, attrs: string) =>
    `<svg${attrs.replace(/\s(?:style|width|height)="[^"]*"/g, "")}>`,
  );

const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(FILE_ICON_SVG).map(([key, svg]) => [key, stripSizeAttrs(svg)]),
);
const FALLBACK = stripSizeAttrs(FILE_ICON_FALLBACK);

export function fileIconSvg(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const exact = ICONS[base];
  if (exact) return exact;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && dot < base.length - 1) {
    const ext = base.slice(dot + 1).toLowerCase();
    const byExt = ICONS[ext];
    if (byExt) return byExt;
  }
  return FALLBACK;
}

export function FileTypeIcon({
  path,
  size = 16,
}: {
  path: string;
  /** 边长（正方形）；默认与文字行高同档 */
  size?: number;
}) {
  const svg = useMemo(() => fileIconSvg(path), [path]);
  return <SvgXml xml={svg} width={size} height={size} />;
}
