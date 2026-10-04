import { useRef, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { XIcon } from "lucide-react-native";

import { useTheme, withAlpha } from "./theme";
import { GlassView, liquidGlassAvailable } from "./glass";
import { sheetGesture, useSheetMotion } from "./motion";

/**
 * 底部抽屉的外壳：遮罩 + 面板 + 抓手条 + 下拉手势，一次性封装。
 *
 * 之前 OptionSheet / SettingsSheet 各自复制了一整套：遮罩色、圆角、投影、
 * 手势接线双份维护，改一处漏一处。内容抽屉只管往这里放标题和列表，
 * 「点外面要能关、拉下来要能收、退场要播完」这些行为保证一致。
 *
 * 遮罩与面板走**同一个** Animated.Value：暗场深度跟着面板位移同步，
 * 不会出现面板到位了遮罩还没淡到的脱节。黑色 38% —— iOS 模态 dimming 的
 * 量级，浅色底下依旧通透，但「下面那层暂时不能碰」的信号必须给足。
 */
export function Sheet({
  onClose,
  travel,
  showClose,
  closeLabel = "关闭",
  sheetStyle,
  children,
}: {
  onClose: () => void;
  /** 面板要走完的距离（≈面板最大高度）。进出场和下拉阈值都以它为准 */
  travel: number;
  /** 抓手条右侧放一个圆形关闭钮（内容多的抽屉用得上） */
  showClose?: boolean;
  /** 遮罩 / 关闭钮的无障碍标签 */
  closeLabel?: string;
  /** 面板自身的高度约束（maxHeight 或固定 height）等 */
  sheetStyle?: StyleProp<ViewStyle>;
  /** 内容。需要「带退场动画地关掉自己」的（选中项后收起）用函数形态拿 close */
  children: ReactNode | ((sheet: { close: () => void }) => ReactNode);
}) {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const drag = useRef(0);
  const { anim, translateY, close, progress, settle } = useSheetMotion(travel, onClose);

  const content = typeof children === "function" ? children({ close }) : children;

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View style={[styles.scrim, { opacity: anim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel={closeLabel}
          onPress={close}
        />
      </Animated.View>

      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          transform: [{ translateY }],
        }}
        {...sheetGesture(progress, settle, drag)}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: withAlpha(colors.foreground, 0.12),
              paddingBottom: insets.bottom,
            },
            sheetStyle,
          ]}
        >
          {/* 抓手条：先给用户一个「这层能往下拉、点外面能关」的信号 */}
          <View style={styles.gripRow} {...sheetGesture(progress, settle, drag)}>
            <View
              style={[styles.grip, { backgroundColor: withAlpha(colors.foreground, 0.22) }]}
            />
            {showClose ? (
              liquidGlassAvailable ? (
                // iOS 26+：系统玻璃圆钮（与首页头部的图标胶囊同款），
                // isInteractive 让按压带液态玻璃形变；命中区交给铺满的 Pressable。
                <GlassView
                  glassEffectStyle="regular"
                  isInteractive
                  colorScheme={scheme}
                  style={styles.close}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={closeLabel}
                    onPress={close}
                    style={({ pressed }) => [
                      styles.closeHit,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <XIcon size={16} strokeWidth={2.4} color={colors.foreground} />
                  </Pressable>
                </GlassView>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={closeLabel}
                  hitSlop={10}
                  onPress={close}
                  style={({ pressed }) => [
                    styles.close,
                    { backgroundColor: withAlpha(colors.foreground, 0.06) },
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <XIcon size={16} strokeWidth={2.4} color={colors.foreground} />
                </Pressable>
              )
            ) : null}
          </View>

          {content}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.38)" },
  // 纯底面板：磨砂会把抽屉里的内容糊成一片色块，字压在上面发虚。
  // 投影只往上落——面板是压在页面之上的一层，影落在下方内容上才像浮起来
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#0b1020",
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 24,
  },
  gripRow: { height: 40, alignItems: "center", justifyContent: "center" },
  grip: { width: 38, height: 4, borderRadius: 2 },
  close: {
    position: "absolute",
    right: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  // 玻璃壳内的命中层：铺满 28×28 并居中图标
  closeHit: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
