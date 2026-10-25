"use client";

import { useEffect, useState, type CSSProperties, type FC } from "react";
import { cn } from "@/lib/utils";
import { isDesktop } from "@/lib/desktop-env";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  setWindowEffect,
  useWindowEffect,
  type WindowEffectName,
} from "@/lib/settings/appearance";
import {
  isDarkMode,
  patchUiPrefs,
  selectThemePreset,
  setThemeOverride,
  setUiPref,
  useUiPrefs,
  type CodeThemeName,
  type FontSizeName,
} from "@/lib/settings/ui-prefs";
import { resolveBaseColors } from "@/lib/theme/palette";
import {
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  type CodeFontFamilyName,
  type FontFamilyName,
} from "@/lib/theme/fonts";
import { THEME_PRESETS } from "@/lib/theme/presets";
import type { ColorMode } from "@/lib/theme/types";
import { CODE_THEME_DARK_OPTIONS, CODE_THEME_LIGHT_OPTIONS } from "@/lib/markdown/code-theme";
import { Switch } from "@/components/ui/switch";
import { CodeThemePreview } from "./code-theme-preview";
import { AccentPicker } from "./theme/accent-picker";
import { ColorField } from "./theme/color-field";
import { ModeCards } from "./theme/mode-cards";
import { PresetPicker } from "./theme/preset-picker";
import { SliderField } from "./theme/slider-field";
import { ThemeIo } from "./theme/theme-io";
import { WallpaperSection } from "./theme/wallpaper-section";

