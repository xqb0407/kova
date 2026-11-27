import type { FC } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { SOUND_PACKS } from "@/lib/notify/sounds";
import { setUiPref, useUiPrefs, type SoundPackName } from "@/lib/settings/ui-prefs";
import { useT } from "@/lib/i18n";
import { WebhooksPanel } from "./webhooks-panel";

/** 音色包 → i18n key；Record 保证新增音色包时不会漏配文案 */
const SOUND_PACK_LABEL_KEYS: Record<
  SoundPackName,
  "settings.notifications.soundCrisp" | "settings.notifications.soundCalm"
> = {
  crisp: "settings.notifications.soundCrisp",
  calm: "settings.notifications.soundCalm",
};

/** 提醒：提示音、音色、音量、仅后台提醒、弹窗通知 */
const RemindersSection: FC = () => {
  const t = useT();
  const prefs = useUiPrefs();
  const soundPackOptions = SOUND_PACKS.map((pack) => ({
    value: pack.value,
    label: t(SOUND_PACK_LABEL_KEYS[pack.value]),
  }));

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("settings.notifications.remindersTitle")}</h2>
      <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        <SettingRow label={t("settings.notifications.soundEnabled")}>
          <Switch
            checked={prefs.soundEnabled}
            onCheckedChange={(v) => setUiPref("soundEnabled", v)}
          />
        </SettingRow>
        <SettingRow label={t("settings.notifications.soundPack")}>
          <Select
            value={prefs.soundPack}
            onValueChange={(v) => setUiPref("soundPack", v as SoundPackName)}
            items={soundPackOptions}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {soundPackOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.notifications.volume")}>
          <div className="flex w-44 items-center gap-3">
            <Slider
              min={0}
              max={100}
              value={[Math.round(prefs.soundVolume * 100)]}
              disabled={!prefs.soundEnabled}
              onValueChange={(v) => {
                const first = Array.isArray(v) ? v[0] : v;
                setUiPref("soundVolume", Number(first ?? 60) / 100);
              }}
            />
            <span className="text-muted-foreground w-8 text-right text-[13px] leading-5 tabular-nums">
              {Math.round(prefs.soundVolume * 100)}
            </span>
          </div>
        </SettingRow>
        <SettingRow label={t("settings.notifications.onlyUnfocused")}>
          <Switch
            checked={prefs.soundOnlyUnfocused}
            disabled={!prefs.soundEnabled}
            onCheckedChange={(v) => setUiPref("soundOnlyUnfocused", v)}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.notifications.popup")}
          desc={t("settings.notifications.popupDesc")}
        >
          <Switch
            checked={prefs.popupEnabled}
            onCheckedChange={(v) => setUiPref("popupEnabled", v)}
          />
        </SettingRow>
      </div>
    </section>
  );
};

/** 通知页：提醒与 Webhook 推送都是「有事发生时通知我」，平铺在同一页 */
export const NotificationsSettings: FC = () => {
  const t = useT();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-8 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("settings.sections.notifications")}
        </h1>
      </div>

      <RemindersSection />
      <WebhooksPanel />
    </div>
  );
};
