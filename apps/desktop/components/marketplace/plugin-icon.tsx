"use client";

/**
 * 插件图标：src 由 sidecar 解析为可直接显示的形态（http(s)/data URL）。
 *
 * 无图标（或加载失败）时的回落分两级：
 * 1. 有名称 → 首字母色块头像。取名称首字符大写，底色按名称散列出一个色相。
 *    插件市场里大量第三方插件不带图标，一律画同一个拼图会让整页出现十几个
 *    一模一样的灰块，无法用眼睛区分条目；首字母色块是这类列表的通行做法。
 * 2. 连名称都没有（市场空态等占位场景）→ 通用拼图。
 */
import { useState, type CSSProperties, type FC } from "react";
import { PuzzleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 名称 → 稳定色相（0-359）。
 *
 * 刻意不用 Math.random：那会让同一个插件每次重渲染换一个颜色，列表滚动或
 * 切视图时颜色乱跳，看着像坏了。这里要的是"彼此不同"而不是"每次不同"，
 * 所以由名称散列派生——同一插件恒定同色，不同插件大概率不同色。
 *
 * 结尾那三步 xorshift 混合不是可有可无的：裸 FNV-1a 的低位对短字符串偏弱，
 * 而 360 = 8×45 恰好吃低位，实测本机插件列表里 ui-design / eco-style-pack /
 * design-taste-frontend 三个名字会一起落到同一个色相（并排三张同色卡）。
 * 加终结混合后实测 80 个名字两两色差<20° 的比例 11.4%，与均匀分布的期望
 * 11% 基本重合。
 */
function hueFromName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) % 360;
}

/** 首字符大写。Array.from 按码点切，避免 emoji / 生僻字的代理对被劈坏 */
function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length > 0 ? chars[0]!.toUpperCase() : "";
}

export const PluginIcon: FC<{
  src?: string;
  /** 无图标时用于生成首字母色块；不传则回落到拼图占位 */
  name?: string;
  className?: string;
}> = ({ src, name, className }) => {
  const [failed, setFailed] = useState(false);
  const show = src && !failed;
  if (show) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={cn("size-full rounded-[inherit] object-contain", className)}
        draggable={false}
      />
    );
  }

  const initial = name ? initialOf(name) : "";
  const puzzle = (
    <PuzzleIcon className={cn("text-muted-foreground size-4.5", className)} />
  );
  if (!name || !initial) return puzzle;

  const hue = hueFromName(name);
  return (
    <span
      aria-hidden
      // 色相走 CSS 变量下发，好让下面那组 Tailwind 类名保持静态字面量
      // （暗色分支必须能写成 dark: 变体，动态拼类名 Tailwind 扫不到就不会生成）
      style={{ "--av-h": String(hue) } as CSSProperties}
      className={cn(
        // 浅底深字 / 暗色下深底浅字，两档亮度都留足对比度
        "grid size-full shrink-0 place-items-center rounded-[inherit] font-semibold",
        "bg-[hsl(var(--av-h)_72%_92%)] text-[hsl(var(--av-h)_58%_30%)]",
        "dark:bg-[hsl(var(--av-h)_42%_22%)] dark:text-[hsl(var(--av-h)_62%_84%)]",
        "text-sm",
        className,
      )}
    >
      {initial}
    </span>
  );
};
