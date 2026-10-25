"use client";

import { useSyncExternalStore } from "react";
import { normalizeHex } from "../theme/color";
import {
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  type CodeFontFamilyName,
  type FontFamilyName,
} from "../theme/fonts";
import {
  buildBootCache,
  resolveFonts,
  resolveTheme,
  wallpaperVeil,
  type ThemeInput,
  type ThemeTokens,
} from "../theme/palette";
import {
  ACCENT_VALUES,
  THEME_PRESETS,
  THEME_PRESET_IDS,
} from "../theme/presets";
import type {
  AccentName,
  PaletteOverride,
  ThemePresetName,
  WallpaperConfig,
  WallpaperMode,
} from "../theme/types";
import {
  WALLPAPER_IMAGE_KEY,
  clearWallpaperImages,
  getWallpaperImage,
  invalidateWallpaperImageCache,
} from "../theme/wallpaper";

export type {
  AccentName,
  CodeFontFamilyName,
  FontFamilyName,
  ThemePresetName,
  WallpaperConfig,
  WallpaperMode,
};

/**
 * 界面外观偏好（主题/强调色/字号/对话宽度/壁纸）：
 * 持久化于 localStorage，按客户端各自保存——桌面 WebView 与远程网页互不影响。
 * 生效链路：layout.tsx 预绘制脚本先行应用 ui.theme.cache（防 FOUC），
 * 本模块在 client bundle 加载时接管（initUiPrefs），负责读回数据、派生 CSS
 * 变量、跟随系统主题监听与设置页的响应式更新。
 * 注意：预绘制脚本的字段/键名需与本文件的 cache 结构保持一致。
 * 窗口背景材质不在此列——需 Rust 侧启动恢复，持久化于 SQLite kv（lib/appearance.ts）。
 */
export type ThemeMode = "system" | "light" | "dark";
export type FontSizeName = "sm" | "md" | "lg";
/** 兼容旧值的对话宽度档位；现在存百分比数字 */
export type ChatWidthName = "narrow" | "md" | "wide";
/** 提示音音色包（lib/sounds.ts TONE_PACKS 的索引） */
export type SoundPackName = "crisp" | "calm";
/** 代码主题档位（面板 diff 用 @pierre/diffs、代码预览用 CodeMirror，共用映射；浅深分开配置） */
export type CodeThemeName = "default" | "vscode" | "idea";

export type UiPrefs = {
  theme: ThemeMode;
  themePreset: ThemePresetName;
  /** 每个模式下的自定义前景/背景；缺省字段沿用预设 */
  themeOverrides: Record<"light" | "dark", PaletteOverride>;
  accent: AccentName;
  /** 任意 hex 强调色；非空时优先于 accent */
  accentCustom: string | null;
  /** 页面对比度 0–100（50 = 默认） */
  contrast: number;
  /** 圆角 px；null = 跟随主题预设 */
  radius: number | null;
  fontSize: FontSizeName;
  /** 对话内容区宽度：百分比（40–100），100 = 平铺 */
  chatWidth: number;
  fontFamily: FontFamilyName;
  codeFontFamily: CodeFontFamilyName;
  codeThemeLight: CodeThemeName;
  codeThemeDark: CodeThemeName;
  codeLineNumbers: boolean;
  codeWrap: boolean;
  /** 代码字号（px）：独立于界面字号档位 */
  codeFontSize: number;
  wallpaper: WallpaperConfig | null;
  /** 提示音总开关（lib/sounds.ts 消费，统一控制所有事件） */
  soundEnabled: boolean;
  /** 音色包：crisp=清脆 / calm=沉稳，整体切换 */
  soundPack: SoundPackName;
  /** 仅后台提醒：窗口有焦点时不响（前台看得见，不必吵） */
  soundOnlyUnfocused: boolean;
  /** 音量 0–1 */
  soundVolume: number;
  /** 弹窗通知：窗口失焦时发系统桌面通知（lib/popup.ts 消费，桌面端专属） */
  popupEnabled: boolean;
};

export const UI_PREFS_KEY = "ui.prefs";
/** 预绘制缓存：两套模式的 CSS 变量表 + 非令牌字段 */
export const UI_THEME_CACHE_KEY = "ui.theme.cache";

