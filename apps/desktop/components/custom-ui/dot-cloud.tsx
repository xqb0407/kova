"use client";

/**
 * 点阵云：空态视觉里叠在图标背后的装饰（搜索页、资料库等共用）。
 *
 * 点阵用**单个元素**的 radial-gradient 平铺实现，而不是几百个 span——
 * 视觉等价（10px 步距 / 3px 圆点 / 径向渐隐 mask），但 DOM 节点只有 1 个，
 * 首帧挂载成本基本归零。
 */
import { memo, type FC } from "react";
import { cn } from "@/lib/utils";

export const DotCloud: FC<{ className?: string }> = memo(function DotCloud({
  className,
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "h-48 w-72 text-foreground opacity-[0.14] [mask-image:radial-gradient(ellipse_72%_68%_at_50%_50%,#000_18%,transparent_76%)]",
        className,
      )}
      style={{
        backgroundImage:
          "radial-gradient(circle, currentColor 1.5px, transparent 1.5px)",
        backgroundSize: "10px 10px",
        backgroundPosition: "5px 5px",
      }}
    />
  );
});
