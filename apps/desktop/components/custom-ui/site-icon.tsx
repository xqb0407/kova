"use client";

import { useState, type FC } from "react";
import { GlobeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 站点图标：直连 `https://<host>/favicon.ico`（不依赖 Google/DDG 的第三方
 * favicon 服务——境内不可达且多一层隐私外泄）；拿不到就落回地球占位。
 * 消息里的搜索结果行、活动面板引用资料、Markdown 外链共用这一份。
 * className 在默认尺寸类之后合并（tailwind-merge：后来者胜），用于行内排版微调。
 */
export const SiteIcon: FC<{ url: string; className?: string }> = ({
  url,
  className,
}) => {
  const [broken, setBroken] = useState(false);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // 非法 URL：直接占位图标
  }
  if (!host || broken)
    return (
      <GlobeIcon
        className={cn(
          "text-muted-foreground/50 size-3.5 shrink-0",
          className,
        )}
      />
    );
  return (
    <img
      src={`https://${host}/favicon.ico`}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn(
        "size-3.5 shrink-0 rounded-[3px] object-contain",
        className,
      )}
    />
  );
};
