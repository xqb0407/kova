import { Platform, useColorScheme } from "react-native";
import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * 主题：与桌面端逐令牌对齐。
 *
 * 取值来自 apps/desktop/app/styles/globals.css 的 `:root` / `.dark` 两组令牌，
 * 由 OKLCH 换算为 sRGB hex（RN 的颜色解析没有 OKLCH）。强调色取桌面端的**默认档**
 * （ui-prefs 的 `accent: "default"`，即不打 data-accent 的单色 primary）——
 * 手机读不到桌面端的 localStorage 偏好，所以移动端固定用默认档而不是猜一个。
 * globals.css 里 blue/violet/green/orange/rose/periwinkle 六个覆盖档的换算值
 * 留在 ACCENTS 里，日后要把桌面端的外观偏好同步过来时直接接上。
 *
 * 磨砂质感对应桌面端的窗口材质模式（html[data-window-effect]），方向对齐
 * iOS 26 的 Liquid Glass：
 * 桌面端把 body 设为透明、内部面板改用半透明薄纱（bg-muted/xx）透出系统高斯模糊。
 * 手机读不到桌面壁纸，于是换成等价的结构：
 *   - `background` 底色上叠几团彩色光晕（当壁纸，给模糊一个可折射的底）；
 *   - 面板走 GlassSurface：iOS / web 用 expo-blur 的系统材质 tint
 *     （system*Material，自带染色与饱和度提升）；Android 没有背板模糊，
 *     材质由主题底色薄纱 + 描边/高光表达（见 glass.tsx 的 MATERIAL_IS_SCRIM_ONLY）；
 *   - 玻璃件统一 hairline 描边 + 顶缘高光 + 斜向 sheen，浮层再加柔影。
 * 壁纸随主题走品牌色，而不是用户的桌面照片。
 */

/** 桌面端六档强调色在浅/深下的 primary（globals.css 的 data-accent 块） */
const ACCENTS = {
  default: { light: "#171717", dark: "#e5e5e5" },
  blue: { light: "#2383e2", dark: "#7d94ff" },
  violet: { light: "#7c3aed", dark: "#a78bfa" },
  green: { light: "#16a34a", dark: "#4ade80" },
  orange: { light: "#ea580c", dark: "#fb923c" },
  rose: { light: "#e11d48", dark: "#fb7185" },
  periwinkle: { light: "#4f46e5", dark: "#818cf8" },
} as const;

export type AccentName = keyof typeof ACCENTS;

type Scheme = "light" | "dark";

/**
 * 一组语义色。名字跟桌面端 CSS 变量一一对应（background/foreground/card/muted/…），
 * 这样改样式时两边能对照着改；额外补的是 RN 特有的几个（代码块底色、滚动条色）。
 */
export type ThemeColors = {
  background: string;
  foreground: string;
  card: string;
  popover: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  muted: string;
  /** muted-foreground：所有次要文字 */
  mutedForeground: string;
  /** 三级文字：比 muted-foreground 再弱一档（时间戳、占位符）。桌面端靠 opacity
   *  压出来，这里预先混好，省得每个调用点各写各的 opacity。 */
  mutedForegroundFaint: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  ring: string;
  focusRing: string;
  sidebarPrimary: string;
  /** hover / active / selected：半透明叠加层（窗口材质下与桌面端一致） */
  hover: string;
  active: string;
  selected: string;
  /** border 与 input 在深色下是带 alpha 的白 */
  border: string;
  input: string;
  /** 代码块外壳（bg-muted）/ 内层（bg-background），见 markdown.css */
  codeSurface: string;
  codeBody: string;
  overlay: string;
  /**
   * 语义色。桌面端没有独立的 success/warning 令牌，用的是 Tailwind 的
   * emerald/amber；这里直接复用强调色表的 green/orange 两档，保证同一个绿
   * 在「按钮/强调」与「成功提示」里是同一个值。
   */
  success: string;
  warning: string;
};

/** 半透明薄纱的档位，对应桌面端的 bg-muted/30…/55 */
/** Android 材质薄纱的浓度档（%）；iOS / web 的材质由系统给，这个值不参与 */
export type Scrim = 30 | 40 | 44 | 50 | 55 | 60 | 66 | 70 | 72;

