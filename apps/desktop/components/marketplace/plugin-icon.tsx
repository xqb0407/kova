"use client";

/**
 * 插件图标：src 由 sidecar 解析为可直接显示的形态（http(s)/data URL）；
 * 无图标或加载失败回退通用拼图占位（与市场空态同族）。
 */
import { useState, type FC } from "react";
import { PuzzleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const PluginIcon: FC<{
  src?: string;
  className?: string;
}> = ({ src, className }) => {
  const [failed, setFailed] = useState(false);
  const show = src && !failed;
  return show ? (
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className={cn("size-full rounded-[inherit] object-contain", className)}
      draggable={false}
    />
  ) : (
    <PuzzleIcon className={cn("text-muted-foreground size-4.5", className)} />
  );
};
