"use client";

import { useEffect, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  SHORTCUT_ACTIONS,
  eventToConfig,
  formatShortcutParts,
  isDefaultBinding,
  resetShortcutBinding,
  setShortcutBinding,
  useShortcuts,
  type ShortcutActionId,
  type ShortcutConfig,
} from "@/lib/shortcuts";

/** 平台判断：快捷键提示 ⌘/⌥（mac）或 Ctrl/Alt（其他）。设置页由用户交互后渲染，
 *  懒初始化即可，无 SSR 水合问题 */
const useIsMac = () =>
  useState(() => {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac/i.test(nav.userAgentData?.platform || nav.platform || "");
  })[0];

const BindingChips: FC<{ config: ShortcutConfig }> = ({ config }) => {
  const isMac = useIsMac();
  return (
    <KbdGroup>
      {formatShortcutParts(config, isMac).map((part, i) => (
        <Kbd key={`${part}-${i}`}>{part}</Kbd>
      ))}
    </KbdGroup>
  );
};

/** 快捷键配置页：列出应用级快捷键，支持点击录制新绑定。
 *  绑定存 SQLite kv（桌面）/ localStorage（网页），监听方即时生效；
 *  录制用 capture 阶段的 document keydown，Esc 取消，纯修饰键按下继续等待主键。 */
export const ShortcutSettings: FC = () => {
  const t = useT();
  const bindings = useShortcuts();
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setError(null);
        return;
      }
      const config = eventToConfig(event);
      if (!config) return; // 纯修饰键：等待主键
      const result = setShortcutBinding(recording, config);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setRecording(null);
    };
    const onBlur = () => {
      setRecording(null);
      setError(null);
    };
    // capture：抢在输入框等目标监听之前吞掉录制按键
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.shortcuts.title")}</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.shortcuts.app")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.shortcuts.appDesc")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {SHORTCUT_ACTIONS.filter((a) => a.scope === "global").map(
              renderAction,
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.shortcuts.composer")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.shortcuts.composerDesc")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {SHORTCUT_ACTIONS.filter((a) => a.scope === "composer").map(
              renderAction,
            )}
          </div>
        </section>

        {/* 固定交互键说明：这些属于组件标准行为，不提供改绑 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.shortcuts.fixed")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.shortcuts.fixedDesc")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.shortcuts.cancelClose")} desc={t("settings.shortcuts.cancelCloseDesc")}>
              <span />
            </SettingRow>
            <SettingRow label={t("settings.shortcuts.listNav")} desc={t("settings.shortcuts.listNavDesc")}>
              <span />
            </SettingRow>
          </div>
        </section>
      </div>
    </div>
  );

  function renderAction(action: (typeof SHORTCUT_ACTIONS)[number]) {
    const isRecording = recording === action.id;
    return (
      <div key={action.id}>
        <SettingRow label={t(action.labelKey)} desc={t(action.descKey)}>
          {isRecording ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground animate-pulse text-sm">
                {t("settings.shortcuts.recording")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRecording(null);
                  setError(null);
                }}
              >
                {t("settings.shortcuts.cancel")}
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <BindingChips config={bindings[action.id]} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError(null);
                  setRecording(action.id);
                }}
              >
                {t("settings.shortcuts.modify")}
              </Button>
              {!isDefaultBinding(action.id) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    resetShortcutBinding(action.id);
                    setError(null);
                  }}
                >
                  {t("settings.shortcuts.reset")}
                </Button>
              )}
            </span>
          )}
        </SettingRow>
        {isRecording && error && (
          <div className="text-destructive px-3 pb-2 text-[13px] leading-5">{error}</div>
        )}
      </div>
    );
  }
};
