"use client";

/** 设置 → 更新日志：随包内置的完整版本历史（数据来自根目录 CHANGELOG.md）。 */
import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon } from "lucide-react";
import { getVersion } from "@/desktop-bridge/app";
import { Button } from "@/components/ui/button";
import { ChangelogTimeline } from "@/components/changelog/changelog-timeline";
import { changelogForLocale } from "@/lib/changelog";
import { isDesktop } from "@/lib/desktop-env";
import { useLocale, useT } from "@/lib/i18n";

export const ChangelogSettings: FC<{ onBack?: () => void }> = ({ onBack }) => {
  const t = useT();
  const locale = useLocale();
  const entries = changelogForLocale(locale);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  // 返回键 portal 进设置页顶栏槽位（与产物详情页同款）：落在内容区左上角，
  // 不额外占一行、不把标题往下推。
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTopSlot(
      document.querySelector<HTMLElement>('[data-slot="settings-top-actions"]'),
    );
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => {
        // 拿不到版本只影响「当前版本」徽标，不影响日志展示
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {topSlot && onBack
        ? createPortal(
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 shrink-0"
              onClick={onBack}
              data-drag-region="false"
            >
              <ChevronLeftIcon className="size-4" />
              {t("settings.changelog.back")}
            </Button>,
            topSlot,
          )
        : null}
      <div className="flex w-full max-w-3xl flex-col gap-6 self-center px-8 py-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.changelog.title")}
          </h1>
          <p className="text-muted-foreground text-sm leading-6">
            {t("settings.changelog.subtitle")}
          </p>
        </div>

        {entries.length > 0 ? (
          <ChangelogTimeline entries={entries} currentVersion={currentVersion} />
        ) : (
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl px-5 py-8 text-center">
            <div className="text-sm font-medium">
              {t("settings.changelog.empty")}
            </div>
            <div className="text-muted-foreground text-[13px] leading-5">
              {t("settings.changelog.emptyDesc")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
