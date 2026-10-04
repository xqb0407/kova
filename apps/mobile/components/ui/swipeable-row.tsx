import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { NATIVE } from "./motion";

/**
 * iOS 邮件式的左滑操作行：内容层跟着手指左移，露出右缘的动作区；
 * 松手按过半程吸附开/关。受控展开（open/onOpenChange），列表里同一
 * 时刻只允许一行开着——由持有 openId 的父级保证。
 *
 * 手势用 PanResponder 而不是 gesture-handler 的 Swipeable：后者在
 * reanimated 4 + RN 0.86 组合下 web 端不可用，而这份列表要同时在
 * 手机网页（expo web）和 iOS 原生上跑。PanResponder 是 RN 核心的
 * responder 系统，两端都有实现。
 *
 * 开着的行上盖一层透明捕获面：第一次点按只负责收起，不会顺手把
 * 会话也打开——iOS 自己就是这个行为。
 */
export function SwipeableRow({
  open,
  onOpenChange,
  actionWidth,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** 动作区宽度（px），同时是最大滑出距离 */
  actionWidth: number;
  /** 露出来的动作按钮组（绝对定位在右缘，撑满行高） */
  actions: ReactNode;
  children: ReactNode;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  // PanResponder 的回调建一次就固定，开关状态经 ref 读最新值
  const stateRef = useRef({ open, actionWidth });
  stateRef.current = { open, actionWidth };

  // 受控变化（含被父级强制收起）都走这里补动画
  useEffect(() => {
    Animated.spring(translateX, {
      toValue: open ? -stateRef.current.actionWidth : 0,
      useNativeDriver: NATIVE,
      damping: 22,
      stiffness: 280,
      mass: 0.7,
    }).start();
  }, [open, translateX]);

  // 手势起点。接管的一刻手指已经走过一段（见下面的阈值），这段位移不能算进
  // 拖动量，否则内容在接管的瞬间会「啪」地跳一下——那正是最刺眼的那种不顺滑
  const origin = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      // ── 被抢走这条是「滑了但按钮没露全」的根因 ──
      // PanResponder 默认会答应任何终止请求，而外层 FlatList 的 ScrollView 只要
      // 嗅到一点纵向分量就会来要。手还在往左滑，行却已经交出手势、弹回原位，
      // 于是按钮只露出一半。既然已经判定为横向意图，就一路握到底。
      onPanResponderTerminationRequest: () => false,
      // 判定放宽到 8px、只要横向分量占优即可。原来是 14px 且要 1.6 倍，
      // 手指稍微带点纵向就不成立——第一下往往压根没接管到。
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: (_, g) => {
        origin.current = g.dx;
      },
      onPanResponderMove: (_, g) => {
        const { open: isOpen, actionWidth: width } = stateRef.current;
        const base = isOpen ? -width : 0;
        // 橡皮筋：越界的部分按 1/3 阻尼，跟 iOS 的收手感一致
        const next = base + (g.dx - origin.current);
        translateX.setValue(
          next < -width ? -width + (next + width) / 3 : Math.min(0, next),
        );
      },
      onPanResponderRelease: (_, g) => {
        const { open: isOpen, actionWidth: width } = stateRef.current;
        const drag = g.dx - origin.current;
        // 甩一下也算数：短促的一挥就开，不必真拖满半程（iOS 也是这个手感）。
        // 只看位移的话，想打开就得老老实实拖过 112px，滑起来很累。
        const flick = Math.abs(g.vx) > 0.5;
        onOpenChange(
          isOpen
            ? !(drag > -width / 3 || (flick && g.vx > 0))
            : drag < -width / 3 || (flick && g.vx < 0),
        );
      },
      onPanResponderTerminate: () => {
        // 被纵向滚动抢走手势时回到当前受控位
        const { open: isOpen } = stateRef.current;
        onOpenChange(isOpen);
      },
    }),
  ).current;

  return (
    <View style={styles.root}>
      <View style={styles.actions} pointerEvents={open ? "auto" : "none"}>
        {actions}
      </View>
      <Animated.View
        style={[styles.content, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        {children}
        {open ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="收起操作"
            onPress={() => onOpenChange(false)}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "relative" },
  // 动作区钉在右缘、撑满行高：内容层左移后从底下露出来
  actions: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  // 内容层要盖住动作区：不透明背景由调用方的行自己提供
  content: { zIndex: 1 },
});
