import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useTheme, withAlpha } from "./theme";
import { GlassContainer, GlassControl, liquidGlassAvailable } from "./glass";
import { ENTER_MS, EXIT_MS, IOS_EASE, NATIVE } from "./motion";

/**
 * 长按弹出的上下文菜单。
 *
 * 不是底部抽屉：长按的语义是「就地取材」，菜单要贴着手指长出来，视线不用离开
 * 被按住的那一行。所以这里不用 Sheet，而是在触点附近定位一块浮层。
 *
 * 三个位置细节（都按 iOS 的规矩来）：
 * - 优先出现在手指**上方**——手指和它的影子正好挡住下方；上方放不下才翻到下面。
 * - 水平居中在触点上，但贴边时向里收，不让菜单被屏幕切掉。
 * - 缩放锚点取靠近触点的那条边，菜单看起来是从手指底下「长」出来的，
 *   而不是凭空在中间放大。
 *
 * 出场比进场快一档（EXIT_MS < ENTER_MS）：用户已经点完了，再让他等就是惩罚。
 */

export type ContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onPress: () => void;
  /** 破坏性动作（删除），红色 */
  destructive?: boolean;
};

/** 一行的固定高度。定位要用它估菜单总高，所以和样式里的值必须一致 */
const ITEM_HEIGHT = 44;
const MENU_WIDTH = 216;
const EDGE = 12;

export function ContextMenu({
  anchor,
  items,
  onClose,
}: {
  /** 触点在屏幕上的位置；null 表示不显示 */
  anchor: { x: number; y: number } | null;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}) {
  const { colors, fontWeight } = useTheme();
  const { width: winW, height: winH } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  useEffect(() => {
    if (!anchor) return;
    closing.current = false;
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1,
      duration: ENTER_MS,
      easing: IOS_EASE,
      useNativeDriver: NATIVE,
    }).start();
  }, [anchor, anim]);

  // 先播退场再让父级卸载：直接 onClose 的话菜单是「啪」地消失
  const close = useCallback(
    (after?: () => void) => {
      if (closing.current) return;
      closing.current = true;
      Animated.timing(anim, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.bezier(0.4, 0, 1, 1),
        useNativeDriver: NATIVE,
      }).start(({ finished }) => {
        if (!finished) return;
        after?.();
        onClose();
      });
    },
    [anim, onClose],
  );

  if (!anchor) return null;

  const menuH = items.length * ITEM_HEIGHT + 12;
  // 上方放得下就放上方；放不下翻到下方；两边都不够就贴着上边排
  const above = anchor.y - menuH - EDGE >= EDGE;
  const top = above
    ? anchor.y - menuH - EDGE
    : Math.min(anchor.y + EDGE, winH - menuH - EDGE);
  const left = Math.min(
    Math.max(anchor.x - MENU_WIDTH / 2, EDGE),
    winW - MENU_WIDTH - EDGE,
  );

  // 面板本体：底色由 scrim 自给自足（见下），玻璃材质交给外层容器/玻璃件
  const panel = (
    <GlassControl radius={18} style={styles.panel}>
      {/* 面板底色必须自给自足，不能指望玻璃材质：玻璃件的效果安装在祖先
          alpha ≤ 0.02 时会被 UIKit 静默跳过、之后靠轮询补装且时机不保证（同
          home-header 的坑），没装上的场合整块菜单就是全透的。这层 97% card 色
          的 scrim 是普通 View，任何平台、任何一帧都在：玻璃好的平台它压淡
          材质、留 3% 缝隙透一点玻璃感；回退平台它就是唯一的底色。放在
          GlassControl 内部（首个子节点）才会被圆角裁剪、又压在菜单项下。 */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            // 0.97 ≈ 系统菜单的实底感：0.9 的那版压在长列表上还是透出行内容
            backgroundColor: withAlpha(colors.card, 0.97),
            borderColor: withAlpha(colors.foreground, 0.12),
            borderWidth: StyleSheet.hairlineWidth,
          },
        ]}
      />
      {items.map((item, index) => (
        <View key={item.label}>
          {index > 0 ? (
            <View
              style={[
                styles.hairline,
                { backgroundColor: withAlpha(colors.foreground, 0.08) },
              ]}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={() => close(item.onPress)}
            style={({ pressed }) => [
              styles.item,
              pressed && {
                backgroundColor: withAlpha(colors.foreground, 0.06),
              },
            ]}
          >
            <Text
              style={{
                flex: 1,
                color: item.destructive ? colors.destructive : colors.foreground,
                fontSize: 16,
                fontWeight: fontWeight("400"),
                letterSpacing: -0.2,
              }}
            >
              {item.label}
            </Text>
            {item.icon ? (
              <View style={styles.itemIcon}>{item.icon}</View>
            ) : null}
          </Pressable>
        </View>
      ))}
    </GlassControl>
  );

  return (
    // 遮罩不压暗：iOS 的上下文菜单背后是原样透出来的，压暗反而像弹了模态框。
    // 它只负责吃掉这一下点击（关闭）和拦住底下的行
    <Pressable style={StyleSheet.absoluteFill} onPress={() => close()}>
      <Animated.View
        style={{
          position: "absolute",
          top,
          left,
          width: MENU_WIDTH,
          // 抬起来的一层影：scrim 接近实底后玻璃 rim 被压住，面板的「浮」全靠
          // 它。挂在 Animated.View 上——panel 自己 overflow hidden 会裁掉阴影
          shadowColor: "#0b1020",
          shadowOpacity: 0.2,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 10 },
          opacity: anim,
          transform: [
            {
              scale: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.86, 1],
              }),
            },
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [above ? 8 : -8, 0],
              }),
            },
          ],
          // 从靠近触点的那条边长出来（RN 0.76+ 支持 transformOrigin）
          transformOrigin: above ? "bottom center" : "top center",
        }}
      >
        {/* iOS 26 再用对应的玻璃容器包一层：容器自己挂 UIGlassContainerEffect，
            内部 GlassView 与它融合成一整块连续玻璃，效果安装走 props 赋值、
            没有 GlassView 单独安装的那套 alpha 门槛 + 轮询补装竞态；spacing
            必须给数值——不传的话原生侧 setSpacing 不会被触发、效果根本不挂。
            其余平台直接渲染面板。 */}
        {liquidGlassAvailable ? (
          <GlassContainer spacing={12} style={styles.glassContainer}>
            {panel}
          </GlassContainer>
        ) : (
          panel
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 底色/描边由上面那层 scrim 自给自足（玻璃件的效果安装不保证时机），这里的
  // overflow 只为了让圆角把 scrim 和子行切干净
  panel: { overflow: "hidden", paddingVertical: 6 },
  // 玻璃容器的形状层：与 panel 同半径，玻璃材质被裁进圆角里
  glassContainer: { borderRadius: 18, overflow: "hidden" },
  item: {
    height: ITEM_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 12,
  },
  // 文案在左、图标在右：iOS 的菜单就是这个次序，图标是「这一项做什么」的
  // 补充，不是行首的装饰
  itemIcon: { opacity: 0.75 },
  hairline: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
