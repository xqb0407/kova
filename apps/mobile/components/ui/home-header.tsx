import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SearchIcon, SettingsIcon, XIcon } from "lucide-react-native";
import { useTheme } from "./theme";
import {
  GlassView,
  glassControl,
  glassControlCommon,
  liquidGlassAvailable,
} from "./glass";
import { IOS_EASE } from "./motion";

/**
 * 就地展开的进场。宽度动画走 JS driver（Animated 的 width 不吃 native driver），
 * 位移都在行内局部，520ms 也读不出拖沓。IOS_EASE 前段冲得多，想整体再慢
 * 一档优先加这里,而不是改曲线——曲线一改「落定」的跟手感就没了。
 */
const SEARCH_ENTER_MS = 920;

/** 退场比进场快一档:用户已经决定收起,等就是惩罚。 */
const SEARCH_EXIT_MS = 580;

/** 搜索层的起止宽度:起点≈图标组胶囊(84 的条 + 8 间距 + 40 关闭钮),
 *  终点=整行内宽(屏宽减左右 16 留白)。 */
const SEARCH_START_W = 132;

/**
 * 首页头部。两种形态共用一条 52 高的行：
 *
 * - 浏览态：左「会话列表」标题，右边**合并**成一组的搜索 + 设置两个图标按钮
 *   （一个圆角胶囊里并排，中间一道发丝分隔线）。这两个控件走 glassControl：
 *   半透填充 + 白描边 + 抬升投影，和 composer、搜索框是同一套玻璃语言。
 * - 搜索态：输入框**占满整行**（把标题的位置一起吃掉，视觉上是标题就地变成
 *   输入框，不做两行排布），最右边一个关闭按钮。
 *
 * 两态之间是**就地展开**（iOS 搜索栏激活的语汇）：搜索层先短距入画，
 * 玻璃胶囊从图标组所在的位置向左**生长**铺满整行，关闭钮从右缘滑进落位，
 * 浏览层在这期间从容退场——所有运动都发生在行内局部，不再有整行横穿全屏
 * 的推移，也不会有两层同速对穿的转盘感。
 *
 * 玻璃壳全程不碰 alpha：GlassView（UIVisualEffectView）在祖先透明度 < 1 时
 * 渲染未定义，expo 的实现还会在祖先 alpha ≤ 0.02 时跳过效果安装、靠
 * CADisplayLink 轮询补装（expo-glass-effect 的 isEffectRenderable），渐隐和
 * 补装一竞就是「第一次点开和第二次点开玻璃长得不一样」。展开用的是宽度——
 * 容器 resize 对 UIVisualEffectView 是合法路径，系统玻璃跟着尺寸实时重绘，
 * 正是 Apple 自己搜索栏的做法。宽度窗口内层临时 overflow: hidden（小尺寸时
 * 占位文字会溢出胶囊），动画一落定就摘掉，静息态的抬升投影保持完整。
 * 退场更快一档：键盘先收起、界面再收回去。
 */
