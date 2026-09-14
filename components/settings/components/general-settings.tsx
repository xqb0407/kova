"use client";

import type { FC } from "react";
import { Button } from "@/components/ui/button";
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
import { AGENT_EVENT_REGISTRY } from "@/lib/agent-events";
import { previewSound, SOUND_PACKS } from "@/lib/sounds";
import { setUiPref, useUiPrefs, type SoundPackName } from "@/lib/ui-prefs";
import { PlayIcon } from "lucide-react";

/**
 * 通用设置页：提醒提示音。统一开关 + 两套内置音色整体切换，
 * 每事件试听、音量（Slider）、仅后台提醒。
 * Webhook 推送与最近推送记录在独立页（webhooks-settings）。
 */
export const GeneralSettings: FC = () => {
  const prefs = useUiPrefs();

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
            <SettingRow label="试听" desc="点击试听当前音色下各事件的提示音">
              <div className="flex items-center gap-1">
                {AGENT_EVENT_REGISTRY.map((entry) => (
                  <Button
                    key={entry.name}
                    size="sm"
                    variant="ghost"
                    disabled={!prefs.soundEnabled}
                    onClick={() => previewSound(entry.tone)}
                  >
                    <PlayIcon className="size-3" />
                    {entry.label}
                  </Button>
                ))}
              </div>
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
          </div>
        </section>
      </div>
    </div>
  );
};
