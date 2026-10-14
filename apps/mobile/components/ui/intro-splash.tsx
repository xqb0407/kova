import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { ENTER_MS, NATIVE } from "./motion";
import logo from "../../assets/images/icon.png";

/**
 * 自定义启动页（JS 层），与原生闪屏接成一镜：
 *
 *   原生闪屏（品牌满底 + 猫，200pt 居中，autoHide 关掉）
 *     → 首帧提交后 hideAsync 淡出，露出的是这层**同色同位**的铺满视图
 *     → 「扣瓦」字标淡入上浮一拍
 *     → 整层淡出，露出配对屏/首页。
 *
 * 刻意克制：logo 不做弹跳——原生闪屏里的猫是静止的，JS 层再弹一下就是
 * 「两个动画接力」，观感反而廉价；连续性本身就是那个「酷」。动效只给字标，
 * 曲线沿用 motion.ts 的 iOS 减速档。
 *
 * 底色写死品牌长春花蓝而不是跟主题：原生闪屏不分深浅色都是它，
 * JS 层跟主题走反而会在交接瞬间变色。
 */

const BRAND = "#5E7AD0";
/** 字标进场前留的静默：太快会跟闪屏淡出叠在一起，看不清是谁在动 */
const WORD_DELAY_MS = 180;
/** 字标落定后的停留 */
const HOLD_MS = 1150;
/** 整层退场：比进场慢一档，收束要稳 */
const EXIT_MS = 340;

export function IntroSplash({ onDone }: { onDone: () => void }) {
  const word = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(WORD_DELAY_MS),
      Animated.timing(word, {
        toValue: 1,
        duration: ENTER_MS + 120,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
        useNativeDriver: NATIVE,
      }),
    ]).start();

    const timer = Animated.sequence([
      Animated.delay(WORD_DELAY_MS + ENTER_MS + 120 + HOLD_MS),
      Animated.timing(exit, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: NATIVE,
      }),
    ]);
    timer.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => timer.stop();
  }, [word, exit, onDone]);

  return (
    // pointerEvents=none：开场层不该吃掉这一秒半里用户已经想点的任何一下
    <Animated.View
      pointerEvents="none"
      collapsable={false}
      style={[StyleSheet.absoluteFill, styles.root, { opacity: exit }]}
    >
      {/* 猫身后一团更亮的晕：给纯色底一点纵深，不喧宾夺主 */}
      <View style={styles.glow} />
      <Image source={logo} style={styles.logo} contentFit="cover" />
      <Animated.Text
        style={[
          styles.word,
          {
            opacity: word,
            transform: [
              {
                translateY: word.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
              },
            ],
          },
        ]}
      >
        扣瓦
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BRAND,
    alignItems: "center",
    justifyContent: "center",
  },
  glow: {
    position: "absolute",
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: "#7C8AE8",
    opacity: 0.35,
  },
  // 与原生闪屏的 imageWidth: 200 同尺寸同居中：交接瞬间猫纹丝不动
  logo: {
    width: 200,
    height: 200,
    borderRadius: 44,
  },
  // 绝对定位挂在 logo 下缘：参与布局会把猫顶离屏幕中心，交接就跳了
  word: {
    position: "absolute",
    top: "50%",
    // logo 半高 100 + 间距 22
    marginTop: 122,
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 6,
  },
});
