"use client";

import { useEffect, type FC } from "react";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  refreshPtcSettings,
  savePtcSettings,
  usePtcSettings,
} from "@/lib/pi/ptc";

/**
 * PTC 区块（设置 → 智能体 → 智能体配置）。
 *
 * 事实源在 sidecar kv pi.ptc；开关在 sidecar 侧按「会话物化时快照」生效，
 * 所以这里必须写清「新建会话后生效」——不能让人以为翻一下开关当前会话就换了工具表。
 */
export const PtcSettings: FC = () => {
  const t = useT();
  const settings = usePtcSettings();

  useEffect(() => {
    void refreshPtcSettings();
  }, []);

  const save = (enabled: boolean) => {
    savePtcSettings({ enabled }).catch(() => {
      toast.error(t("settings.agentConfig.saveFailed"));
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{t("settings.ptc.title")}</h2>
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
          {t("settings.ptc.beta")}
        </span>
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("settings.ptc.desc")}
      </p>

      <div className="bg-muted/50 mt-1 flex flex-col gap-1 rounded-2xl p-2">
        <SettingRow
          label={t("settings.ptc.enabled")}
          desc={t("settings.ptc.enabledDesc")}
        >
          <Switch
            checked={settings.enabled}
            onCheckedChange={save}
          />
        </SettingRow>
      </div>

      <p className="text-muted-foreground border-border/50 mt-1 px-1 pt-2 text-ui leading-relaxed">
        {t("settings.ptc.footer")}
      </p>
    </section>
  );
};
