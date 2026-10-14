import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type ColorValue,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import type { ReactNode } from "react";
import { useTheme, withAlpha, type Scrim } from "./theme";

/**
 * 玻璃质感层——iOS 26「Liquid Glass」的 RN 等价物。
 *
 * 与桌面端窗口材质模式（html[data-window-effect]）的对应关系：
 *   桌面：body 透明，面板半透明薄纱（bg-muted/N）+ backdrop-blur 透出系统模糊。
 *   手机：AppBackground 造一层可透的彩色底（光晕"壁纸"），GlassSurface 盖
 *   expo-blur 的 **系统材质**（systemThin/Regular/ThickMaterial）——在 iOS 上
 *   它直接映射 UIBlurEffect，自带染色与饱和度提升，比「纯色 scrim + 普通
 *   blur」更透、颗粒更细。Android 没有系统材质，也没有背板模糊
 *   （expo-blur 的 Android blurMethod 默认就是 "none"，见 MATERIAL_IS_SCRIM_ONLY），
 *   所以那一侧不挂 BlurView，材质由一层色值确定的薄纱表达。
 *
 * 玻璃件的三层细节（从下到上）：
 *   1. 材质 blur（本体）；
 *   2. 斜向 sheen 渐变——模拟玻璃对环境光的斜反射，Liquid Glass 的"流动性"主要靠它；
 *   3. 顶缘 1px 高光（rim light）+ hairline 描边——给玻璃定形，圆角处最亮。
 *
 * 这三层都只属于有真模糊的 iOS / web；Android 的玻璃件是实底（见
 * MATERIAL_IS_SCRIM_ONLY），blur 与 sheen/rim 一律不画、相关模块不加载。
 *
 * 浮层类（toast/抽屉/卡片）再叠一层柔和投影，把玻璃从背景上"抬"起来。
 */

/**
 * Android 与其余平台的分水岭。
 *
 * Android 没有可用的背板模糊：expo-blur 的 blurMethod 在 Android 上默认
 * 就是 "none"，此时 BlurView 不走模糊，而是把 tint 换算成一层纯色铺上去
 * （浅色近白、深色近黑）。它叠在本就按语义色调过的 scrim 上，只是把面板
 * 又洗淡一遍——既没有「透」，还把底层的色相压掉。所以 Android 的玻璃件
 * 不挂 BlurView，材质由表面色单独表达；iOS / web 走各自的真模糊
 * （UIBlurEffect / backdrop-filter），不受影响。
 *
 * 连壁纸层（AppBackground）也不走真模糊，尽管它结构上够得着——Android 的真
 * 模糊要用 blurTarget 指一个 BlurTargetView 当采样源，而采样源不能包含引用
 * 它的 BlurView 自己（dimezis 的硬约束）。玻璃面板压在滚动列表 / 键盘 / 抽屉
 * 之上，采样源得是「整个页面减掉玻璃件」，React 树里没有这样的容器；壁纸层
 * 倒是天生的两层兄弟结构，但那里的色晕本来就是化开的渐变，全屏再过一遍模糊
 * 换不来多少观感，只赔上每帧一次的采样开销。面板的「厚」就交给表面色浓度。
 */
const MATERIAL_IS_SCRIM_ONLY = Platform.OS === "android";

/**
 * 三个玻璃件依赖的原生模块（expo-glass-effect / expo-blur / expo-linear-gradient）
 * 都是 import 即初始化：包的 JS 入口在模块作用域就调 requireNativeViewManager，
 * 原生侧没编进包时（dev client 落后于 package.json），静态 import 会直接把
 * glass.tsx 炸掉——所有引用它的页面跟着红屏，任何 try/catch 都没机会执行。
 * 所以全部走惰性 require：加载失败只降级不崩。Android（MATERIAL_IS_SCRIM_ONLY）
 * 更干脆，blur / gradient 连 require 都不做——那两个包在安卓上没有可用的
 * 原生实现（blurMethod 默认 "none"、渐变高光也不画），加载只是白占内存。
 */
