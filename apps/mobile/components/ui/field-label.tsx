import { Text } from "react-native";
import type { ReactNode } from "react";
import { useTheme } from "./theme";

/** 段落小标题（表单分组用） */
export function FieldLabel({ children }: { children: ReactNode }) {
  const { colors, space, fontWeight } = useTheme();
  return (
    <Text
      style={{
        color: colors.mutedForeground,
        fontSize: 13,
        fontWeight: fontWeight("500"),
        marginBottom: space(1.5),
      }}
    >
      {children}
    </Text>
  );
}
