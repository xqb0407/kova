"use client";

import type { FC, ReactNode } from "react";

/** 行式设置项：左标题+说明，右控件；设置页（外观/关于等）通用的列表行 */
export const SettingRow: FC<{
  label: string;
  desc?: string;
  children: ReactNode;
}> = ({ label, desc, children }) => (
  <div
    data-setting-label={label}
    className="flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2"
  >
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{label}</div>
      {desc && (
        // text-pretty：窄容器里避免最后一行只剩一两个字的孤行
        <div className="text-muted-foreground text-ui leading-5 text-pretty">
          {desc}
        </div>
      )}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);