export const DEFAULT_PREFS: UiPrefs = {
  theme: "system",
  themePreset: "kova",
  themeOverrides: { light: {}, dark: {} },
  accent: "default",
  accentCustom: null,
  contrast: 50,
  radius: null,
  fontSize: "md",
  chatWidth: 52,
  fontFamily: "default",
  codeFontFamily: "theme",
  codeThemeLight: "default",
  codeThemeDark: "default",
  codeLineNumbers: true,
  codeWrap: false,
  codeFontSize: 12,
  wallpaper: null,
  soundEnabled: true,
  soundPack: "crisp",
  soundOnlyUnfocused: false,
  soundVolume: 0.6,
  popupEnabled: false,
};

/** 字号档位 → 根元素 font-size（rem 体系下等比缩放整体界面）；md 为浏览器默认 16px */
const FONT_SIZE_PX: Record<Exclude<FontSizeName, "md">, string> = {
  sm: "15px",
  lg: "17px",
};

/** 旧版三档宽度 → 百分比（升级时一次性迁移） */
const LEGACY_CHAT_WIDTH: Record<ChatWidthName, number> = {
  narrow: 44,
  md: 52,
  wide: 66,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

const oneOf = <T extends string>(
  values: readonly T[],
  raw: unknown,
  fallback: T,
): T => (typeof raw === "string" && values.includes(raw as T) ? (raw as T) : fallback);

function sanitizeOverride(raw: unknown): PaletteOverride {
  if (!isRecord(raw)) return {};
  const out: PaletteOverride = {};
  const background =
    typeof raw.background === "string" ? normalizeHex(raw.background) : null;
  const foreground =
    typeof raw.foreground === "string" ? normalizeHex(raw.foreground) : null;
  if (background) out.background = background;
  if (foreground) out.foreground = foreground;
  return out;
}

function sanitizeWallpaper(raw: unknown): WallpaperConfig | null {
  if (!isRecord(raw)) return null;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    enabled: raw.enabled !== false,
    opacity: clamp(num(raw.opacity, 100), 0, 100),
    blur: clamp(num(raw.blur, 0), 0, 40),
    dim: clamp(num(raw.dim, 20), 0, 80),
    mode: oneOf<WallpaperMode>(["both", "light", "dark"], raw.mode, "both"),
  };
}

/** 旧数据 → 当前形状：补默认值、迁移 chatWidth、过滤非法颜色/枚举 */
export function migratePrefs(raw: unknown): UiPrefs {
  const source = isRecord(raw) ? raw : {};
  const legacyWidth =
    typeof source.chatWidth === "string"
      ? (LEGACY_CHAT_WIDTH[source.chatWidth as ChatWidthName] ?? 52)
      : undefined;
  const chatWidth =
    typeof source.chatWidth === "number"
      ? source.chatWidth
      : (legacyWidth ?? DEFAULT_PREFS.chatWidth);
  const overrides = isRecord(source.themeOverrides) ? source.themeOverrides : {};
  const fontSize = oneOf<FontSizeName>(["sm", "md", "lg"], source.fontSize, "md");
  const codeTheme = ["default", "vscode", "idea"] as const;
  return {
    ...DEFAULT_PREFS,
    theme: oneOf<ThemeMode>(["system", "light", "dark"], source.theme, "system"),
    themePreset: oneOf<ThemePresetName>(
      THEME_PRESET_IDS,
      source.themePreset,
      "kova",
    ),
    themeOverrides: {
      light: sanitizeOverride(overrides.light),
      dark: sanitizeOverride(overrides.dark),
    },
    accent: oneOf<AccentName>(ACCENT_VALUES, source.accent, "default"),
    accentCustom:
      typeof source.accentCustom === "string"
        ? normalizeHex(source.accentCustom)
        : null,
    contrast:
      typeof source.contrast === "number"
        ? clamp(source.contrast, 0, 100)
        : 50,
    radius:
      typeof source.radius === "number" ? clamp(source.radius, 0, 24) : null,
    fontSize,
    chatWidth: clamp(chatWidth, 40, 100),
    fontFamily: oneOf<FontFamilyName>(
      UI_FONT_OPTIONS.map((o) => o.value),
      source.fontFamily,
      "default",
    ),
    codeFontFamily: oneOf<CodeFontFamilyName>(
      CODE_FONT_OPTIONS.map((o) => o.value),
      source.codeFontFamily,
      "theme",
    ),
    codeThemeLight: oneOf<CodeThemeName>(codeTheme, source.codeThemeLight, "default"),
    codeThemeDark: oneOf<CodeThemeName>(codeTheme, source.codeThemeDark, "default"),
    codeLineNumbers: typeof source.codeLineNumbers === "boolean" ? source.codeLineNumbers : true,
    codeWrap: typeof source.codeWrap === "boolean" ? source.codeWrap : false,
    codeFontSize:
      typeof source.codeFontSize === "number"
        ? clamp(source.codeFontSize, 10, 24)
        : 12,
    wallpaper: sanitizeWallpaper(source.wallpaper),
    soundEnabled: source.soundEnabled !== false,
    soundPack: oneOf<SoundPackName>(["crisp", "calm"], source.soundPack, "crisp"),
    soundOnlyUnfocused: source.soundOnlyUnfocused === true,
    soundVolume:
      typeof source.soundVolume === "number" ? clamp(source.soundVolume, 0, 1) : 0.6,
    popupEnabled: source.popupEnabled === true,
  };
}

