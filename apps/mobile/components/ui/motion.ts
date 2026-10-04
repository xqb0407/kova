import { useCallback, useEffect, useRef } from "react";
import { Animated, Easing, PanResponder, Platform } from "react-native";

/**
 * 全局动效参数。
 *
 * 手感「不丝滑」十有八九不是动画不够多，而是曲线不对：线性、时长忽长忽短、
 * 弹一下再抖回来。iOS 的做法是一条统一的 spring —— 起步快、中段稳、尾巴
 * 极轻微地缓下来，几乎不过冲。所以这里把曲线和时长定死一份，各处直接取，
 * 不再每个组件自己写一个 Easing.out(cubic)。
 */

/** iOS 常用的减速曲线。前 30% 走掉一大截，剩下慢慢收，读起来是「跟手」而不是「匀速」。 */
export const IOS_EASE = Easing.bezier(0.22, 1, 0.36, 1);

/** 抽屉这类大面积位移。用短一点，不然推开的过程本身就拖沓。 */
export const SHEET_MS = 300;

/** 小控件的进场。 */
export const ENTER_MS = 220;

/** 退场要比进场快一点：用户已经决定了，再让他等就是惩罚。 */
export const EXIT_MS = 200;

/** 选中态的吸附。比退场更短，短到几乎感觉不到「跳」了一下。 */
export const SETTLE_MS = 180;

/** 阻尼比略小于 1：尾巴有一点点回弹，是 iOS 那种「有重量」的关键。 */
export const SPRING = {
  damping: 26,
  stiffness: 240,
  mass: 0.9,
  overshootClamping: false,
} as const;

export const NATIVE = Platform.OS !== "web";

/**
 * 抽屉的进出场。
 *
 * 退场动画是这里最要紧的一件事：只做进场、点外面直接卸载，抽屉就是「啪」
 * 地消失——这是 iOS 随手一碰都有、我们这边最缺的那一下。onClosed 要等退场
 * 真的跑完再调，否则组件已经没了，动画等于没做。
 *
 * @param travel 面板要走的距离（像素）。进场从 travel 下方滑到 0。
 */
export function useSheetMotion(travel: number, onClosed: () => void) {
  const anim = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: SHEET_MS,
      easing: IOS_EASE,
      useNativeDriver: NATIVE,
    }).start();
  }, [anim]);

  const close = useCallback(() => {
    // 连点两下别把退场动画跑两遍，第二遍的 onClosed 会打在已经卸载的组件上
    if (closing.current) return;
    closing.current = true;
    Animated.timing(anim, {
      toValue: 0,
      duration: EXIT_MS,
      // 退场用线性偏快的那头：入场是「被拉出来」，退场是「被收回去」，
      // 两者用同一条曲线会显得退场在拖
      easing: Easing.bezier(0.4, 0, 1, 1),
      useNativeDriver: NATIVE,
    }).start(({ finished }) => {
      if (finished) onClosedRef.current();
    });
  }, [anim]);

  /** 手指已经拖下来多少（0 = 刚按下，1 = 拖到底）。用来把面板跟���指头。 */
  const progress = useCallback(
    (offset: number) => {
      anim.setValue(1 - Math.min(1, Math.max(0, offset / travel)));
    },
    [anim, travel],
  );

  /** 松手：拖过一半就收回去，否则弹回去 */
  const settle = useCallback(
    (offset: number) => {
      if (offset > travel * 0.32) {
        close();
      } else {
        Animated.spring(anim, { toValue: 1, ...SPRING, useNativeDriver: NATIVE }).start();
      }
    },
    [anim, close, travel],
  );

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [travel, 0],
  });

  return { anim, translateY, close, progress, settle };
}

/**
 * 抽屉下拉的 PanResponder 手势，摊平成一组 props 直接 {...} 铺到 View 上。
 *
 * 只在**从上往下**的方向接管：往上是列表滚动，往下没到阈值松手又会弹回去，
 * 两个方向抢同一个手势就是列表滑不动、手感发涩的根源。所以第一段位移必须是
 * 正的 y，且要先越过 2px 死区才认这次拖拽。
 *
 * @param progress 拖动过程中把像素换算成进度给面板
 * @param settle   松手时给累计位移，由调用方判阈值决定弹回还是收掉
 * @param offsetRef 一个跨帧存位移的 ref（组件自己建就行，调用方不用管）
 */
export function sheetGesture(
  progress: (offset: number) => void,
  settle: (offset: number) => void,
  offsetRef: { current: number },
) {
  // 这里刻意每次新建 responder 而不缓存：progress/settle 每帧都在变，
  // 用 useMemo 包住反而要操心闭包过期那套。抽屉只有一个，代价可以忽略
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 2 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        offsetRef.current = 0;
      },
      onPanResponderMove: (_e, g) => {
        offsetRef.current = Math.max(0, g.dy);
        progress(offsetRef.current);
      },
      onPanResponderRelease: () => settle(offsetRef.current),
      onPanResponderTerminate: () => settle(offsetRef.current),
    }),
  ).current;
  return pan.panHandlers;
}