export type Theme = {
  scheme: Scheme;
  colors: ThemeColors;
  /** 用 hex + alpha 生成的薄纱色；RN 的 rgba() 不参与 color-mix 简写，直接拼 */
  scrim(level: Scrim, base?: string): string;
  radius: typeof radius;
  space: (n: number) => number;
  fontWeight: (w: "400" | "500" | "600" | "700") => "400" | "500" | "600" | "700";
  mono: string | undefined;
  /**
   * BlurView 的 tint（iOS 26 Liquid Glass 方向）：expo-blur 的 system*Material
   * tint 在 iOS 上直接映射 UIBlurEffect 的系统材质——自带染色 + 饱和度提升，
   * 比「纯色薄纱 + 普通 blur」更透、更细腻。三档厚度对应桌面的 bg-muted/N：
   * thin = 消息卡片/工具行，regular = 头部/输入条，thick = 抽屉/浮层。
   * Android 不上 BlurView（那侧 blurMethod 默认 "none"，只剩一层灰），
   * 面板材质由 GlassSurface 用主题底色薄纱表达，这里的三档取值不参与。
   */
  material: {
    thin: "systemThinMaterial" | "systemThinMaterialDark" | "systemThinMaterialLight" | "dark" | "light";
    regular: "systemMaterial" | "systemMaterialDark" | "systemMaterialLight" | "dark" | "light";
    thick: "systemThickMaterial" | "systemThickMaterialDark" | "systemThickMaterialLight" | "dark" | "light";
  };
  /** 玻璃描边（hairline）：iOS 26 的玻璃件都有一圈低亮度描边定形 */
  glassBorder: string;
  /** 顶缘高光：玻璃上边缘的反光，白玻璃亮、黑玻璃更亮 */
  glassRim: string;
  /** 斜向 sheen 的最亮一档（对角渐变的高光端） */
  glassSheen: string;
  /** 浮层玻璃的投影色 */
  glassShadow: string;
};

export const radius = {
  /** --radius: 0.625rem = 10px，桌面端 sm/md/lg/xl/2xl 由它派生 */
  base: 10,
  sm: 6, // calc(--radius * 0.6)
  md: 8, // calc(--radius * 0.8)
  lg: 10,
  xl: 14, // calc(--radius * 1.4)
  "2xl": 18, // calc(--radius * 1.8)
  "3xl": 22,
  pill: 999,
} as const;

export const space = (n: number) => n * 4;

/** iOS 用系统字重，Android 上 system-ui 的 500/600 不存在，需显式映射 */
export const fontWeight = (w: "400" | "500" | "600" | "700") =>
  Platform.select({
    ios: w,
    android:
      w === "400" ? "normal" : w === "500" ? "medium" : w === "600" ? "600" : "bold",
    default: w,
  }) as "400" | "500" | "600" | "700";

/** 对应 --app-font-sans 的等宽档（Cascadia Code / SF Mono / Menlo） */
export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

