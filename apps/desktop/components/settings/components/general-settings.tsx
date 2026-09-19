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
import {
  ATTACHMENT_RETENTION_OPTIONS,
  setAttachmentRetentionDays,
  useAttachmentRetentionDays,
} from "@/lib/attachment-retention";
import { setGpuAccelEnabled, useGpuAccelEnabled } from "@/lib/gpu-accel";
import { SOUND_PACKS } from "@/lib/sounds";
import { isTauri, isWindowsPlatform } from "@/lib/tauri";
import { setUiPref, useUiPrefs, type SoundPackName } from "@/lib/ui-prefs";

/**
 * 通用设置页：提醒提示音与弹窗通知。统一开关 + 两套内置音色整体切换，
 * 音量（Slider）、仅后台提醒；另有渲染区块（Chrome 硬件加速，仅 Win 桌面端）。
 * 智能体本机能力（浏览器驱动等）在独立页（computer-control-settings）。
 * Webhook 推送与最近推送记录在独立页（webhooks-settings）。
 */
export const GeneralSettings: FC = () => {
  const prefs = useUiPrefs();
  const gpuAccel = useGpuAccelEnabled();
  const retentionDays = useAttachmentRetentionDays();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">通用</h1>
        </div>

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
      </div>
    </div>
  );
};
