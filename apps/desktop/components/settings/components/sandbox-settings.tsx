"use client";

import type { FC } from "react";
import { ShieldIcon } from "lucide-react";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import {
  saveSandboxSettings,
  useSandboxSettings,
  type SandboxSettings,
} from "@/lib/pi/sandbox";
import { useT } from "@/lib/i18n";

/**
 * 沙箱区块（设置 → 智能体 → 智能体配置）。
 *
 * V1 只有“写隔离”一档：macOS 的 bash 走 Seatbelt；Windows 只校验
 * read/write/edit/http，bash 暂无 OS 沙箱（这里如实标注，不假装已隔离）。
 */
export const SandboxSettingsPanel: FC = () => {
  const t = useT();
  const settings = useSandboxSettings();

  const save = (patch: Partial<SandboxSettings>) => {
    saveSandboxSettings({ ...settings, ...patch }).catch(() => {
      toast.error(t("settings.agentConfig.saveFailed"));
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {t("settings.sandbox.title")}
      </h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("settings.sandbox.desc")}
      </p>

      <div className="bg-muted/50 mt-1 flex flex-col gap-1 rounded-2xl p-2">
        <SettingRow label={t("settings.sandbox.tier")} desc={t("settings.sandbox.tierDesc")}>
          <Select
            value={settings.tier}
            onValueChange={(v) => save({ tier: v as SandboxSettings["tier"] })}
            items={[
              { value: "off", label: t("settings.sandbox.off") },
              { value: "workspace", label: t("settings.sandbox.workspaceRecommended") },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("settings.sandbox.off")}</SelectItem>
              <SelectItem value="workspace">{t("settings.sandbox.workspaceRecommended")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label={t("settings.sandbox.network")} desc={t("settings.sandbox.networkDesc")}>
          <Select
            value={settings.network}
            onValueChange={(v) => save({ network: v as SandboxSettings["network"] })}
            items={[
              { value: "allow", label: t("settings.sandbox.allow") },
              { value: "deny", label: t("settings.sandbox.deny") },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">{t("settings.sandbox.allow")}</SelectItem>
              <SelectItem value="deny">{t("settings.sandbox.deny")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label={t("settings.sandbox.packageCaches")} desc={t("settings.sandbox.packageCachesDesc")}>
          <Switch
            checked={settings.allowPackageCaches}
            onCheckedChange={(v) => save({ allowPackageCaches: v })}
          />
        </SettingRow>

        <SettingRow label={t("settings.sandbox.unavailable")} desc={t("settings.sandbox.unavailableDesc")}>
          <Select
            value={settings.onUnavailable}
            onValueChange={(v) =>
              save({ onUnavailable: v as SandboxSettings["onUnavailable"] })
            }
            items={[
              { value: "deny", label: t("settings.sandbox.denyExecute") },
              { value: "allow", label: t("settings.sandbox.allowFallback") },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deny">{t("settings.sandbox.denyExecute")}</SelectItem>
              <SelectItem value="allow">{t("settings.sandbox.allowFallback")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <p className="text-muted-foreground text-[13px] leading-5">
        {t("settings.sandbox.footer")}
      </p>
    </section>
  );
};
