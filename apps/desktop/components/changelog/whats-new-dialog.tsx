"use client";

/**
 * 升级后的「本次更新内容」弹窗。
 *
 * 只在版本变化时出现一次（已读版本写 localStorage）；只展示当前安装版本的
 * 那一条日志，不把跳过的中间版本一起堆出来。首次安装（引导还没走过）不弹，
 * 只写基线——引导本身会带用户认识应用，再来一个更新弹窗只会打架。
 */
import { useEffect, useState, type FC } from "react";
import { getVersion } from "@/desktop-bridge/app";
import { ChangelogTimeline } from "./changelog-timeline";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ONBOARDING_COMPLETED_KEY } from "@/components/onboarding/onboarding-provider";
import { entryForVersion } from "@/lib/changelog";
import { isDesktop } from "@/lib/desktop-env";
import { useLocale, useT } from "@/lib/i18n";
import { isRemoteMode } from "@/lib/remote";

const SEEN_VERSION_KEY = "changelog.seenVersion.v1";
/** 等开屏与首屏稳定后再弹，避免和启动动画抢注意力 */
const SHOW_DELAY_MS = 2_000;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(SEEN_VERSION_KEY, version);
  } catch {
    // 写不进去最多下次再弹一次，不影响使用
  }
}

export const WhatsNewDialog: FC = () => {
  const t = useT();
  const locale = useLocale();
  // 只存版本号，展示内容按当前语言实时派生：弹窗开着时切换语言也会跟着换
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const entry = version ? entryForVersion(version, locale) : null;

  useEffect(() => {
    // 远程客户端 / 网页端不弹：更新日志是本地安装版本的说明，远程连接屏
    // 或远程会话里弹出来既不对版本，也打断配对。
    if (!isDesktop() || isRemoteMode()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const seen = readStorage(SEEN_VERSION_KEY);
        const onboarded = readStorage(ONBOARDING_COMPLETED_KEY) === "1";
        let version: string;
        try {
          version = await getVersion();
        } catch {
          return;
        }
        if (cancelled) return;

        // 首次安装：只记基线，不打扰
        if (!onboarded) {
          writeSeenVersion(version);
          return;
        }
        const current = entryForVersion(version, locale);
        if (!current || seen === version) {
          writeSeenVersion(version);
          return;
        }

        writeSeenVersion(version);
        setVersion(current.version);
        setOpen(true);
      })();
    }, SHOW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [locale]);

  const viewFullChangelog = () => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent("kova:open-settings-section", { detail: "changelog" }),
    );
  };

  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.changelog.whatsNewTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.changelog.whatsNewDesc", { version: entry.version })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto pr-1">
          <ChangelogTimeline
            entries={[entry]}
            currentVersion={entry.version}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={viewFullChangelog}>
            {t("settings.changelog.viewFull")}
          </Button>
          <Button onClick={() => setOpen(false)}>
            {t("settings.changelog.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
