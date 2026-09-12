"use client";

import type { FC } from "react";

/** 独立标签的空态占位(与活动标签的空态观感一致);tab-registry 与各标签视图共用 */
export const TabEmpty: FC<{
  icon: FC<{ className?: string }>;
  text: string;
}> = ({ icon: Icon, text }) => (
  <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
    <Icon className="size-6" />
    <p>{text}</p>
  </div>
);