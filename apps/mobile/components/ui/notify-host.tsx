import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { subscribeNotify, type NotifyMessage } from "@/lib/host-effects";
import { useTheme, type ThemeColors } from "./theme";
import { GlassSurface } from "./glass";

/**
 * notify() 的唯一订阅方，挂在路由层最上面。
 *
 * 运行时模块（图片能力警告、审批被拒、队列溢出等）不能直接依赖 UI 组件，
 * 所以它们只往 host-effects 的总线上发一条 notify；这里负责呈现。
 *
 * 呈现形态对齐桌面端的 toast：顶部居中、毛玻璃、几秒后自动消失，最多同时
 * 叠三条，新的从下方推上来。用 Animated.timing 驱动 translateY + opacity，
 * 不引第三方动画库——一次性的进出场不值得。
 */

const VISIBLE_MS = 3200;
const EXIT_MS = 220;
const MAX_VISIBLE = 3;

export function NotifyHost() {
  const { colors, radius, space } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<{ message: NotifyMessage; y: Animated.Value }[]>([]);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const animate = (track: Animated.Value, to: number, ms: number) =>
      Animated.timing(track, {
        toValue: to,
        duration: ms,
        useNativeDriver: true,
      });

    const dismiss = (id: number) => {
      setItems((prev) => {
        const hit = prev.find((it) => it.message.id === id);
        if (hit) {
          animate(hit.y, -12, EXIT_MS).start(({ finished }) => {
            if (finished) {
              setItems((cur) => cur.filter((it) => it.message.id !== id));
            }
          });
        }
        return prev;
      });
    };

    const unsubscribe = subscribeNotify((message) => {
      if (message.level === "error" || message.level === "warning") {
        void Haptics.notificationAsync(
          message.level === "error"
            ? Haptics.NotificationFeedbackType.Error
            : Haptics.NotificationFeedbackType.Warning,
        );
      }

      const y = new Animated.Value(-12);
      y.setValue(-12);
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { message, y }]);
      animate(y, 0, 220).start();

      const hide = setTimeout(() => {
        timers.delete(hide);
        dismiss(message.id);
      }, VISIBLE_MS);
      timers.add(hide);
    });

    return () => {
      unsubscribe();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { top: insets.top + space(2), paddingHorizontal: space(4) }]}
    >
      {items.map(({ message, y }) => (
        <Animated.View key={message.id} style={{ opacity: y, transform: [{ translateY: y }] }}>
          <GlassSurface
            thickness="thick"
            level={70}
            radius={radius.xl}
            floating
            style={[styles.toast, { borderColor: tone(colors, message.level) }]}
          >
            <View style={[styles.dot, { backgroundColor: tone(colors, message.level) }]} />
            <Text style={[styles.text, { color: colors.foreground }]}>{message.text}</Text>
          </GlassSurface>
        </Animated.View>
      ))}
    </View>
  );
}

function tone(colors: ThemeColors, level: NotifyMessage["level"]): string {
  if (level === "error") return colors.destructive;
  if (level === "warning") return colors.warning;
  if (level === "success") return colors.success;
  return colors.mutedForeground;
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    gap: 8,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    maxWidth: 520,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: 13, lineHeight: 19, flexShrink: 1 },
});