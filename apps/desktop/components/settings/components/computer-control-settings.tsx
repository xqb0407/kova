"use client";

import { useState, type FC } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  saveBrowserConfig,
  useBrowserConfig,
} from "@/lib/settings/browser-config";
import { isDesktop } from "@/lib/desktop-env";
import {
  DatabaseIcon,
  GlobeIcon,
  MonitorCogIcon,
  MonitorIcon,
} from "lucide-react";

const desktopCore = () => import("@/desktop-bridge/core");

/**
 * 电脑控制区块（设置 → 智能体 → 智能体配置）——AI 驱动本机能力的总闸。
 *
 * 三个开关对应三条边界清晰的授权，粒度由"会不会碰到用户本人"决定：
 * - 浏览器驱动：驱动面板子 webview。面板是应用自己的窗口，点的是网页。
 * - 像素截图：另起一个无头 Chrome 拍页面画面。只读 URL，不碰桌面。
 * - 屏幕截图：读用户真实屏幕。这是唯一越线的那个，所以单独一个开关、默认关。
 *
 * 事实源在 sidecar（SQLite kv），browser_* 工具 execute 实时门控，即改即生效；
 * 这里只做镜像（lib/browser-config），乐观更新失败回滚并提示。
 * 网页端开关仍可改（远程 sidecar 同样消费），但能力依赖桌面宿主，区块尾给出提示。
 * 只出区块：页面骨架在 agent-config-settings，与本区块同页的还有 AI 审查。
 */
export const ComputerControlSettings: FC = () => {
  const browserTools = useBrowserConfig();
  /** 浏览器数据清理：进行中的操作（按钮置灰防重复点击）与"清除全部"二次确认 */
  const [clearing, setClearing] = useState<"cache" | "all" | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  /** 走主进程的 session 清理（browser_clear_cache / browser_clear_data）：
   *  清渲染缓存保留登录态；清全部连 Cookie/站点数据一起清并重载面板。
   *  直接用资源管理器删磁盘目录在应用运行时清不干净（session 占着句柄）。 */
  const runClear = async (mode: "cache" | "all") => {
    if (clearing) return;
    setClearing(mode);
    try {
      const { invoke } = await desktopCore();
      await invoke(mode === "cache" ? "browser_clear_cache" : "browser_clear_data");
      toast.add({
        title: mode === "cache" ? "浏览器缓存已清除" : "浏览器数据已清除",
        description:
          mode === "cache"
            ? undefined
            : "已退出所有网站登录，需要时重新登录即可。",
        type: "success",
      });
    } catch {
      toast.error("清除失败，请重试");
    } finally {
      setClearing(null);
      setConfirmClearAll(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        电脑控制
      </h2>
      <div className="mt-1 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            <GlobeIcon className="text-muted-foreground size-3.5" />
            浏览器
          </h3>
          <p className="text-muted-foreground text-sm">
            AI 通过内置浏览器面板操作网页，动作在面板中实时可见。
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
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
        </div>

        {/* 浏览器数据：与上面的能力开关不同，这组是数据管理（不涉及 AI 授权）。
            清缓存保留登录态；清全部连 Cookie/站点数据一起清、所有网站退出登录 */}
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            <DatabaseIcon className="text-muted-foreground size-3.5" />
            浏览器数据
          </h3>
          <p className="text-muted-foreground text-sm">
            内置浏览器面板的缓存与登录状态。清除数据后需要重新登录网站。
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
            <SettingRow
              label="清除内置浏览器缓存"
              desc="清除 HTTP 缓存、Cache Storage 与 Service Worker，保留 Cookie 与站点登录状态。"
            >
              <Button
                variant="outline"
                className={"bg-background "}
                size="sm"
                disabled={clearing !== null || !isDesktop()}
                onClick={() => void runClear("cache")}
              >
                {clearing === "cache" ? "清除中…" : "清除缓存"}
              </Button>
            </SettingRow>
            <SettingRow
              label="清除全部浏览器数据"
              desc="删除内置浏览器中的 Cookie、站点数据与缓存，所有网站都会退出登录。此操作不可撤销。"
            >
              <Button
                variant="destructive"
                size="sm"
                disabled={clearing !== null || !isDesktop()}
                // className="text-destructive hover:bg-destructive/10 hover:text-destructive "
                onClick={() => setConfirmClearAll(true)}
              >
                {clearing === "all" ? "清除中…" : "清除全部"}
              </Button>
            </SettingRow>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            <MonitorIcon className="text-muted-foreground size-3.5" />
            屏幕
          </h3>
          <p className="text-muted-foreground text-sm">
            这项会读取你正在看的真实桌面画面，是三者中唯一越过应用边界的。
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
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
        </div>
      </div>

      {!isDesktop() ? (
        <p className="text-muted-foreground/60 text-xs">
          当前为网页端：电脑控制能力依赖桌面宿主，设置仅作展示。
        </p>
      ) : null}

      {/* 「清除全部」二次确认：不可撤销 + 会退出所有登录，值得一次停顿 */}
      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除全部浏览器数据？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除内置浏览器的 Cookie、站点数据与缓存，所有网站都会退出登录。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default" disabled={clearing !== null}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={clearing !== null}
              onClick={() => void runClear("all")}
            >
              {clearing === "all" ? "清除中…" : "清除全部"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