/** 下拉通用件：受控回显用 children（Base UI 未打开过下拉时 value 不回显） */
function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  className,
  style,
}: {
  value: T;
  options: { value: T; label: string; stack?: string }[];
  onChange: (value: T) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger
        size="sm"
        className={cn("bg-background border", className)}
        style={style ?? (current?.stack ? { fontFamily: current.stack } : undefined)}
      >
        <SelectValue>{current?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            style={option.stack ? { fontFamily: option.stack } : undefined}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 代码主题下拉：浅/深两行共用 */
const CodeThemeSelect: FC<{
  value: CodeThemeName;
  options: { value: CodeThemeName; label: string }[];
  onChange: (value: CodeThemeName) => void;
}> = ({ value, options, onChange }) => (
  <Select value={value} onValueChange={(v) => v && onChange(v as CodeThemeName)}>
    <SelectTrigger size="sm" className="w-44 bg-background border">
      <SelectValue>{options.find((c) => c.value === value)?.label}</SelectValue>
    </SelectTrigger>
    <SelectContent align="end">
      {options.map((c) => (
        <SelectItem key={c.value} value={c.value}>
          {c.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const EFFECT_OPTIONS: { value: WindowEffectName; label: string }[] = [
  { value: "none", label: "不透明" },
  { value: "acrylic", label: "高斯模糊" },
  { value: "mica", label: "Mica" },
];

const UI_SIZE_OPTIONS: { value: FontSizeName; label: string }[] = [
  { value: "sm", label: "小" },
  { value: "md", label: "标准" },
  { value: "lg", label: "大" },
];

const CODE_SIZE_OPTIONS = Array.from({ length: 15 }, (_, index) => {
  const px = index + 10;
  return { value: String(px), label: px === 12 ? "标准（12px）" : `${px}px` };
});

/** 外观页：主题预设 / 壁纸 / 页面配色与排版 / 代码设置 / 窗口材质 / 导入导出 */
export const AppearanceSettings: FC = () => {
  const prefs = useUiPrefs();
  const preset = THEME_PRESETS[prefs.themePreset] ?? THEME_PRESETS.kova;
  const desktop = isDesktop();
  const effect = useWindowEffect();
  const [busy, setBusy] = useState<WindowEffectName | null>(null);
  const [editMode, setEditMode] = useState<ColorMode>(() =>
    isDarkMode(prefs) ? "dark" : "light",
  );

  // 切换明暗模式时，配色编辑器跟着当前实际显示的模式走；
  // 用户手动切到另一套编辑时不打扰（effectiveMode 没变，effect 不跑）
  const effectiveMode: ColorMode = isDarkMode(prefs) ? "dark" : "light";
  useEffect(() => {
    setEditMode(effectiveMode);
  }, [effectiveMode]);

  const override = prefs.themeOverrides[editMode] ?? {};
  const resolved = resolveBaseColors(prefs, editMode);
  const lightColors = resolveBaseColors(prefs, "light");
  const darkColors = resolveBaseColors(prefs, "dark");
  const customized =
    !!prefs.accentCustom ||
    (["light", "dark"] as const).some(
      (mode) => Object.keys(prefs.themeOverrides[mode] ?? {}).length > 0,
    );
  const accentCustomized = !!prefs.accentCustom;

  const pickEffect = (value: WindowEffectName) => {
    if (value === effect || busy) return;
    setBusy(value);
    void setWindowEffect(value).finally(() => setBusy(null));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">外观</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            主题、壁纸、配色与字体都可以单独调整，改动即时生效。
          </p>
        </div>

        {/* 主题：明暗模式 + 预设 + 强调色 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">主题</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">明暗模式</div>
                <div className="text-muted-foreground text-xs">
                  控制浅色、深色或跟随系统，适用于所有主题
                </div>
              </div>
              <ModeCards
                value={prefs.theme}
                light={lightColors}
                dark={darkColors}
                onChange={(theme) => setUiPref("theme", theme)}
              />
            </div>
            <SettingRow
              label="主题"
              desc="应用统一的界面配色、代码颜色与背景氛围"
            >
              <PresetPicker
                value={prefs.themePreset}
                customized={customized}
                onChange={selectThemePreset}
              />
            </SettingRow>
            <SettingRow
              label="强调色"
              desc="按钮、链接与选中状态的主色；可自定义任意颜色"
            >
              <AccentPicker
                value={prefs.accent}
                custom={prefs.accentCustom}
                presetAccent={preset.accent}
                onSelect={(accent) =>
                  patchUiPrefs({ accent, accentCustom: null })
                }
                onCustom={(hex) => patchUiPrefs({ accentCustom: hex })}
              />
            </SettingRow>
          </div>
        </section>

        <WallpaperSection />

        {/* 页面偏好：配色、字体、宽度、对比度、圆角 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">页面偏好</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="编辑配色"
              desc="前景/背景按模式各存一套；未覆盖的项跟随主题预设"
            >
              <Segmented
                value={editMode}
                options={[
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
                onChange={setEditMode}
              />
            </SettingRow>
            <SettingRow
              label="UI 字体"
              desc="调整界面基础字体与字号，不影响代码和内嵌内容"
            >
              <div className="flex items-center gap-2">
                <SimpleSelect<FontFamilyName>
                  value={prefs.fontFamily}
                  options={UI_FONT_OPTIONS}
                  onChange={(value) => setUiPref("fontFamily", value)}
                  className="w-36"
                />
                <SimpleSelect<FontSizeName>
                  value={prefs.fontSize}
                  options={UI_SIZE_OPTIONS}
                  onChange={(value) => setUiPref("fontSize", value)}
                  className="w-24"
                />
              </div>
            </SettingRow>
            <SettingRow
              label="代码字体"
              desc="调整代码片段、文件查看器、差异视图和终端的字体"
            >
              <div className="flex items-center gap-2">
                <SimpleSelect<CodeFontFamilyName>
                  value={prefs.codeFontFamily}
                  options={CODE_FONT_OPTIONS}
                  onChange={(value) => setUiPref("codeFontFamily", value)}
                  className="w-36"
                />
                <SimpleSelect
                  value={String(prefs.codeFontSize)}
                  options={CODE_SIZE_OPTIONS}
                  onChange={(value) =>
                    setUiPref("codeFontSize", Number.parseInt(value, 10))
                  }
                  className="w-36"
                />
              </div>
            </SettingRow>
            <SettingRow
              label="对话宽度"
              desc="控制聊天内容与输入框的列宽，100% 为平铺"
            >
              <SliderField
                min={40}
                max={100}
                value={prefs.chatWidth}
                onChange={(value) => setUiPref("chatWidth", value)}
                minLabel="标准"
                maxLabel="平铺"
                formatValue={(value) =>
                  value >= 100 ? "平铺" : `${value}%`
                }
              />
            </SettingRow>
            <SettingRow
              label="前景色"
              desc={`${editMode === "light" ? "浅色" : "深色"}模式的正文与主要图标`}
            >
              <ColorField
                value={resolved.foreground}
                overridden={!!override.foreground}
                onChange={(hex) =>
                  setThemeOverride(editMode, "foreground", hex)
                }
                onReset={() => setThemeOverride(editMode, "foreground", null)}
              />
            </SettingRow>
            <SettingRow
              label="背景色"
              desc={`${editMode === "light" ? "浅色" : "深色"}模式的页面与主要承载面`}
            >
              <ColorField
                value={resolved.background}
                overridden={!!override.background}
                onChange={(hex) =>
                  setThemeOverride(editMode, "background", hex)
                }
                onReset={() => setThemeOverride(editMode, "background", null)}
              />
            </SettingRow>
            <SettingRow
              label="页面对比度"
              desc="调整描边、悬停与控件层级的视觉强度"
            >
              <SliderField
                min={0}
                max={100}
                value={prefs.contrast}
                onChange={(value) => setUiPref("contrast", value)}
                minLabel="柔和"
                maxLabel="强烈"
                formatValue={(value) => (value === 50 ? "默认" : `${value}`)}
              />
            </SettingRow>
            <SettingRow
              label="圆角"
              desc={
                prefs.radius === null
                  ? "跟随主题预设；拖动后改为自定义"
                  : "自定义圆角半径"
              }
            >
              <div className="flex items-center gap-2">
                {prefs.radius !== null && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs"
                    onClick={() => setUiPref("radius", null)}
                  >
                    重置
                  </button>
                )}
                <SliderField
                  min={0}
                  max={24}
                  value={prefs.radius ?? preset.radius}
                  onChange={(value) => setUiPref("radius", value)}
                  minLabel="直角"
                  maxLabel="圆润"
                  formatValue={(value) => `${Math.round(value)}px`}
                />
              </div>
            </SettingRow>
            {accentCustomized && (
              <div className="text-muted-foreground px-3 pb-1 text-xs">
                正在使用自定义强调色 {prefs.accentCustom}，点击强调色色点可恢复预设。
              </div>
            )}
          </div>
        </section>

        {/* 代码设置：CodeMirror / diff 渲染参数，独立于界面字号 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">代码设置</h2>
          <p className="text-muted-foreground text-sm">
            设置代码内容的主题和显示方式，不受界面字号影响。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="浅色代码主题" desc="浅色界面下代码内容使用的高亮主题。">
              <CodeThemeSelect
                value={prefs.codeThemeLight}
                options={CODE_THEME_LIGHT_OPTIONS}
                onChange={(v) => setUiPref("codeThemeLight", v)}
              />
            </SettingRow>
            <SettingRow label="深色代码主题" desc="深色界面下代码内容使用的高亮主题。">
              <CodeThemeSelect
                value={prefs.codeThemeDark}
                options={CODE_THEME_DARK_OPTIONS}
                onChange={(v) => setUiPref("codeThemeDark", v)}
              />
            </SettingRow>
            <SettingRow label="显示行号" desc="在代码内容和差异视图中显示行号。">
              <Switch
                checked={prefs.codeLineNumbers}
                onCheckedChange={(c) => setUiPref("codeLineNumbers", c)}
              />
            </SettingRow>
            <SettingRow label="长行自动换行" desc="代码内容过长时自动换行。">
              <Switch
                checked={prefs.codeWrap}
                onCheckedChange={(c) => setUiPref("codeWrap", c)}
              />
            </SettingRow>
          </div>
        </section>

        {/* 代码预览：浅深两套并排实时渲染，当前生效的一侧标记 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">代码预览</h2>
          <p className="text-muted-foreground text-sm">
            同时预览浅色与深色代码主题，当前界面使用的主题会标记为“当前生效”。
          </p>
          <CodeThemePreview />
        </section>

        {/* 桌面端：窗口材质依赖桌面壳能力，远程网页端隐藏整组 */}
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

        <ThemeIo />
      </div>
    </div>
  );
};
