"use client";

/**
 * 首字母色块头像：取名称首字符大写，底色按名称散列出一个稳定色相。
 *
 * 技能/插件这类条目大量没有图标，一律画同一个通用图标会让整页出现一排
 * 无法用眼睛区分的灰块；首字母色块是这类列表的通行做法。色相由名称
 * 派生（不是随机），同一名称恒定同色，列表刷新/滚动时颜色不乱跳。
 */
import type { CSSProperties, FC } from "react";
import { cn } from "@/lib/utils";
import { hueFromName } from "@/lib/ui/name-hue";

/** 首字符大写。Array.from 按码点切，避免 emoji / 生僻字的代理对被劈坏 */
function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length > 0 ? chars[0]!.toUpperCase() : "";
}

export const LetterAvatar: FC<{
  name: string;
  /** 字号/文本色等覆盖；圆角继承父容器（父容器负责 size 与 rounded-*） */
  className?: string;
}> = ({ name, className }) => {
  const initial = initialOf(name);
  if (!initial) return null;
  return (
    <span
      aria-hidden
      // 色相走 CSS 变量下发，下面的 Tailwind 类名保持静态字面量
      // （暗色分支必须能写成 dark: 变体，动态拼类名 Tailwind 扫不到）
      style={{ "--av-h": String(hueFromName(name)) } as CSSProperties}
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
