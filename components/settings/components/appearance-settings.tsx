"use client";

import { useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  setWindowEffect,
  useWindowEffect,
  type WindowEffectName,
} from "@/lib/appearance";
import { setUiPref, useUiPrefs, type AccentName } from "@/lib/ui-prefs";

/** 强调色预设：color 与 globals.css 中 :root[data-accent] 的 --primary 一致 */
const ACCENTS: { value: AccentName; label: string; color: string | null }[] = [
  { value: "default", label: "默认（单色）", color: null },
  { value: "blue", label: "蓝色", color: "oklch(0.55 0.22 257)" },
  { value: "violet", label: "紫色", color: "oklch(0.55 0.21 292)" },
  { value: "green", label: "绿色", color: "oklch(0.55 0.16 155)" },
  { value: "orange", label: "橙色", color: "oklch(0.62 0.18 55)" },
  { value: "rose", label: "玫红", color: "oklch(0.58 0.21 350)" },
];

const AccentPicker: FC<{ value: AccentName }> = ({ value }) => (
  <div className="flex shrink-0 items-center gap-1.5">
    {ACCENTS.map((accent) => {
      const active = accent.value === value;
      return (
        <button
          key={accent.value}
          type="button"
          title={accent.label}
          aria-label={accent.label}
          onClick={() => setUiPref("accent", accent.value)}
          className={cn(
            "size-5 rounded-full border border-black/10 transition-transform active:scale-90",
            active && "scale-110 outline-2 outline-offset-2 outline-primary",
          )}
          style={
            accent.color
              ? { background: accent.color }
              : {
                  background:
                    "linear-gradient(135deg, var(--color-foreground) 50%, var(--color-muted-foreground) 50%)",
                }
          }
        />
      );
    })}
  </div>
);

const EFFECT_OPTIONS: { value: WindowEffectName; label: string }[] = [
  { value: "none", label: "不透明" },
  { value: "acrylic", label: "高斯模糊" },
  { value: "mica", label: "Mica" },
];

/** 外观配置页：通用外观（主题/强调色/字号/对话宽度，localStorage 按客户端保存）
 *  + 桌面端外观（窗口背景材质，需 Rust 窗口能力）。版式对齐模型/远程访问页。 */
export const AppearanceSettings: FC = () => {
  const prefs = useUiPrefs();
  const desktop = isTauri();
  const effect = useWindowEffect();
  const [busy, setBusy] = useState<WindowEffectName | null>(null);

  const pickEffect = (value: WindowEffectName) => {
    if (value === effect || busy) return;
    setBusy(value);
    void setWindowEffect(value).finally(() => setBusy(null));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">外观</h1>

        {/* 界面：桌面端与远程网页端各自独立生效 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">界面</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="主题" desc="跟随系统，或固定浅色/深色">
              <Segmented
                value={prefs.theme}
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
                onChange={(v) => setUiPref("theme", v)}
              />
            </SettingRow>
            <SettingRow label="强调色" desc="按钮、高亮与选中的主色">
              <AccentPicker value={prefs.accent} />
            </SettingRow>
            <SettingRow label="字号" desc="整体缩放界面文字与元素">
              <Segmented
                value={prefs.fontSize}
                options={[
                  { value: "sm", label: "小" },
                  { value: "md", label: "标准" },
                  { value: "lg", label: "大" },
                ]}
                onChange={(v) => setUiPref("fontSize", v)}
              />
            </SettingRow>
            <SettingRow label="对话宽度" desc="消息内容区的最大宽度">
              <Segmented
                value={prefs.chatWidth}
                options={[
                  { value: "narrow", label: "窄" },
                  { value: "md", label: "默认" },
                  { value: "wide", label: "宽" },
                ]}
                onChange={(v) => setUiPref("chatWidth", v)}
              />
            </SettingRow>
          </div>
        </section>

        {/* 桌面端：窗口材质依赖 Tauri 能力，远程网页端隐藏整组 */}
        {desktop && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">桌面端</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="窗口背景"
                desc="半透明可透出桌面模糊背景，系统渲染、拖动可能轻微掉帧；Acrylic 需 Win10 1809+（macOS 映射系统材质），Mica 需 Win11，不支持时自动回退不透明"
              >
                <Segmented
                  value={effect}
                  options={EFFECT_OPTIONS}
                  onChange={pickEffect}
                  disabled={busy !== null}
                />
              </SettingRow>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
