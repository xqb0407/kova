/**
 * DiceBear 图标选择（Bootstrap Icons 集，MIT）：笔记页面图标等场景的
 * 确定性图标源。`@dicebear/styles` 的 icons 风格本身没有「锁定某个图标」的
 * 选项（变体默认按 seed 随机），但 core 选变体时读 `${组件名}Variant` 选项
 * （Options.componentVariant），所以直接传 `iconVariant: 图标名` 即可精确锁定。
 *
 * 值格式统一为 `dicebear:icons:<图标名>`：纯字符串，直接存进 frontmatter.icon
 * 或 .knote envelope.icon（无空格，YAML 不需要转义），旧数据里的 emoji 值
 * parse 不中就走原有文本渲染，互不影响。
 *
 * 渲染走内联 SVG 而不是 <img>：去掉背景瓷砖（<rect> 底色块）、字形 fill 换成
 * currentColor——内联 SVG 才能继承页面文字色，深浅主题自动适配（<img> 里的
 * SVG 是隔离文档，currentColor 拿不到外层样式）。
 */

import { Avatar, Style, type StyleDefinition } from "@dicebear/core";
import iconsDefinition from "@dicebear/styles/icons.json";
import { isProjectAvatarId } from "@/lib/projects/project-avatars";

const VALUE_PREFIX = "dicebear:icons:";

/** icons 风格的全部图标名（JSON variants 键序 = Bootstrap Icons 的语义排序） */
export const DICEBEAR_ICON_NAMES: readonly string[] = Object.keys(
  (
    iconsDefinition as {
      components: { icon: { variants: Record<string, unknown> } };
    }
  ).components.icon.variants,
);

const ICON_NAME_SET = new Set(DICEBEAR_ICON_NAMES);

/** 解析 `dicebear:icons:<名字>`；前缀不符或名字未知（含 emoji 值）返回 null */
export function parseDicebearIcon(
  value: string | null | undefined,
): string | null {
  if (!value?.startsWith(VALUE_PREFIX)) return null;
  const name = value.slice(VALUE_PREFIX.length);
  return ICON_NAME_SET.has(name) ? name : null;
}

/** 笔记页面图标值的两种形态 */
export type NoteIconValue =
  | { kind: "glyph"; name: string }
  | { kind: "avatar"; id: string };

/**
 * 解析任一受支持的图标值：emoji / 未知 → null。
 * - `dicebear:icons:<名字>`：Bootstrap 线条字形（currentColor，无底）；
 * - `dicebear:<风格>:<背景>:<seed>`：随机风格头像，与项目头像同一格式
 *   （渲染走 projectAvatarSrc，彩色自带底盘）。
 */
export function parseNoteIcon(
  value: string | null | undefined,
): NoteIconValue | null {
  if (!value) return null;
  const glyph = parseDicebearIcon(value);
  if (glyph) return { kind: "glyph", name: glyph };
  if (value.startsWith("dicebear:") && isProjectAvatarId(value)) {
    return { kind: "avatar", id: value };
  }
  return null;
}

/** 组装选择值；名字必须在 icons 集合里 */
export function dicebearIconValue(name: string): string {
  if (!ICON_NAME_SET.has(name)) {
    throw new Error(`Unknown dicebear icon: ${name}`);
  }
  return `${VALUE_PREFIX}${name}`;
}

const ICON_STYLE = new Style(iconsDefinition as unknown as StyleDefinition);

/** 名字 → 内联 SVG；同一名字全应用共享一份（Avatar 组装不便宜） */
const SVG_CACHE = new Map<string, string>();

export function dicebearIconSvg(name: string): string {
  const cached = SVG_CACHE.get(name);
  if (cached) return cached;
  let svg = new Avatar(ICON_STYLE, {
    seed: name,
    iconVariant: name,
    iconColor: "#000000",
  }).toString();
  svg = svg
    // 背景瓷砖（icons 风格的底色块）去掉，页面图标和 emoji 一样不带底
    .replace(/<rect width="24" height="24" fill="#[0-9a-f]{6}"\/>/, "")
    // 字形描色交给组件的 CSS 文字色
    .replaceAll('fill="#000000"', 'fill="currentColor"');
  SVG_CACHE.set(name, svg);
  return svg;
}
