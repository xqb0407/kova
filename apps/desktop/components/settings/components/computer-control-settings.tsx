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
 * 电脑控制设置页：AI 驱动本机能力的总闸。
 *
 * 三个开关对应三条边界清晰的授权，粒度由"会不会碰到用户本人"决定：
 * - 浏览器驱动：驱动面板子 webview。面板是应用自己的窗口，点的是网页。
 * - 像素截图：另起一个无头 Chrome 拍页面画面。只读 URL，不碰桌面。
 * - 屏幕截图：读用户真实屏幕。这是唯一越线的那个，所以单独一个开关、默认关。
 *
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
                  saveBrowserConfig({ ...browserTools, enabled: v }).catch(() =>
                    toast.error("保存失败，请重试"),
                  );
                }}
              />
            </SettingRow>
            <SettingRow
              label="像素截图"
              desc="当页面的 ARIA 结构答不上问题时（如 canvas / WebGL 渲染的图表、地图、3D 场景），允许 AI 用一个一次性的无头 Chrome 拍下这一页。只会读取浏览器当前所在的网址，不操作桌面、不合成鼠标键盘，每次约一秒。"
            >
              <Switch
                checked={browserTools.pixelShot}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ ...browserTools, pixelShot: v }).catch(() =>
                    toast.error("保存失败，请重试"),
                  );
                }}
              />
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">屏幕</h2>
          <p className="text-muted-foreground text-sm">
            这项会读取你正在看的真实桌面画面，是三者中唯一越过应用边界的。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="屏幕截图"
              desc="允许 AI 抓取整块屏幕。用于排查非浏览器窗口的问题、或页面在浏览器里看不到的视觉错误。关闭时 AI 完全看不到你的桌面。"
            >
              <Switch
                checked={browserTools.screenShot}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ ...browserTools, screenShot: v }).catch(() =>
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
