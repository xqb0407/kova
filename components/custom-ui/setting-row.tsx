"use client";

import type { FC, ReactNode } from "react";

/** 行式设置项：左标题+说明，右控件；设置页（外观/关于等）通用的列表行 */
export const SettingRow: FC<{
  label: string;
  desc?: string;
  children: ReactNode;
}> = ({ label, desc, children }) => (
  <div className="flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2">
    <div className="min-w-0">
      <div className="text-sm font-medium">{label}</div>
      {desc && <div className="text-muted-foreground text-xs">{desc}</div>}
    </div>
    {children}
  </div>
);