let prefs: UiPrefs = { ...DEFAULT_PREFS };
const listeners = new Set<() => void>();
let initialized = false;
/** undefined = 还没从 localStorage 读；null = 确认没有壁纸 */
let wallpaperImage: string | null | undefined;

const systemDark = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export function isDarkMode(p: UiPrefs = prefs): boolean {
  return p.theme === "dark" || (p.theme === "system" && systemDark());
}

function ensureWallpaperLoaded(): string | null {
  if (wallpaperImage === undefined) wallpaperImage = getWallpaperImage();
  return wallpaperImage;
}

function modeOf(p: UiPrefs): "light" | "dark" {
  return isDarkMode(p) ? "dark" : "light";
}

function wallpaperActiveFor(p: UiPrefs, mode: "light" | "dark"): boolean {
  const wallpaper = p.wallpaper;
  if (!wallpaper?.enabled) return false;
  if (wallpaper.mode !== "both" && wallpaper.mode !== mode) return false;
  return !!ensureWallpaperLoaded();
}

/** 供 palette 的输入形状（把 ui-prefs 的字段映射过去） */
function themeInput(p: UiPrefs): ThemeInput {
  return {
    themePreset: p.themePreset,
    themeOverrides: p.themeOverrides,
    accent: p.accent,
    accentCustom: p.accentCustom,
    contrast: p.contrast,
    radius: p.radius,
    fontFamily: p.fontFamily,
    codeFontFamily: p.codeFontFamily,
    wallpaper: p.wallpaper,
  };
}

/** 上次写入的 token：滑杆逐帧变化时只写真正变了的变量 */
let appliedTokens: Record<string, string> = {};

function applyTokens(root: HTMLElement, tokens: ThemeTokens): void {
  for (const [key, value] of Object.entries(tokens)) {
    if (appliedTokens[key] !== value) {
      root.style.setProperty(key, value);
      appliedTokens[key] = value;
    }
  }
}

/** 上次写进 DOM 的壁纸图：dataURL 很大，不能每帧重设 */
let appliedWallpaperImage: string | null = null;

