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

/**
 * 沙箱区块（设置 → 智能体 → 智能体配置）。
 *
 * V1 只有“写隔离”一档：macOS 的 bash 走 Seatbelt；Windows 只校验
 * read/write/edit/http，bash 暂无 OS 沙箱（这里如实标注，不假装已隔离）。
 */
export const SandboxSettingsPanel: FC = () => {
  const settings = useSandboxSettings();

  const save = (patch: Partial<SandboxSettings>) => {
    saveSandboxSettings({ ...settings, ...patch }).catch(() =>
      toast.error("保存失败，请重试"),
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        沙箱
      </h2>
      <p className="text-muted-foreground text-sm">
        限制 Agent 能写到哪里。工作区档只允许写工作区、项目外部目录、本机 write roots
        和包缓存；读取除高危凭据目录外放行。
      </p>

      <div className="bg-muted/50 divide-none mt-1 flex flex-col divide-y rounded-2xl p-2">
        <SettingRow
          label="档位"
          desc="关闭 = 不校验；工作区 = 写隔离（推荐）。"
        >
          <Select
            value={settings.tier}
            onValueChange={(v) => save({ tier: v as SandboxSettings["tier"] })}
            items={[
              { value: "off", label: "关闭" },
              { value: "workspace", label: "工作区（推荐）" },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">关闭</SelectItem>
              <SelectItem value="workspace">工作区（推荐）</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="网络"
          desc="禁止后 bash 与 WebFetch/WebSearch 都不能联网；工作区档默认允许。"
        >
          <Select
            value={settings.network}
            onValueChange={(v) => save({ network: v as SandboxSettings["network"] })}
            items={[
              { value: "allow", label: "允许" },
              { value: "deny", label: "禁止" },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">允许</SelectItem>
              <SelectItem value="deny">禁止</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="包缓存"
          desc="允许 npm/pnpm/cargo 等写自己的缓存目录；关闭后安装可能失败。"
        >
          <Switch
            checked={settings.allowPackageCaches}
            onCheckedChange={(v) => save({ allowPackageCaches: v })}
          />
        </SettingRow>

        <SettingRow
          label="沙箱不可用"
          desc="macOS Seatbelt 缺失时：拒绝执行，或按无沙箱路径执行。Windows 的 bash 目前固定走无沙箱路径。"
        >
          <Select
            value={settings.onUnavailable}
            onValueChange={(v) =>
              save({ onUnavailable: v as SandboxSettings["onUnavailable"] })
            }
            items={[
              { value: "deny", label: "拒绝执行" },
              { value: "allow", label: "允许降级" },
            ]}
          >
            <SelectTrigger size="sm" className="w-44 border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deny">拒绝执行</SelectItem>
              <SelectItem value="allow">允许降级</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <p className="text-muted-foreground text-xs">
        macOS：bash 由 Seatbelt 做写隔离。Windows：read/write/edit/http 受校验，
        bash 暂无 OS 沙箱。Linux：V1 不支持。
      </p>
    </section>
  );
};
