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
  FONT_SIZE_PX,
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
import { useT } from "@/lib/i18n";

/** 字体下拉里需要翻译的档位（其余为字体专名，原样展示） */
const FONT_LABEL_KEYS: Record<string, string> = {
  default: "settings.appearance.fontFollowTheme",
  theme: "settings.appearance.fontFollowTheme",
  yahei: "settings.appearance.fontMicrosoftYaHei",
  "noto-sans-sc": "settings.appearance.fontNotoSans",
  serif: "settings.appearance.fontSerif",
  "noto-serif-sc": "settings.appearance.fontNotoSerif",
  kai: "settings.appearance.fontKai",
  wenkai: "settings.appearance.fontWenkai",
  mono: "settings.appearance.fontMono",
};

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

const EFFECT_OPTIONS: { value: WindowEffectName; labelKey?: string; label?: string }[] = [
  { value: "none", labelKey: "settings.appearance.effectNone" },
  { value: "acrylic", labelKey: "settings.appearance.effectAcrylic" },
  { value: "mica", label: "Mica" },
];

const UI_SIZE_OPTIONS: { value: FontSizeName; labelKey: string }[] = [
  { value: "sm", labelKey: "settings.appearance.sizeSmall" },
  { value: "md", labelKey: "settings.appearance.sizeStandard" },
  { value: "lg", labelKey: "settings.appearance.sizeLarge" },
];

const CODE_SIZE_OPTIONS = Array.from({ length: 14 }, (_, index) => {
  const px = index + 11;
  return {
    value: String(px),
    label: px === 12 ? "settings.appearance.codeSizeStandard" : `${px}px`,
    isKey: px === 12,
  };
});

