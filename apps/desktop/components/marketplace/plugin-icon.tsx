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
import { useState, type FC } from "react";
import { PuzzleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LetterAvatar } from "@/components/custom-ui/letter-avatar";

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

  const puzzle = (
    <PuzzleIcon className={cn("text-muted-foreground size-4.5", className)} />
  );
  if (!name || !name.trim()) return puzzle;

  return <LetterAvatar name={name} className={className} />;
};
