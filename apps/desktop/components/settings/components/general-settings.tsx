"use client";

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
import { Button } from "@/components/ui/button";
import { useOnboardingGate } from "@/components/onboarding/onboarding-provider";
import { useEnsureUiDesignPlugin } from "@/components/design-mode-gate";
import {
  ATTACHMENT_RETENTION_OPTIONS,
  setAttachmentRetentionDays,
  useAttachmentRetentionDays,
} from "@/lib/attachments/attachment-retention";
import { setAppMode, useAppMode, useAppModeDegraded, type AppMode } from "@/lib/pi/app-mode";
import { setGpuAccelEnabled, useGpuAccelEnabled } from "@/lib/settings/gpu-accel";
import { SOUND_PACKS } from "@/lib/notify/sounds";
import { isTauri, isWindowsPlatform } from "@/lib/tauri";
import { setUiPref, useUiPrefs, type SoundPackName } from "@/lib/settings/ui-prefs";

/**
 * 通用设置页：提醒提示音与弹窗通知。统一开关 + 两套内置音色整体切换，
 * 音量（Slider）、仅后台提醒；另有渲染区块（Chrome 硬件加速，仅 Win 桌面端）。
 * 文生图配置在模型配置页（model-settings）；智能体本机能力（浏览器驱动等）在独立页（computer-control-settings）。
 * Webhook 推送与最近推送记录在独立页（webhooks-settings）。
 */
export const GeneralSettings: FC = () => {
  const prefs = useUiPrefs();
  const gpuAccel = useGpuAccelEnabled();
  const retentionDays = useAttachmentRetentionDays();
  const appMode = useAppMode();
  const appModeDegraded = useAppModeDegraded();
  const { ensure: ensureUiDesign, dialog: uiDesignGateDialog } =
    useEnsureUiDesignPlugin();
  const { reopen: reopenOnboarding } = useOnboardingGate();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {uiDesignGateDialog}
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">通用</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">工作模式</h2>
          <p className="text-muted-foreground text-sm">
            默认模式：新对话，以及从未在顶栏单独切过档的会话跟随这里；单独切过档的会话保持自己的档。与输入框旁的权限模式（确认/自动/计划）互不影响。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="默认模式"
              desc={
                appModeDegraded
                  ? "当前 sidecar 版本不支持，切换仅影响界面，提示词不跟随"
                  : appMode === "work"
                    ? "面向日常办公：交付导向的回复风格，隐藏 Git 管理界面，消息里的工具步骤收敛为摘要"
                    : appMode === "design"
                      ? "面向 UI 设计：设计稿（ui-design 面板）与高保真原型优先，隐藏 Git 管理界面"
                      : "面向开发：完整工具与细节（Git 管理、可展开的工具输出）"
              }
            >
              <Select
                value={appMode}
                onValueChange={(v) => {
                  const mode = v as AppMode;
                  // 设计档前置门禁：ui-design 插件未装/禁用时弹窗引导，通过才切档
                  if (mode === "design") {
                    void (async () => {
                      if (await ensureUiDesign()) await setAppMode("design");
                    })();
                    return;
                  }
                  void setAppMode(mode);
                }}
                items={[
                  { value: "code", label: "编码（默认）" },
                  { value: "work", label: "工作" },
                  { value: "design", label: "设计" },
                ]}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">编码（默认）</SelectItem>
                  <SelectItem value="work">工作</SelectItem>
                  <SelectItem value="design">设计</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">提醒</h2>
          <p className="text-muted-foreground text-sm">
            任务完成、等待审批、出错等节点播放提示音，无需盯着窗口。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="提示音" desc="总开关，统一控制所有事件">
              <Switch
                checked={prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundEnabled", v)}
              />
            </SettingRow>
            <SettingRow label="音色" desc="内置两套音色，整体切换">
              <Select
                value={prefs.soundPack}
                onValueChange={(v) => setUiPref("soundPack", v as SoundPackName)}
                items={SOUND_PACKS}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_PACKS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="音量" desc="提示音大小">
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
                <span className="text-muted-foreground w-8 text-right text-xs tabular-nums">
                  {Math.round(prefs.soundVolume * 100)}
                </span>
              </div>
            </SettingRow>
            <SettingRow
              label="仅后台提醒"
              desc="窗口在前台时不播放——前台看得见，不必吵"
            >
              <Switch
                checked={prefs.soundOnlyUnfocused}
                disabled={!prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundOnlyUnfocused", v)}
              />
            </SettingRow>
            <SettingRow
              label="弹窗通知"
              desc="窗口不在前台时弹出系统桌面通知（Win/macOS，仅桌面端生效）"
            >
              <Switch
                checked={prefs.popupEnabled}
                onCheckedChange={(v) => setUiPref("popupEnabled", v)}
              />
            </SettingRow>
          </div>
        </section>

        {/* 附件中转缓存仅桌面端存在（粘贴的文档中转落盘）；网页端无本地 FS */}
        {isTauri() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">附件</h2>
            <p className="text-muted-foreground text-sm">
              粘贴的文档会暂存到本地缓存目录供智能体读取，超期自动清理。
            </p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="粘贴文件保留期限"
                desc="超期后自动删除；选「不清理」则一直保留，需自行管理磁盘占用"
              >
                <Select
                  value={String(retentionDays)}
                  onValueChange={(v) => void setAttachmentRetentionDays(Number(v))}
                  items={ATTACHMENT_RETENTION_OPTIONS.map((o) => ({
                    value: String(o.value),
                    label: o.label,
                  }))}
                >
                  <SelectTrigger size="sm" className="w-44 border bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ATTACHMENT_RETENTION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>
          </section>
        )}

        {/* WebView2 专属参数，远程网页端与 macOS 均无可调项，仅 Win 桌面端展示 */}
        {isTauri() && isWindowsPlatform() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">渲染</h2>
            <p className="text-muted-foreground text-sm">桌面端渲染兼容性选项。</p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="Chrome 硬件加速"
                desc="关闭后可规避部分显卡或驱动导致的白屏、闪退、渲染异常。修改后需重启应用生效。"
              >
                <Switch
                  checked={gpuAccel}
                  onCheckedChange={(v) => void setGpuAccelEnabled(v)}
                />
              </SettingRow>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">入门</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="重新查看新手引导"
              desc="重走一遍首次启动的配置向导，不会覆盖已保存的设置"
            >
              <Button
                variant="outline"
                size="sm"
                className="w-44"
                onClick={reopenOnboarding}
              >
                查看引导
              </Button>
            </SettingRow>
          </div>
        </section>
      </div>
    </div>
  );
};
