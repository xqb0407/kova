import { Pressable, Text } from "react-native";
import { useTheme } from "./theme";

/** 可点文本按钮（行内操作用） */
export function LinkButton({
  label,
  onPress,
  tone = "muted",
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: "muted" | "foreground" | "danger";
  disabled?: boolean;
}) {
  const { colors, fontWeight } = useTheme();
  const color =
    tone === "danger"
      ? colors.destructive
      : tone === "foreground"
        ? colors.foreground
        : colors.mutedForeground;
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6}>
      <Text
        style={{
          color,
          fontSize: 13,
          fontWeight: fontWeight("500"),
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