/** 外观页：主题预设 / 壁纸 / 页面配色与排版 / 代码设置 / 窗口材质 / 导入导出 */
export const AppearanceSettings: FC = () => {
  const t = useT();
  const prefs = useUiPrefs();
  const preset = THEME_PRESETS[prefs.themePreset] ?? THEME_PRESETS.kova;
  const desktop = isDesktop();
  const effect = useWindowEffect();
  const [busy, setBusy] = useState<WindowEffectName | null>(null);
  const [editMode, setEditMode] = useState<ColorMode>(() =>
    isDarkMode(prefs) ? "dark" : "light",
  );
  // 字体下拉：需要翻译的档位映射成词典，其余专名原样（t 未命中时返回入参本身）
  const uiFontOptions = UI_FONT_OPTIONS.map((o) => ({
    ...o,
    label: FONT_LABEL_KEYS[o.value] ? t(FONT_LABEL_KEYS[o.value]!) : o.label,
  }));
  const codeFontOptions = CODE_FONT_OPTIONS.map((o) => ({
    ...o,
    label: FONT_LABEL_KEYS[o.value] ? t(FONT_LABEL_KEYS[o.value]!) : o.label,
  }));
  const uiSizeOptions = UI_SIZE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }));
  const effectOptions = EFFECT_OPTIONS.map((o) => ({
    value: o.value,
    label: o.labelKey ? t(o.labelKey) : (o.label ?? o.value),
  }));
  const codeSizeOptions = CODE_SIZE_OPTIONS.map((o) => ({
    value: o.value,
    label: o.isKey ? t(o.label) : o.label,
  }));

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
    void setWindowEffect(value)
      .catch((error) => {
        // Win10 / Win11 21H2 等不支持 setBackgroundMaterial 的平台会拒绝：
        // 保持原来的不透明外观，不要把 rejection 漏成 unhandledrejection
        console.warn("[appearance] 窗口材质不可用，已回退不透明:", error);
      })
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.appearance.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("settings.appearance.subtitle")}
          </p>
        </div>

        {/* 主题：明暗模式 + 预设 + 强调色 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.appearance.themeTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("settings.appearance.modeLabel")}</div>
                <div className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.appearance.modeDesc")}
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
              label={t("settings.appearance.presetLabel")}
              desc={t("settings.appearance.presetDesc")}
            >
              <PresetPicker
                value={prefs.themePreset}
                customized={customized}
                onChange={selectThemePreset}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.accentLabel")}
              desc={t("settings.appearance.accentDesc")}
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
          <h2 className="text-base font-semibold">{t("settings.appearance.pagePrefsTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.appearance.editColors")}
              desc={t("settings.appearance.editColorsDesc")}
            >
              <Segmented
                value={editMode}
                options={[
                  { value: "light", label: t("settings.appearance.light") },
                  { value: "dark", label: t("settings.appearance.dark") },
                ]}
                onChange={setEditMode}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.uiFont")}
              desc={t("settings.appearance.uiFontDesc")}
            >
              <div className="flex items-center gap-2">
                <SimpleSelect<FontFamilyName>
                  value={prefs.fontFamily}
                  options={uiFontOptions}
                  onChange={(value) => setUiPref("fontFamily", value)}
                  className="w-36"
                />
                <SimpleSelect<FontSizeName>
                  value={prefs.fontSize}
                  options={uiSizeOptions}
                  onChange={(value) => setUiPref("fontSize", value)}
                  className="w-24"
                />
              </div>
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.codeFont")}
              desc={t("settings.appearance.codeFontDesc")}
            >
              <div className="flex items-center gap-2">
                <SimpleSelect<CodeFontFamilyName>
                  value={prefs.codeFontFamily}
                  options={codeFontOptions}
                  onChange={(value) => setUiPref("codeFontFamily", value)}
                  className="w-36"
                />
                <SimpleSelect
                  value={String(prefs.codeFontSize)}
                  options={codeSizeOptions}
                  onChange={(value) =>
                    setUiPref("codeFontSize", Number.parseInt(value, 10))
                  }
                  className="w-36"
                />
              </div>
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.chatWidth")}
              desc={t("settings.appearance.chatWidthDesc")}
            >
              <SliderField
                min={40}
                max={100}
                value={prefs.chatWidth}
                onChange={(value) => setUiPref("chatWidth", value)}
                minLabel={t("settings.appearance.narrow")}
                maxLabel={t("settings.appearance.fill")}
                formatValue={(value) =>
                  value >= 100
                    ? t("settings.appearance.fillValue")
                    : `${Math.round(value * FONT_SIZE_PX[prefs.fontSize])}px`
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.foreground")}
              desc={t("settings.appearance.foregroundDesc", {
                mode: editMode === "light" ? t("settings.appearance.light") : t("settings.appearance.dark"),
              })}
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
              label={t("settings.appearance.background")}
              desc={t("settings.appearance.backgroundDesc", {
                mode: editMode === "light" ? t("settings.appearance.light") : t("settings.appearance.dark"),
              })}
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
              label={t("settings.appearance.contrast")}
              desc={t("settings.appearance.contrastDesc")}
            >
              <SliderField
                min={0}
                max={100}
                value={prefs.contrast}
                onChange={(value) => setUiPref("contrast", value)}
                minLabel={t("settings.appearance.soft")}
                maxLabel={t("settings.appearance.strong")}
                formatValue={(value) => (value === 50 ? t("settings.appearance.defaultValue") : `${value}`)}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.appearance.radius")}
              desc={
                prefs.radius === null
                  ? t("settings.appearance.radiusFollow")
                  : t("settings.appearance.radiusCustom")
              }
            >
              <div className="flex items-center gap-2">
                {prefs.radius !== null && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-[13px] leading-5"
                    onClick={() => setUiPref("radius", null)}
                  >
                    {t("settings.appearance.reset")}
                  </button>
                )}
                <SliderField
                  min={0}
                  max={24}
                  value={prefs.radius ?? preset.radius}
                  onChange={(value) => setUiPref("radius", value)}
                  minLabel={t("settings.appearance.square")}
                  maxLabel={t("settings.appearance.rounded")}
                  formatValue={(value) => `${Math.round(value)}px`}
                />
              </div>
            </SettingRow>
            {accentCustomized && (
              <div className="text-muted-foreground px-3 pb-1 text-[13px] leading-5">
                {t("settings.appearance.accentCustomNote", { color: prefs.accentCustom ?? "" })}
              </div>
            )}
          </div>
        </section>

        {/* 代码设置：CodeMirror / diff 渲染参数，独立于界面字号 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.appearance.codeTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.appearance.codeLightTheme")} desc={t("settings.appearance.codeLightThemeDesc")}>
              <CodeThemeSelect
                value={prefs.codeThemeLight}
                options={CODE_THEME_LIGHT_OPTIONS}
                onChange={(v) => setUiPref("codeThemeLight", v)}
              />
            </SettingRow>
            <SettingRow label={t("settings.appearance.codeDarkTheme")} desc={t("settings.appearance.codeDarkThemeDesc")}>
              <CodeThemeSelect
                value={prefs.codeThemeDark}
                options={CODE_THEME_DARK_OPTIONS}
                onChange={(v) => setUiPref("codeThemeDark", v)}
              />
            </SettingRow>
            <SettingRow label={t("settings.appearance.lineNumbers")} desc={t("settings.appearance.lineNumbersDesc")}>
              <Switch
                checked={prefs.codeLineNumbers}
                onCheckedChange={(c) => setUiPref("codeLineNumbers", c)}
              />
            </SettingRow>
            <SettingRow label={t("settings.appearance.wrap")} desc={t("settings.appearance.wrapDesc")}>
              <Switch
                checked={prefs.codeWrap}
                onCheckedChange={(c) => setUiPref("codeWrap", c)}
              />
            </SettingRow>
          </div>
        </section>

        {/* 代码预览：浅深两套并排实时渲染，当前生效的一侧标记 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.appearance.codePreviewTitle")}</h2>
          <CodeThemePreview />
        </section>

        {/* 桌面端：窗口材质依赖桌面壳能力，远程网页端隐藏整组 */}
        {desktop && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.appearance.desktopTitle")}</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.appearance.windowBg")}
                desc={t("settings.appearance.windowBgDesc")}
              >
                <Segmented
                  value={effect}
                  options={effectOptions}
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
