"use client";

import { memo, type FC } from "react";
import {
  Bird,
  BotIcon,
  Bug,
  Cat,
  Cherry,
  Coffee,
  Donut,
  Fish,
  Pizza,
  Rabbit,
  Snail,
  Squirrel,
  Turtle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectAppearance } from "@/lib/projects/project-appearance";
import { projectAvatarSrc } from "@/lib/projects/project-avatars";
import { dicebearIconSvg, parseDicebearIcon } from "@/lib/ui/dicebear-icons";

/** 内置吉祥物 id → 矢量图标（数据层不引 UI 库，映射放这里）。导出供吉祥物
 *  选择器按自己的尺寸直接画图标（见 project-settings-popover） */
export const PROJECT_GLYPH_ICONS: Record<string, LucideIcon> = {
  cat: Cat,
  rabbit: Rabbit,
  bird: Bird,
  fish: Fish,
  snail: Snail,
  squirrel: Squirrel,
  bug: Bug,
  turtle: Turtle,
  cherry: Cherry,
  donut: Donut,
  pizza: Pizza,
  coffee: Coffee,
  bot: BotIcon
};

/**
 * 项目主色的主题自适应（只作用于图标，不改色板本身显示的原始 hex）：
 * - `ink`：线条色混入 18% 前景色——浅色模式压深、深色模式提亮，
 *   自定义深色 hex 在暗色主题下也不会糊进背景；
 * - `wash`：13% 透明度衬底，等价于原来的 `${color}22`。
 */
export function projectColorTokens(color: string): {
  ink: string;
  wash: string;
} {
  return {
    ink: `color-mix(in oklab, ${color} 82%, var(--color-foreground))`,
    wash: `color-mix(in oklab, ${color} 13%, transparent)`,
  };
}

/**
 * 项目徽章：上传图片 > 内置头像 > 矢量吉祥物；都没有返回 null（调用方回退
 * 文件夹图标）。默认 18px（侧栏行高 32px 下与文件夹图标视觉等价，矢量图标在
 * 14px 处清晰）；侧栏调用方会把槽位放大到 24px。
 */
export const ProjectBadge: FC<{
  appearance: ProjectAppearance | null;
  className?: string;
}> = memo(({ appearance, className }) => {
  if (!appearance) return null;

  // 上传图与内置头像共用同一套方形裁切；内置 Gaze 头像自带底色
  const imageSrc = appearance.image ?? projectAvatarSrc(appearance.avatar);
  if (imageSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageSrc}
        alt=""
        draggable={false}
        className={cn(
          "size-[18px] shrink-0 rounded-[5px] object-cover",
          className,
        )}
      />
    );
  }

  const color = appearance.color;
  // glyph 两种形态：12 个吉祥物 id（Lucide 矢量）或 `dicebear:icons:<名字>`
  // 线条图标（与资料库笔记图标同源，currentColor 跟随主色）
  const dicebearGlyph = appearance.glyph
    ? parseDicebearIcon(appearance.glyph)
    : null;
  const GlyphIcon =
    appearance.glyph && !dicebearGlyph
      ? PROJECT_GLYPH_ICONS[appearance.glyph]
      : undefined;
  const inner = dicebearGlyph ? (
    <span
      aria-hidden
      className="size-3.5 [&>svg]:size-full [&>svg]:shrink-0"
      // eslint-disable-next-line react/no-danger -- SVG 由本地打包的静态数据集生成（见 lib/ui/dicebear-icons），非用户输入
      dangerouslySetInnerHTML={{ __html: dicebearIconSvg(dicebearGlyph) }}
    />
  ) : GlyphIcon ? (
    <GlyphIcon className="size-3.5" />
  ) : null;
  // 颜色是"给图标上色"用的：没有吉祥物/头像/图片时不画东西，调用方改为把
  // 颜色套在默认文件夹图标上（见项目分组头），语义一致也避免出现孤零零的色块
  if (!inner) return null;
  const tokens = color ? projectColorTokens(color) : null;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px]",
        !color && "bg-muted text-foreground",
        className,
      )}
      style={
        tokens
          ? { backgroundColor: tokens.wash, color: tokens.ink }
          : undefined
      }
    >
      {inner}
    </span>
  );
});

ProjectBadge.displayName = "ProjectBadge";
