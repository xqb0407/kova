"use client";

/**
 * 空状态：全应用共用一套。
 *
 * 两种尺寸：
 *   panel   —— 大阅读区（收件箱详情栏）用，点阵云 + 14 方格图标底；
 *   compact —— 内容区内的空态（资料库、市场目录）用，只有图标底。
 *
 * 约定：标题说清「没有什么」，描述给下一步，动作最多一个主按钮。
 * 同一屏里不要两个元素同时宣告同一件空事（列表栏说了，详情栏就只说明自己会显示什么）。
 */
import type { FC, ReactNode } from "react";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  size?: "panel" | "compact";
  className?: string;
};

export const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  size = "compact",
  className,
}) => {
  const panel = size === "panel";
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-col items-center justify-center px-6 text-center",
        panel ? "h-full" : "py-16",
        className,
      )}
    >
      <div className="relative mb-4 grid place-items-center">
        {panel ? <DotCloud className="h-40 w-60" /> : null}
        <span
          className={cn(
            "bg-primary/5 text-primary ring-border/70 grid place-items-center rounded-2xl ring-1 ring-inset",
            panel ? "absolute size-14" : "size-12",
          )}
        >
          {icon}
        </span>
      </div>
      <p className="text-foreground/90 text-sm font-medium leading-6">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-5">{description}</p>
      ) : null}
      {action ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
};