type GlassEffectModule = typeof import("expo-glass-effect");
type BlurModule = typeof import("expo-blur");
type LinearGradientModule = typeof import("expo-linear-gradient");

function loadNativeModule<M>(load: () => M, label: string): M | null {
  try {
    return load();
  } catch (err) {
    // 最常见的原因是依赖是后加的、dev client 还是旧的——那要把原生包重编一次
    // （npx expo run:android / run:ios）才会生效，光重启 Metro 没用。这里吱一声，
    // 否则表现只是「到处都没有玻璃」，很难看出是构建问题还是样式写错。
    console.warn(
      `[glass] ${label} 原生模块不可用，相关玻璃件退回平面近似。` +
        "若刚添加该依赖，请重新构建原生包。",
      err,
    );
    return null;
  }
}

const expoGlassEffect = loadNativeModule<GlassEffectModule>(
  () => require("expo-glass-effect") as GlassEffectModule,
  "expo-glass-effect",
);

// 用 isGlassEffectAPIAvailable 而不是 isLiquidGlassAvailable：前者才是
// 「这个 API 现在能不能调」的判据，后者只说明系统是不是 Liquid Glass 外观。
// 老版本 iOS 26 beta 里系统是新的、API 却不在，直接建 GlassView 会崩
// （expo/expo#40911），所以这里跟官方文档一样认前者。iOS 的玻璃可用性在
// 进程生命周期里不会变，模块作用域算一次并导出——各调用点
// （chat/sheet/home-header）共用这一个。
export const liquidGlassAvailable =
  expoGlassEffect != null &&
  (() => {
    try {
      return expoGlassEffect.isGlassEffectAPIAvailable();
    } catch {
      return false;
    }
  })();

/**
 * 消费点（chat 顶栏 / home-header / sheet）都以 liquidGlassAvailable 为闸才渲染
 * GlassView，View 兜底只为类型完整 + 万一漏了闸也不至于崩。
 */
export const GlassView = (expoGlassEffect?.GlassView ??
  View) as GlassEffectModule["GlassView"];

/**
 * 玻璃容器：iOS 26 上给容器自身挂 UIGlassContainerEffect，内部的 GlassView
 * 与它融合成一整块连续玻璃；效果安装走 props 赋值，没有 GlassView 那套
 * 「祖先 alpha ≤ 0.02 跳过安装 + 轮询补装」的竞态。其余平台退化成普通 View。
 */
export const GlassContainer = (expoGlassEffect?.GlassContainer ??
  View) as GlassEffectModule["GlassContainer"];

const BlurView =
  (MATERIAL_IS_SCRIM_ONLY
    ? null
    : loadNativeModule<BlurModule>(
        () => require("expo-blur") as BlurModule,
        "expo-blur",
      ))?.BlurView ?? View;

const LinearGradient =
  (MATERIAL_IS_SCRIM_ONLY
    ? null
    : loadNativeModule<LinearGradientModule>(
        () => require("expo-linear-gradient") as LinearGradientModule,
        "expo-linear-gradient",
      ))?.LinearGradient ?? View;

/**
 * Android 的材质色板。iOS 的玻璃靠三样东西立起来，Android 三样都没有：
 *   1. 系统材质的背板模糊——Android 没有（见 MATERIAL_IS_SCRIM_ONLY）；
 *   2. 白描边——浅色页上「白填充 + 白描边」只差 2~3%，等于没有轮廓；
 *   3. shadow* 三件套——shadowOpacity/shadowRadius/shadowOffset 在
 *      ReactAndroid 里根本没有实现（只有 iOS 有），写了也不画。
 *
 * 前两条叠起来，iOS 上那块「白描边 + 柔影」的玻璃到了 Android 就塌成一块
 * 没有边、没有影、说不清形状的白。所以那一侧换成 Material 的说法：**不透明的
 * 表面色 + 一道与底色有对比的描边**，抬起交给 elevation（Android 上唯一真会
 * 画阴影的属性）。
 */
export const androidGlass = {
  light: { fill: "#ffffff", border: "rgba(0, 0, 0, 0.08)" },
  dark: { fill: "#262626", border: "rgba(255, 255, 255, 0.14)" },
} as const;