/** hex → "r,g,b"，rgba() 拼装用 */
function channels(hex: string): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  // eslint-disable-next-line no-bitwise -- 拆 RGB 三通道
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${channels(hex)}, ${alpha})`;
}

/** 给任意主题色加透明度（RN 没有 color-mix，薄纱/选中底都靠它） */
export function withAlpha(hex: string, alpha: number): string {
  return rgba(hex, alpha);
}

const DARK: ThemeColors = {
  background: "#0a0a0a",
  foreground: "#fafafa",
  card: "#171717",
  popover: "#171717",
  primary: ACCENTS.default.dark,
  primaryForeground: "#171717",
  secondary: "#262626",
  muted: "#262626",
  mutedForeground: "#a1a1a1",
  mutedForegroundFaint: "#6f6f6f",
  accent: "#262626",
  accentForeground: "#fafafa",
  destructive: "#ff6467",
  ring: "#737373",
  focusRing: "#6B97FF",
  sidebarPrimary: "#1447e6",
  hover: "rgba(255, 255, 255, 0.06)",
  active: "rgba(255, 255, 255, 0.1)",
  // 窗口材质下 selected 改为半透明叠加，明暗对比才不会随底层内容漂移
  selected: "rgba(255, 255, 255, 0.12)",
  border: "rgba(255, 255, 255, 0.1)",
  input: "rgba(255, 255, 255, 0.15)",
  // --code-surface: color-mix(in oklab, var(--foreground) 4%, var(--background))
  codeSurface: "#131313",
  codeBody: "#0a0a0a",
  overlay: "#ffffff",
  success: ACCENTS.green.dark,
  warning: ACCENTS.orange.dark,
};

const LIGHT: ThemeColors = {
  // 浅浅灰而不是纯白：纯白底上，玻璃面板（composer、卡片、抽屉）那层半透
  // 白就没有可透的东西，"磨砂"退化成一块更白的补丁。iOS 的分组底色就是这个
  // 值，玻璃件压在它上面才透得出层次。连接页是唯一例外，见 AppBackground 的 base。
  background: "#f2f2f7",
  foreground: "#0a0a0a",
  card: "#ffffff",
  popover: "#ffffff",
  primary: ACCENTS.default.light,
  primaryForeground: "#fafafa",
  secondary: "#f5f5f5",
  muted: "#f5f5f5",
  mutedForeground: "#737373",
  mutedForegroundFaint: "#9b9b9b",
  accent: "#f5f5f5",
  accentForeground: "#0a0a0a",
  destructive: "#e7000b",
  ring: "#a1a1a1",
  focusRing: "#6B97FF",
  sidebarPrimary: "#171717",
  hover: "rgba(0, 0, 0, 0.04)",
  active: "rgba(0, 0, 0, 0.07)",
  selected: "rgba(0, 0, 0, 0.1)",
  // iOS 26 Liquid Glass 的边不是灰线，是**白的高光**：玻璃边缘折射环境光，
  // 描边要比底色更亮才读得出「这是一块有厚度的玻璃」。浅灰底（#f2f2f7）上
  // 一根白线正好是这个关系；深色下 border 本来就是带 alpha 的白，两套统一了。
  border: "#ffffff",
  input: "#e5e5e5",
  codeSurface: "#f7f7f7",
  codeBody: "#ffffff",
  overlay: "#000000",
  success: ACCENTS.green.light,
  warning: ACCENTS.orange.light,
};

export function makeTheme(
  scheme: Scheme,
  accent: AccentName = "default",
): Theme {
  const colors: ThemeColors = scheme === "dark" ? { ...DARK } : { ...LIGHT };
  const tone = ACCENTS[accent][scheme];
  colors.primary = tone;
  // primary-foreground 取「反色」：深色下 primary 是亮白，配暗前景；浅色反之
  colors.primaryForeground = scheme === "dark" ? DARK.primaryForeground : LIGHT.primaryForeground;
  colors.ring = ACCENTS[accent][scheme];

  return {
    scheme,
    colors,
    /** bg-muted/N：底色按 N% 与透明混合，等价于桌面端的 bg-muted/xx */
    scrim(level, base) {
      return rgba(base ?? colors.background, level / 100);
    },
    radius,
    space,
    fontWeight,
    mono,
    material: scheme === "dark"
      ? {
          thin: "systemThinMaterialDark",
          regular: "systemMaterialDark",
          thick: "systemThickMaterialDark",
        }
      : {
          thin: "systemThinMaterialLight",
          regular: "systemMaterialLight",
          thick: "systemThickMaterialLight",
        },
    // 玻璃件的描边/高光：深色玻璃靠亮描边定形，浅色玻璃靠白描边 + 弱影
    glassBorder:
      scheme === "dark" ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.55)",
    glassRim:
      scheme === "dark" ? "rgba(255, 255, 255, 0.38)" : "rgba(255, 255, 255, 0.85)",
    glassSheen:
      scheme === "dark" ? "rgba(255, 255, 255, 0.09)" : "rgba(255, 255, 255, 0.35)",
    glassShadow:
      scheme === "dark" ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.01)",
  };
}

const ThemeContext = createContext<Theme>(makeTheme("dark"));

export function ThemeProvider({
  children,
  forceScheme,
  accent = "default",
}: {
  children: ReactNode;
  /** 测试/截图用；不传则跟随系统 */
  forceScheme?: Scheme;
  accent?: AccentName;
}) {
  const system = useColorScheme();
  const theme = useMemo(
    () => makeTheme(forceScheme ?? (system === "light" ? "light" : "dark"), accent),
    [system, forceScheme, accent],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}