/** 把两套模式的令牌与非令牌字段写进缓存，供 layout 预绘制脚本直接套用 */
function writeBootCache(p: UiPrefs): void {
  try {
    const hasWallpaper = !!ensureWallpaperLoaded();
    const cache = buildBootCache({
      ...themeInput(p),
      wallpaper: hasWallpaper ? p.wallpaper : null,
      fontSize: p.fontSize === "md" ? null : FONT_SIZE_PX[p.fontSize],
      chatWidth: p.chatWidth,
    });
    window.localStorage.setItem(UI_THEME_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 存储不可用时下一帧由 initUiPrefs 重新计算
  }
}

/** 将偏好落到 html 根元素：.dark 类 / CSS 变量 / 字体 / 宽度 / 壁纸 */
export function applyPrefs(p: UiPrefs) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mode = modeOf(p);
  const dark = mode === "dark";
  const wallpaperActive = wallpaperActiveFor(p, mode);
  const wallpaper = p.wallpaper;

  root.classList.toggle("dark", dark);
  if (root.style.colorScheme !== (dark ? "dark" : "light")) {
    root.style.colorScheme = dark ? "dark" : "light";
  }

  applyTokens(root, resolveTheme(themeInput(p), mode));

  // 字体：跟随主题的解析结果也要写 data-font（Noto 系靠它补 500 字重）
  const fonts = resolveFonts(p);
  if (fonts.ui === "default") delete root.dataset.font;
  else root.dataset.font = fonts.ui;
  if (fonts.weight === null) root.style.removeProperty("font-weight");
  else root.style.fontWeight = String(fonts.weight);

  if (p.fontSize === "md") root.style.removeProperty("font-size");
  else root.style.fontSize = FONT_SIZE_PX[p.fontSize];

  const chatWidth = `${clamp(p.chatWidth, 40, 100)}%`;
  if (root.style.getPropertyValue("--chat-width") !== chatWidth) {
    root.style.setProperty("--chat-width", chatWidth);
  }

  if (wallpaperActive && wallpaper && wallpaperImage) {
    root.setAttribute("data-wallpaper", "");
    if (appliedWallpaperImage !== wallpaperImage) {
      root.style.setProperty("--wallpaper-image", `url("${wallpaperImage}")`);
      appliedWallpaperImage = wallpaperImage;
    }
    root.style.setProperty(
      "--wallpaper-opacity",
      String(clamp(wallpaper.opacity, 0, 100) / 100),
    );
    root.style.setProperty("--wallpaper-blur", `${clamp(wallpaper.blur, 0, 40)}px`);
    root.style.setProperty(
      "--wallpaper-dim",
      String(clamp(wallpaper.dim, 0, 80) / 100),
    );
    root.style.setProperty(
      "--wallpaper-veil",
      wallpaperVeil(wallpaper.opacity),
    );
  } else {
    root.removeAttribute("data-wallpaper");
    if (appliedWallpaperImage !== null) {
      root.style.removeProperty("--wallpaper-image");
      appliedWallpaperImage = null;
    }
  }
}

/**
 * 无条件重放（水合后使用）：外部 DOM 可能清掉了 <html> 上的样式，
 * 而增量缓存仍以为写过。清空缓存再套一遍。
 */
export function forceApplyPrefs() {
  appliedTokens = {};
  appliedWallpaperImage = null;
  applyPrefs(prefs);
}

function readStoredPrefs(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    return migratePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 从 localStorage 恢复并应用，注册系统主题监听；模块加载即执行 */
export function initUiPrefs(): void {
  if (
    typeof window === "undefined" ||
    !window.localStorage ||
    typeof window.matchMedia !== "function"
  ) {
    return;
  }
  if (initialized) return;
  initialized = true;
  prefs = readStoredPrefs();
  wallpaperImage = undefined;
  applyPrefs(prefs);
  // 首帧缓存立即补齐；之后的滑杆拖动走 180ms 防抖
  flushPersist();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (prefs.theme !== "system") return;
      // 换新引用：useSyncExternalStore 按引用比较快照，仅 applyPrefs 的话
      // React 订阅者不会重渲染，设置页的"当前编辑模式"会停留在旧值。
      prefs = { ...prefs };
      applyPrefs(prefs);
      emit();
    });
  // 多窗口/远程页同步：别的窗口改了偏好或壁纸，本窗口即时跟上
  window.addEventListener("storage", (event) => {
    if (event.key !== UI_PREFS_KEY && event.key !== WALLPAPER_IMAGE_KEY) return;
    prefs = readStoredPrefs();
    wallpaperImage = undefined;
    invalidateWallpaperImageCache();
    applyPrefs(prefs);
    emit();
  });
  // 拖动中关窗/切后台：把最后一帧的值落盘，不丢设置
  window.addEventListener("beforeunload", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
}

function persist() {
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

/** 拖动滑杆时每个 pointermove 都写入会卡顿：DOM 即时生效，落盘防抖 */
const PERSIST_DELAY_MS = 180;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function flushPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persist();
  writeBootCache(prefs);
}

function schedulePersist() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS);
}

/** 主题变量写入合并到下一帧：拖动取色器时一次事件序列只重算一次整页样式 */
let applyFrame: number | null = null;