/**
 * 同色相的全透明色。
 *
 * 渐变里不能写 "transparent"：那是 rgba(0,0,0,0)，即**透明黑**。Android 的
 * LinearGradient 拿它跟白色插值，中段会插出灰带（白 → 透明黑 的中点 = 中灰），
 * 玻璃上就多一道脏边。改成「同 RGB、alpha=0」既避开这个坑，观感也才真的是
 * 「这个颜色淡出去」。iOS 上两者等价（CGGradient 预乘插值），所以这条不改变
 * iOS 的现有表现。
 */
function fadeOut(color: string): string {
  // rgba(r, g, b, a) 形式：直接把 alpha 段换成 0
  const channels = color.match(/^rgba?\(([^)]+)\)$/);
  if (channels) {
    const [r, g, b] = channels[1].split(",").map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  // #rgb / #rrggbb 形式：取通道值重建
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (/^[0-9a-fA-F]{6}$/.test(full)) {
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  // 兜底：主题未覆盖到的形式。别用 "transparent"（透明黑），宁可固定白透明
  return "rgba(255, 255, 255, 0)";
}

/**
 * 小控件的玻璃底：搜索框、图标组、composer 这类**贴着页面背景**的东西。
 *
 * iOS 26 上交给 expo-glass-effect 的 GlassView —— 它是原生 `UIGlassEffect`，
 * 折射、边缘高光、动态模糊全由系统给，手画不出来。这比「半透白填充 + 白描边」
 * 那套近似强得多：真玻璃会把底下滚过去的内容糊开，填充只是静态的一层色。
 *
 * 其余平台（Android / web / iOS < 26）GlassView 自己退化成普通 View，什么都不画，
 * 所以这里补一层手工近似。白描边要靠投影才立得住，纯白底上画白线等于没画 ——
 * Apple 在白背景上做玻璃，边缘那道高光也是从投影的分界线上冒出来的。Android
 * 没有那层投影可用，于是改走 androidGlass 那套（不透明面 + 对比描边）。
 */
export function glassControl(scheme: "light" | "dark") {
  if (MATERIAL_IS_SCRIM_ONLY) {
    return {
      backgroundColor: androidGlass[scheme].fill,
      borderColor: androidGlass[scheme].border,
    };
  }
  return scheme === "dark"
    ? {
        backgroundColor: "rgba(255, 255, 255, 0.10)",
        borderColor: "rgba(255, 255, 255, 0.22)",
        shadowColor: "#000000",
        shadowOpacity: 0.4,
      }
    : {
        backgroundColor: "rgba(255, 255, 255, 0.58)",
        borderColor: "#ffffff",
        shadowColor: "#0b1020",
        shadowOpacity: 0.1,
      };
}

/** glassControl 的共用量：白描边是 hairline，投影负责「抬起来」的那一下。
 *  Android 只认 elevation（shadow* 是 iOS-only），且描边要够实才读得出来：
 *  hairline 在 3x 屏上是 0.33px，配深色描边等于没画，故取整 1dp（Material
 *  outline 的标准宽度）。 */
export const glassControlCommon = MATERIAL_IS_SCRIM_ONLY
  ? ({ borderWidth: 1, elevation: 3 } as const)
  : ({
      borderWidth: StyleSheet.hairlineWidth,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    } as const);

export function GlassControl({
  children,
  style,
  radius = 999,
  tintColor,
  fill,
  interactive,
  ...rest
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 圆角。胶囊传高度的一半 */
  radius?: number;
  /** 系统玻璃的染色。iOS 26 上直接交给 UIGlassEffect */
  tintColor?: ColorValue;
  /**
   * 回退路径的填充色（Android / web / 没有原生模块时）。
   *
   * 默认那层 58% 白是给「贴在小控件下面」调的量，压在浅色页面上几乎看不出
   * 是一块面板。菜单、弹层这类**必须自己立住**的东西要显式给一个更实的填充，
   * 否则在浅色页面上就是「没有背景」。
   */
  fill?: ColorValue;
  interactive?: boolean;
} & Omit<ViewProps, "style" | "children">) {
  const { scheme } = useTheme();

  if (liquidGlassAvailable) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={tintColor}
        isInteractive={interactive}
        colorScheme={scheme}
        // overflow:hidden 让子内容（图标、分隔线）也待在圆角里
        style={[{ borderRadius: radius, overflow: "hidden" }, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    // 不加 overflow: "hidden"——iOS 上它等价 masksToBounds，会把
    // glassControlCommon 那道投影裁掉（阴影画在 bounds 之外），玻璃件
    // 就塌成一块没有层次的半透色。子内容的圆角内的假设由调用方保证
    // （图标/文本都在内边距里）。系统 GlassView 分支的 clip 由
    // 调用点显式给，原生玻璃不受这一裁剪影响。
    <View
      style={[
        { borderRadius: radius },
        glassControlCommon,
        glassControl(scheme),
        // fill 压在最上面：给了它就以它为准，没给才用 glassControl 那层淡填充
        fill ? { backgroundColor: fill } : null,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/**
 * 壁纸层：底色 + 几团**边缘已经化开**的色晕，再罩一层模糊——「背景磨砂」。
 *
 * 色晕不能直接画成实心圆。520px 的实心圆即使再模糊，轮廓那道硬边依然看得出来，
 * 页面就成了「三个圈」而不是磨砂底。做法是每团用多层同心圆叠出径向衰减
 * （对应 CSS 的 radial-gradient，最外层 alpha 归零），边界天然不存在；
 * 上面的 BlurView 只是再补一层高频细节，不负责藏边——Android 没有这层模糊
 * （见 MATERIAL_IS_SCRIM_ONLY），所以衰减的层数要够密，不能让同心圆的台阶
 * 露出来。
 *
 * `base` 覆盖底色，默认取主题的 background。绝大多数页面用默认值：浅灰底
 * 让色晕、composer、抽屉这些半透件有东西可透，输入件描边也有底色可对比。
 */
export function AppBackground({
  children,
  base,
}: {
  children: ReactNode;
  base?: string;
}) {
  const { colors, scheme } = useTheme();
  const { width, height } = useWindowDimensions();
  const dark = scheme === "dark";

  // iOS / web 的衰减档：线性衰减、最外层近乎归零。上面有真模糊把台阶糊开，
  // 5 档足够；Android 不走这条路（见下方 blooms 渲染），用 radial-gradient
  // 的连续插值，不存在台阶问题。
  const LAYERS = [
    { ratio: 0.1, alpha: 1 },
    { ratio: 0.26, alpha: 0.6 },
    { ratio: 0.42, alpha: 0.34 },
    { ratio: 0.56, alpha: 0.16 },
    { ratio: 0.68, alpha: 0.04 },
  ];

  // Android 色晕的径向衰减曲线：色标半径（% of 半径）→ 相对峰值 alpha。
  // 原生渲染器在色标间连续插值，85% 半径处归零，边缘干干净净。
  const BLOOM_STOPS: readonly { at: number; a: number }[] = [
    { at: 0, a: 1 },
    { at: 20, a: 0.75 },
    { at: 40, a: 0.45 },
    { at: 60, a: 0.18 },
    { at: 75, a: 0.05 },
    { at: 85, a: 0 },
  ];

  const blooms = [
    // 主色团：右上，最大——玻璃件的 sheen 主要折射它。
    // Android 峰值比 iOS 略抬一档：没有 blur 的饱和度增益，同 alpha 会显得更淡。
    { cx: width * 0.82, cy: height * 0.02, d: width * 1.5, color: colors.sidebarPrimary, a: dark ? 0.3 : 0.4 },
    // 强调色团：左下，破坏色压到很低，只提供冷暖对比
    { cx: width * 0.1, cy: height * 0.6, d: width * 1.15, color: colors.destructive, a: dark ? 0.2 : 0.22 },
    // 中性团：中右下，给浅色模式补一点灰度层次，避免大片纯白
    { cx: width * 0.74, cy: height * 0.94, d: width * 1.05, color: colors.foreground, a: dark ? 0.1 : 0.08 },
  ];

  return (
    <View style={[styles.root, { backgroundColor: base ?? colors.background }]}>
      {/* 色晕层。同心圆叠层只在有真模糊的 iOS / web 用；Android 用
          radial-gradient 连续衰减——同心圆无论叠多密，相邻档的 alpha 差在
          浅色底上依然肉眼可辨（一圈一圈的台阶），渐变插值才是无模糊侧的
          正确等价物。 */}
      <View style={styles.blooms} pointerEvents="none">
        {MATERIAL_IS_SCRIM_ONLY
          ? blooms.map((bloom, bi) => (
              <View
                key={bi}
                style={{
                  position: "absolute",
                  left: bloom.cx - bloom.d / 2,
                  top: bloom.cy - bloom.d / 2,
                  width: bloom.d,
                  height: bloom.d,
                  backgroundImage: `radial-gradient(circle closest-side, ${BLOOM_STOPS.map(
                    (stop) =>
                      `${withAlpha(bloom.color, bloom.a * stop.a)} ${stop.at}%`,
                  ).join(", ")})`,
                }}
              />
            ))
          : blooms.map((bloom, bi) =>
              LAYERS.map((layer, li) => {
                const size = bloom.d * layer.ratio;
                return (
                  <View
                    key={`${bi}-${li}`}
                    style={{
                      position: "absolute",
                      left: bloom.cx - size / 2,
                      top: bloom.cy - size / 2,
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      backgroundColor: withAlpha(bloom.color, bloom.a * layer.alpha),
                    }}
                  />
                );
              }),
            )}
      </View>
      {/* 磨砂本体：把上面那层色晕糊开。放在最底下、内容之上，
          pointerEvents 必须关掉，否则整页都点不动。
          Android 没有背板模糊，压一层底色薄纱统一基调（见 MATERIAL_IS_SCRIM_ONLY）。
          纱的浓度要压低——它的职责只是把色晕往页面基调方向带一档，不是盖住它：
          浓纱会把色晕洗成死白/死黑，「磨砂」就没了；色晕层自己本来就是衰减
          同心圆，露出来才是安卓这侧的「透」。 */}
      {MATERIAL_IS_SCRIM_ONLY ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: withAlpha(
                base ?? colors.background,
                dark ? 0.22 : 0.3,
              ),
            },
          ]}
        />
      ) : (
        <BlurView
          pointerEvents="none"
          intensity={scheme === "dark" ? 50 : 70}
          tint={scheme === "dark" ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      )}
      {children}
    </View>
  );
}

/**
 * 玻璃面板。thickness 是 Apple 材质的厚度档（thin/regular/thick），只在 iOS /
 * web 用得上——那边由系统的 UIBlurEffect / backdrop-filter 给材质。level 是
 * Android 的材质不透明度：Android 没有背板模糊可透，面板的「厚」只能靠这层
 * 薄纱的浓度表达，所以浮得越高（抽屉 > 头部 > 卡片）传得越大。
 */
export function GlassSurface({
  children,
  thickness = "regular",
  level = 50,
  radius: r,
  blur = true,
  blurIntensity,
  bordered = true,
  floating = false,
  style,
}: {
  children?: ReactNode;
  /** 材质厚度档：thin=消息卡片/工具行，regular=头部/输入条，thick=抽屉/浮层 */
  thickness?: "thin" | "regular" | "thick";
  /** Android 的材质不透明度（%）；iOS / web 的材质由系统给，这个值不参与 */
  level?: Scrim;
  radius?: number;
  blur?: boolean;
  blurIntensity?: number;
  bordered?: boolean;
  /** 浮层：加柔和投影，从背景上抬起来 */
  floating?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { scheme, scrim, material, glassBorder, glassRim, glassSheen, glassShadow, radius } =
    useTheme();
  const tint = material[thickness];
  // iOS 材质自带染色：容器必须全透明，否则 scrim 被 blur 采样后整片发灰，
  // "透"就没了。
  const isIos = Platform.OS === "ios";

  // Android 的「材质」只能靠表面色表达（见 MATERIAL_IS_SCRIM_ONLY），且必须是
  // **实底**：这里没有模糊，半透的白只是让底下滚过去的消息糊成一片灰字影，
  // 看着像没画完。Material 的表面本来就是不透明的。
  // 基色取比页面底色**亮一档**的材质色——浅色用 card（白）、深色用 muted
  // （浅一档的灰）。拿 background 当基色的话，面板压在纯色页底上同色叠同色，
  // 整块玻璃只剩一圈描边，看不出是块有厚度的面板。
  // web 没这个问题（backdrop-filter 是真模糊），继续用 level 那层薄纱。
  const androidSurface = androidGlass[scheme].fill;

  const glassBody = (
    <View
      style={[
        {
          borderRadius: r ?? radius["2xl"],
          backgroundColor: isIos
            ? "transparent"
            : MATERIAL_IS_SCRIM_ONLY
              ? androidSurface
              : scrim(level),
          overflow: "hidden",
        },
        bordered && {
          borderWidth: StyleSheet.hairlineWidth,
          // Android 的描边不能用 iOS 那道白高光：白线压在白面/浅灰页上读不出来，
          // 面板就没了轮廓。改成与底色有对比的暗线（Material 的 outline）。
          borderColor: MATERIAL_IS_SCRIM_ONLY
            ? androidGlass[scheme].border
            : glassBorder,
        },
        style,
      ]}
    >
      {blur && !MATERIAL_IS_SCRIM_ONLY ? (
        <BlurView
          // 必须不吃事件：BlurView 在 web 上渲染成一个铺满的 div，不置 none 会
          // 把整块玻璃的点击全吃掉——玻璃里放输入框时，输入框直接点不动。
          pointerEvents="none"
          intensity={blurIntensity ?? (isIos ? 60 : 40)}
          tint={tint}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {/* 斜向 sheen + 顶缘 rim 是假玻璃的光泽，只属于「有真模糊」的 iOS / web：
          Android 的面板本来就是实底，实底上叠高光渐变，深色下只会洗出两道脏
          光，浅色下则完全看不见——整段跳过（expo-linear-gradient 在安卓也不
          加载，见文件头的惰性加载说明）。 */}
      {!MATERIAL_IS_SCRIM_ONLY ? (
        <>
          {/* 斜向 sheen：左上亮 → 中段透明 → 右下轻微回光，玻璃的"体积感"来源。
              中间两档用 fadeOut(glassSheen) 而不是 "transparent"：后者是透明黑，
              插值会在色带中段插出灰边（见 fadeOut 的注释）。 */}
          <LinearGradient
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            colors={[
              glassSheen,
              fadeOut(glassSheen),
              fadeOut(glassSheen),
              glassSheen,
            ]}
            locations={[0, 0.35, 0.65, 1]}
          />
          {/* 顶缘 rim light：1px 高光只画在顶部 12% 内，边缘圆角处自然收细 */}
          <LinearGradient
            pointerEvents="none"
            style={styles.rim}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            colors={[glassRim, fadeOut(glassRim)]}
            locations={[0, 1]}
          />
        </>
      ) : null}
      {children}
    </View>
  );

  if (!floating) {
    return glassBody;
  }

  // 投影必须挂在一个**不裁剪**的外层 wrapper：iOS 上 overflow hidden =
  // masksToBounds，阴影画在 bounds 之外，跟玻璃体同层直接被裁掉——浮层
  // 就此失去抬起的层次。wrapper 无背景无尺寸，iOS 的阴影按子层合成后的
  // alpha 轮廓走（圆角天然正确）；Android 的 elevation 阴影由父级绘制，
  // 也不受玻璃体自身 clip 影响。
  // 约束：floating 的调用方 style 留在玻璃体上（padding/border 语义不变），
  // 但不要用 absolute 定位——内层相对 wrapper 定位会把 wrapper 塌成零尺寸。
  return (
    <View
      style={{
        shadowColor: glassShadow,
        shadowOpacity: 1,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 8,
      }}
    >
      {glassBody}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  blooms: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  rim: { position: "absolute", top: 0, left: 0, right: 0, height: 14 },
});
