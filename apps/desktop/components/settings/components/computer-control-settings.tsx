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
import { useT } from "@/lib/i18n";
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
  const t = useT();
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
        title: mode === "cache" ? t("settings.computerControl.cacheCleared") : t("settings.computerControl.dataCleared"),
        description:
          mode === "cache"
            ? undefined
            : t("settings.computerControl.dataClearedDesc"),
        type: "success",
      });
    } catch {
      toast.error(t("settings.computerControl.clearFailed"));
    } finally {
      setClearing(null);
      setConfirmClearAll(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {t("settings.computerControl.title")}
      </h2>
      <div className="mt-1 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            {t("settings.computerControl.browser")}
          </h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.computerControl.browserDesc")}
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
            <SettingRow
              label={t("settings.computerControl.browserDrive")}
              desc={t("settings.computerControl.browserDriveDesc")}
            >
              <Switch
                checked={browserTools.enabled}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ ...browserTools, enabled: v }).catch(() => {
                    toast.error(t("settings.agentConfig.saveFailed"));
                  });
                }}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.computerControl.pixelShot")}
              desc={t("settings.computerControl.pixelShotDesc")}
            >
              <Switch
                checked={browserTools.pixelShot}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ ...browserTools, pixelShot: v }).catch(() => {
                    toast.error(t("settings.agentConfig.saveFailed"));
                  });
                }}
              />
            </SettingRow>
          </div>
        </div>

        {/* 浏览器数据：与上面的能力开关不同，这组是数据管理（不涉及 AI 授权）。
            清缓存保留登录态；清全部连 Cookie/站点数据一起清、所有网站退出登录 */}
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            {t("settings.computerControl.browserData")}
          </h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.computerControl.browserDataDesc")}
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
            <SettingRow
              label={t("settings.computerControl.clearCache")}
              desc={t("settings.computerControl.clearCacheDesc")}
            >
              <Button
                variant="outline"
                className={"bg-background "}
                size="sm"
                disabled={clearing !== null || !isDesktop()}
                onClick={() => void runClear("cache")}
              >
                {clearing === "cache" ? t("settings.computerControl.clearing") : t("settings.computerControl.clearCacheAction")}
              </Button>
            </SettingRow>
            <SettingRow
              label={t("settings.computerControl.clearAll")}
              desc={t("settings.computerControl.clearAllDesc")}
            >
              <Button
                variant="destructive"
                size="sm"
                disabled={clearing !== null || !isDesktop()}
                // className="text-destructive hover:bg-destructive/10 hover:text-destructive "
                onClick={() => setConfirmClearAll(true)}
              >
                {clearing === "all" ? t("settings.computerControl.clearing") : t("settings.computerControl.clearAllAction")}
              </Button>
            </SettingRow>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold">
            {t("settings.computerControl.screen")}
          </h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.computerControl.screenDesc")}
          </p>
          <div className="bg-muted/50 divide-none flex flex-col rounded-2xl p-2">
            <SettingRow
              label={t("settings.computerControl.screenShot")}
              desc={t("settings.computerControl.screenShotDesc")}
            >
              <Switch
                checked={browserTools.screenShot}
                onCheckedChange={(v) => {
                  saveBrowserConfig({ ...browserTools, screenShot: v }).catch(() => {
                    toast.error(t("settings.agentConfig.saveFailed"));
                  });
                }}
              />
            </SettingRow>
          </div>
        </div>
      </div>

      {!isDesktop() ? (
        <p className="text-muted-foreground text-[13px] leading-5">
          {t("settings.computerControl.webOnlyHint")}
        </p>
      ) : null}

      {/* 「清除全部」二次确认：不可撤销 + 会退出所有登录，值得一次停顿 */}
      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.computerControl.clearAllConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.computerControl.clearAllConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default" disabled={clearing !== null}>
              {t("settings.computerControl.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={clearing !== null}
              onClick={() => void runClear("all")}
            >
              {clearing === "all" ? t("settings.computerControl.clearing") : t("settings.computerControl.clearAllAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