function scheduleApply() {
  if (applyFrame !== null) return;
  if (typeof requestAnimationFrame !== "function") {
    applyPrefs(prefs);
    return;
  }
  applyFrame = requestAnimationFrame(() => {
    applyFrame = null;
    applyPrefs(prefs);
  });
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUiPrefs(): UiPrefs {
  return prefs;
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(
    subscribe,
    getUiPrefs,
    () => DEFAULT_PREFS,
  );
}

/**
 * 只订阅一个（原始类型）字段：滑杆拖动时，代码预览等重组件不会被无关的
 * 外观变更带着逐帧重渲染。selector 必须返回原始类型或稳定引用。
 */
export function useUiPrefsSelector<T>(selector: (prefs: UiPrefs) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(prefs),
    () => selector(DEFAULT_PREFS),
  );
}

/** 批量修改（嵌套字段如 themeOverrides 用它可以一次生效） */
export function patchUiPrefs(patch: Partial<UiPrefs>) {
  prefs = migratePrefs({ ...prefs, ...patch });
  // 先同步通知 React：受控组件（取色器/滑杆）必须立刻拿到新值，
  // 否则会用自己的旧 prop 回弹一次，拖动观感就是抖/卡。
  emit();
  // 昂贵的主题变量写入合并到下一帧：一次 pointermove 序列最多重算一次样式
  scheduleApply();
  // 落盘/首帧缓存防抖：滑杆拖动只改 DOM，松手后才写 localStorage
  schedulePersist();
}

export function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) {
  patchUiPrefs({ [key]: value } as Partial<UiPrefs>);
}

/** 设置某个模式下的前景/背景；value = null 表示删除该覆盖、回落到预设 */
export function setThemeOverride(
  mode: "light" | "dark",
  key: keyof PaletteOverride,
  value: string | null,
) {
  const next: PaletteOverride = { ...prefs.themeOverrides[mode] };
  if (value === null) delete next[key];
  else next[key] = value;
  patchUiPrefs({
    themeOverrides: { ...prefs.themeOverrides, [mode]: next },
  });
}

/** 壁纸图片变更（裁剪/导入/清除）后调用：重读图片并重新应用 */
export function reloadWallpaper() {
  wallpaperImage = getWallpaperImage();
  applyPrefs(prefs);
  emit();
}

/** 只刷新壁纸图片缓存，不触发应用；随后 patchUiPrefs 会带上新图 */
export function syncWallpaperImage() {
  wallpaperImage = getWallpaperImage();
}

/** 设置主题预设；清掉自定义色/色覆盖，避免旧值遮蔽新预设的配色 */
export function selectThemePreset(preset: ThemePresetName) {
  const next = THEME_PRESETS[preset] ? preset : "kova";
  patchUiPrefs({
    themePreset: next,
    themeOverrides: { light: {}, dark: {} },
    accentCustom: null,
  });
}

/** 恢复外观相关默认值（保留提示音/通知与代码高亮设置） */
export function resetAppearance() {
  clearWallpaperImages();
  wallpaperImage = null;
  patchUiPrefs({
    theme: DEFAULT_PREFS.theme,
    themePreset: DEFAULT_PREFS.themePreset,
    themeOverrides: { light: {}, dark: {} },
    accent: DEFAULT_PREFS.accent,
    accentCustom: null,
    contrast: DEFAULT_PREFS.contrast,
    radius: null,
    fontSize: DEFAULT_PREFS.fontSize,
    chatWidth: DEFAULT_PREFS.chatWidth,
    fontFamily: DEFAULT_PREFS.fontFamily,
    codeFontFamily: DEFAULT_PREFS.codeFontFamily,
    wallpaper: null,
  });
}

/**
 * 浅 ↔ 深互切（快捷键 ⌥T 用）：以「当前实际显示的外观」为基准取反向，
 * 因此处于「跟随系统」时也会落到具体的浅色或深色档，不回跟随系统。
 */
export function toggleThemeMode(): void {
  setUiPref("theme", isDarkMode() ? "light" : "dark");
}

/** 终端等非 React 消费方订阅字体变化（返回退订函数） */
export function subscribeUiPrefs(listener: () => void): () => void {
  return subscribe(listener);
}

void initUiPrefs();