export function HomeHeader({
  searching,
  query,
  onQueryChange,
  onOpenSearch,
  onCloseSearch,
  onOpenSettings,
}: {
  searching: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onOpenSettings: () => void;
}) {
  const { colors, fontWeight, scheme } = useTheme();
  const { width } = useWindowDimensions();
  const glass = glassControl(scheme);

  // 0 = 浏览态，1 = 搜索态。两层的所有通道共用这一个进度值。
  const anim = useRef(new Animated.Value(searching ? 1 : 0)).current;
  const inputRef = useRef<TextInput>(null);
  // 动画期间给搜索层挂 overflow: hidden——胶囊还没长开时，占位文字/关闭钮
  // 会溢出容器边界。落定立刻摘掉：静息态的抬升投影画在 bounds 之外，
  // 常驻裁剪会把玻璃的「抬起」削平。
  const [animating, setAnimating] = useState(false);

  // 进态：展开跑完**再**弹键盘。玻璃条还在生长、光标已经在闪，两股运动
  // 打架就是原来「动画很怪」的观感来源。中途被 stop（快速来回切）时
  // finished 为 false，不会把键盘弹在已经不是搜索态的界面上。
  useEffect(() => {
    if (!searching) {
      inputRef.current?.blur();
      return;
    }
    setAnimating(true);
    const timer = Animated.timing(anim, {
      toValue: 1,
      duration: SEARCH_ENTER_MS,
      easing: IOS_EASE,
      useNativeDriver: false,
    });
    timer.start(({ finished }) => {
      setAnimating(false);
      if (finished) inputRef.current?.focus();
    });
    return () => timer.stop();
  }, [searching, anim]);

  // 退场：同一组映射回放——玻璃条缩回图标组的位置、关闭钮滑出右缘、
  // 浏览层回来接管。快一档收尾。
  useEffect(() => {
    if (searching) return;
    setAnimating(true);
    const timer = Animated.timing(anim, {
      toValue: 0,
      duration: SEARCH_EXIT_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    timer.start(() => setAnimating(false));
    return () => timer.stop();
  }, [searching, anim]);

  const endW = width - 32; // 整行内宽（行左右各 16 留白）

  // 错峰全靠**窗口外钳位**：RN 0.86 的 interpolate 默认外推是 `extend`
  // （沿首/末段斜率继续线性外推，AnimatedInterpolation.js 的
  // extrapolateLeft/Right 默认值），不是 clamp。少了下面这行，searchShift
  // 在 anim=1 会被外推成 164 − 1025 ≈ -861px，整层飞出屏幕外。
  const browseShift = anim.interpolate({
    inputRange: [0, 0.72],
    outputRange: [0, -(width + 24)],
    extrapolate: "clamp",
  });
  // 搜索层：先是短距入画（0→0.16 平移，宽度还钉在起点，看不见内容变化），
  // 随后玻璃条从右锚点向左生长（0.12→1 的宽度窗）。
  const searchShift = anim.interpolate({
    inputRange: [0, 0.16],
    outputRange: [SEARCH_START_W + 32, 0],
    extrapolate: "clamp",
  });
  const searchWidth = anim.interpolate({
    inputRange: [0.12, 1],
    outputRange: [SEARCH_START_W, endW],
    extrapolate: "clamp",
  });
  // 关闭钮压轴：玻璃条长出八成后，它才从右缘外面滑进落位。
  const closeShift = anim.interpolate({
    inputRange: [0.35, 1],
    outputRange: [70, 0],
    extrapolate: "clamp",
  });

  // 搜索 + 设置合并组：iOS 26+ 直接装进系统 GlassView 材质，
  // 其余平台（含 iOS 低版本）装进 glassControl 的仿玻璃胶囊。
  const iconActions = (
    <>
      <HeaderIcon label="搜索对话" onPress={onOpenSearch} flush>
        <SearchIcon size={17} strokeWidth={2} color={colors.foreground} />
      </HeaderIcon>
      <View style={[styles.divider, { backgroundColor: glass.borderColor }]} />
      <HeaderIcon label="设置" onPress={onOpenSettings} flush>
        <SettingsIcon size={17} strokeWidth={2} color={colors.foreground} />
      </HeaderIcon>
    </>
  );

  // 搜索输入条：与图标组同一套双分支。容器不加 isInteractive——
  // TextInput 自己就是交互件，玻璃形变会和文本光标选中打架。
  const searchContents = (
    <>
      <SearchIcon size={16} strokeWidth={2} color={colors.mutedForeground} />
      <SearchInput value={query} onChangeText={onQueryChange} inputRef={inputRef} />
    </>
  );

  // 关闭搜索的单按钮：玻璃圆钮，可交互（按压有液态玻璃形变）
  const closeAction = (
    <HeaderIcon label="关闭搜索" onPress={onCloseSearch}>
      <XIcon size={18} strokeWidth={2} color={colors.foreground} />
    </HeaderIcon>
  );

  return (
    <View style={styles.row}>
      {/* 浏览层：标题 + outline 图标组。常驻挂载，进出只做推移 */}
      <Animated.View
        pointerEvents={searching ? "none" : "auto"}
        style={[styles.rowFill, { transform: [{ translateX: browseShift }] }]}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: colors.foreground,
            fontSize: 24,
            fontWeight: fontWeight("700"),
            letterSpacing: -0.3,
          }}
        >
          会话列表
        </Text>
        {/* 合并成组的两个动作：iOS 走系统液态玻璃，否则白描边 + 投影的玻璃胶囊 */}
        {liquidGlassAvailable ? (
          <GlassView
            glassEffectStyle="regular"
            isInteractive
            colorScheme={scheme}
            style={[styles.iconGroupShell, { overflow: "hidden" }]}
          >
            {iconActions}
          </GlassView>
        ) : (
          <View style={[styles.iconGroupShell, glassControlCommon, glass]}>
            {iconActions}
          </View>
        )}
      </Animated.View>
      {/* 搜索层：绝对定位铺满同一行，视觉上标题就地变成输入框。同样常驻挂载，
          玻璃壳不参与 alpha，进出只做推移 */}
      <Animated.View
        pointerEvents={searching ? "auto" : "none"}
        style={[
          styles.searchLayer,
          { width: searchWidth, transform: [{ translateX: searchShift }] },
          animating && { overflow: "hidden" },
        ]}
      >
        {liquidGlassAvailable ? (
          <GlassView
            glassEffectStyle="regular"
            colorScheme={scheme}
            style={[styles.searchFieldShell, { overflow: "hidden" }]}
          >
            {searchContents}
          </GlassView>
        ) : (
          <View style={[styles.searchFieldShell, glassControlCommon, glass]}>
            {searchContents}
          </View>
        )}
        <Animated.View style={{ width: 40, transform: [{ translateX: closeShift }] }}>
          {liquidGlassAvailable ? (
            <GlassView
              glassEffectStyle="regular"
              isInteractive
              colorScheme={scheme}
              style={[styles.closeButtonShell, { overflow: "hidden" }]}
            >
              {closeAction}
            </GlassView>
          ) : (
            <View style={[styles.closeButtonShell, glassControlCommon, glass]}>
              {closeAction}
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** 图标按钮：flush 时不出内边距（用于合并组内），否则作为独立按钮 */
function HeaderIcon({
  label,
  onPress,
  flush,
  children,
}: {
  label: string;
  onPress: () => void;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        { width: flush ? 40 : 36, height: 40 },
        styles.iconHit,
        pressed && { opacity: 0.55 },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** 输入框常驻挂载（搜索层不随态卸载，玻璃件没有重装竞态），ref 由外层持有：
 *  焦点由外层按 searching 驱动——进态延迟一拍聚焦，退态立刻 blur 收键盘 */
function SearchInput({
  value,
  onChangeText,
  inputRef,
}: {
  value: string;
  onChangeText: (next: string) => void;
  inputRef: React.RefObject<TextInput | null>;
}) {
  const { colors, mono } = useTheme();

  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      placeholder="搜索对话标题"
      placeholderTextColor={colors.mutedForegroundFaint}
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      clearButtonMode="never"
      style={[
        styles.input,
        { color: colors.foreground, fontFamily: mono },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    height: 52,
  },
  // 浏览层：吃满整行的剩余宽度（外层 row 的 padding 已经给好了左右留白）
  rowFill: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  // 搜索层：右锚点挂在行右缘留白处，宽度从图标组的尺寸一路长到整行内宽
  // （width 由动画驱动）。RN 的 absolute 子节点不吃父级 padding，右边距在这
  // 一层自己给（与 row 的 paddingHorizontal 对齐）。
  searchLayer: {
    position: "absolute",
    right: 16,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  // 图标组的形状层（两个分支共用）：40 高 → 半径 20 才是正胶囊。
  // 不写 overflow: "hidden"——iOS 上它等于 masksToBounds，会把玻璃件的
  // 投影裁掉（阴影画在 bounds 之外）。子内容（图标、分隔线）都在胶囊
  // 内边距里，不需要裁；系统 GlassView 分支自己补 clip。
  iconGroupShell: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 20,
  },
  divider: { width: StyleSheet.hairlineWidth, height: 18 },
  iconHit: { alignItems: "center", justifyContent: "center" },
  // 搜索输入条的形状层（双分支共用，描边策略与 iconGroupShell 相同）
  searchFieldShell: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    // 与右上角图标组同一描边语言（半径取高度的一半，正胶囊）
    borderRadius: 20,
  },
  input: { flex: 1, minWidth: 0, fontSize: 15, padding: 0 },
  // 关闭按钮的玻璃圆钮壳：与搜索条同高取 40，正圆
  closeButtonShell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});