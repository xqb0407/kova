"use client";

import { useEffect, type FC } from "react";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Segmented } from "@/components/custom-ui/segmented";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  refreshToolProfileSettings,
  saveToolProfileSettings,
  useToolProfileSettings,
  type ToolProfileValue,
} from "@/lib/settings/tool-profile-config";

/**
 * 工具面档位区块（设置 → 智能体 → 智能体配置）。
 *
 * 事实源在 sidecar kv pi.toolProfile；coding 档只收创作/辅助类工具
 * （文生图/视觉辅助/面板唤起），调试用的 browser/截图/知识库照常保留。
 * 翻转由 sidecar 整组热重建活动会话工具表，无需重启或新建会话。
 */
export const ToolProfileSettings: FC = () => {
  const t = useT();
  const settings = useToolProfileSettings();

  useEffect(() => {
    void refreshToolProfileSettings();
  }, []);

  const save = (profile: ToolProfileValue) => {
    saveToolProfileSettings({ profile }).catch(() => {
      toast.error(t("settings.toolProfile.saveFailed"));
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("settings.toolProfile.title")}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("settings.toolProfile.desc")}
      </p>

      <div className="bg-muted/50 divide-border/40 mt-1 flex flex-col divide-y rounded-2xl p-2">
        <SettingRow
          label={
            settings.profile === "coding"
              ? t("settings.toolProfile.coding")
              : t("settings.toolProfile.full")
          }
          desc={
            settings.profile === "coding"
              ? t("settings.toolProfile.codingDesc")
              : t("settings.toolProfile.fullDesc")
          }
        >
          <Segmented
            value={settings.profile}
            options={[
              { value: "full", label: t("settings.toolProfile.full") },
              { value: "coding", label: t("settings.toolProfile.coding") },
            ]}
            onChange={(value) => save(value as ToolProfileValue)}
          />
        </SettingRow>
      </div>

      <p className="text-muted-foreground border-border/50 mt-1 px-1 pt-2 text-ui leading-relaxed">
        {t("settings.toolProfile.footer")}
      </p>
    </section>
  );
};
