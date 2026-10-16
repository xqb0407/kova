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
import { PixelMascot } from "@/components/ui/pixel-mascot";

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
 * 项目徽章：自传图片 > 像素吉祥物 > 矢量吉祥物；都没有返回 null（调用方回退
 * 文件夹图标）。尺寸统一 18px：侧栏行高 32px 下与文件夹图标视觉等价，矢量图标
 * 在 14px 处清晰，8×8 像素精灵在同尺寸下按 2×2 设备像素放大、边缘仍锐利。
 */
export const ProjectBadge: FC<{
  appearance: ProjectAppearance | null;
  className?: string;
}> = memo(({ appearance, className }) => {
  if (!appearance) return null;

  if (appearance.image) {
    return (
      // dataURL 头像：固定方形 + 裁切，用户传任意宽高比都不变形
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={appearance.image}
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
  // 像素吉祥物与矢量吉祥物共用同一枚徽章外观（颜色同样"给图标上色"）
  const GlyphIcon = appearance.glyph
    ? PROJECT_GLYPH_ICONS[appearance.glyph]
    : undefined;
  const inner = appearance.pixel ? (
    <PixelMascot id={appearance.pixel} className="size-3.5" />
  ) : GlyphIcon ? (
    <GlyphIcon className="size-3.5" />
  ) : null;
  // 颜色是"给图标上色"用的：没有吉祥物/图片时不画东西，调用方改为把颜色套在
  // 默认文件夹图标上（见项目分组头），语义一致也避免出现孤零零的色块
  if (!inner) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px]",
        !color && "bg-muted text-foreground",
        className,
      )}
      // 主色给图标上色（`#` 涂色的意思）；底色取同色 13% 透明度做柔和衬底，
      // 深浅主题下都成立，不必维护两套色
      style={color ? { backgroundColor: `${color}22`, color } : undefined}
    >
      {inner}
    </span>
  );
});

ProjectBadge.displayName = "ProjectBadge";
