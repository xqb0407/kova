import {
  ActivityIndicator,
  Pressable,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "./theme";

/**
 * 圆角按钮：primary 实心、ghost 毛玻璃描边、danger 用于不可逆动作。
 * 样式走 useTheme() 而非模块级 StyleSheet——主题跟着系统深浅色变，
 * 静态 StyleSheet 没法在两套令牌间切换。
 */
export function ActionButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius, space, fontWeight } = useTheme();
  const inactive = disabled || busy;
  const fg =
    variant === "primary"
      ? colors.primaryForeground
      : variant === "danger"
        ? colors.destructive
        : colors.mutedForeground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 44,
          paddingHorizontal: space(4),
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: "transparent",
        },
        variant === "primary" && { backgroundColor: colors.primary },
        variant === "ghost" && {
          borderColor: colors.border,
          backgroundColor: colors.muted,
        },
        variant === "danger" && { borderColor: colors.destructive, backgroundColor: "transparent" },
        pressed && !inactive && { opacity: 0.75 },
        inactive && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: 15, fontWeight: fontWeight("600") }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
