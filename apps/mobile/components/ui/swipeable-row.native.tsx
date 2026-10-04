import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

/**
 * iOS / Android 的左滑操作行。
 *
 * 与同名的 .tsx（web 版）是同一套外部接口，内部实现分平台：
 *
 * - 这里用 gesture-handler 的 Pan + Reanimated。拖动整个跑在 **UI 线程**上，
 *   主线程在忙（渲染消息、解析流式回复）时手指跟手不掉帧 —— 这正是 web 版
 *   PanResponder 做不到的：它每一帧都要过一次 JS，列表一滚动就发涩。
 * - `.tsx` 那份留给 web：gesture-handler + reanimated 4 在 RN 0.86 的 web 端
 *   不可用，PanResponder 是核心 responder 系统，两端都有实现。
 *
 * 横向/纵向的仲裁交给手势系统自己判：activeOffsetX 说明「横向走 8px 才算数」，
 * failOffsetY 说明「纵向走 12px 就直接认输」。这样列表的纵向滚动完全不受影响，
 * 也不需要像 PanResponder 那样去否决终止请求 —— 谁该赢由声明决定，不由时序决定。
 */

/** 吸附手感：和全站其它位移同一档（damping 22 / stiffness 280 / mass 0.7） */
const SPRING = { damping: 22, stiffness: 280, mass: 0.7 } as const;

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
  const translateX = useSharedValue(open ? -actionWidth : 0);
  // 手势期间要读当前开关，但它不能进 worklet 的闭包（会锁住构建那一刻的旧值）
  const isOpen = useSharedValue(open);

  useEffect(() => {
    isOpen.value = open;
    // 受控变化（含被父级强制收起）都走这里补动画。松手时手势自己也已经把它
    // 弹到同一个目标了，这里是幂等的，只负责「父级单方面改了 open」那条路径
    translateX.value = withSpring(open ? -actionWidth : 0, SPRING);
  }, [isOpen, open, actionWidth, translateX]);

  // 拖动量必须用「起点 + translationX」算，不能在 onUpdate 里累加 value：
  // 累加会把上一帧的橡皮筋结果也算进起点，越拖越偏。
  const startX = useSharedValue(0);

  const gesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      const next = startX.value + e.translationX;
      translateX.value =
        next < -actionWidth
          ? -actionWidth + (next + actionWidth) / 3
          : Math.min(0, next);
    })
    .onEnd((e) => {
      // 位移过了三分之一，或者甩得够快就开；反向同理。iOS 也是这样，
      // 短促一挥即可，不必老老实实拖满半程
      const shouldOpen = isOpen.value
        ? !(translateX.value > -actionWidth / 3 || e.velocityX > 500)
        : translateX.value < -actionWidth / 3 || e.velocityX < -500;
      translateX.value = withSpring(shouldOpen ? -actionWidth : 0, SPRING);
      runOnJS(onOpenChange)(shouldOpen);
    });

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={styles.root}>
      <View style={styles.actions} pointerEvents={open ? "auto" : "none"}>
        {actions}
      </View>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.content, contentStyle]}>
          {children}
          {open ? (
            <Pressable
              style={StyleSheet.absoluteFill}
              accessibilityLabel="收起操作"
              onPress={() => onOpenChange(false)}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>
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
