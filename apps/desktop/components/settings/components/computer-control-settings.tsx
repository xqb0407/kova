"use client";

import type { FC } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  saveBrowserConfig,
  useBrowserConfig,
} from "@/lib/settings/browser-config";
import { isTauri } from "@/lib/tauri";

/**
 * 电脑控制设置页：AI 驱动本机能力的总闸。现有「浏览器驱动」（browser_*
 * 工具的总开关）；后续系统级能力（截图、桌面自动化等）的开关也归这里。
 * 事实源在 sidecar（SQLite kv），browser_* 工具 execute 实时门控，即改即生效；
 * 这里只做镜像（lib/browser-config），乐观更新失败回滚并提示。
 * 网页端开关仍可改（远程 sidecar 同样消费），但能力依赖桌面宿主，页尾给出提示。
 */
export const ComputerControlSettings: FC = () => {
  const browserTools = useBrowserConfig();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">电脑控制</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">浏览器</h2>
          <p className="text-muted-foreground text-sm">
            AI 通过内置浏览器面板操作网页，动作在面板中实时可见。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="浏览器驱动"
              desc="允许 AI 驱动内置浏览器面板：导航、点击、输入与滚动。"
            >
              <Switch
                checked={browserTools.enabled}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ enabled: v }).catch(() =>
                    toast.error("保存失败，请重试"),
                  );
                }}
              />
            </SettingRow>
          </div>
        </section>

        {!isTauri() ? (
          <p className="text-muted-foreground/60 text-xs">
            当前为网页端：电脑控制能力依赖桌面宿主，设置仅作展示。
          </p>
        ) : null}
      </div>
    </div>
  );
};
