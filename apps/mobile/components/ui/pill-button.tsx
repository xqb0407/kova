import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from "react-native";
import { fontWeight, useTheme } from "./theme";

/**
 * 胶囊按钮：primary 实心、ghost 灰底，用于浮层卡片的操作行（审批卡/提问卡）。
 * 相比 ActionButton 的方块形，胶囊更贴 iOS 弹层语言；busy 时转圈防重复提交。
 */
export function PillButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, space } = useTheme();
  const inactive = disabled || busy;
  const fg =
    variant === "primary" ? colors.primaryForeground : colors.mutedForeground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 38,
          paddingHorizontal: space(4),
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
        },
        variant === "primary"
          ? { backgroundColor: colors.primary }
          : { backgroundColor: colors.muted },
        pressed && !inactive && { opacity: 0.75 },
        inactive && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text
          style={{
            color: fg,
            fontSize: 14,
            fontWeight: variant === "primary" ? fontWeight("600") : fontWeight("500"),
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
