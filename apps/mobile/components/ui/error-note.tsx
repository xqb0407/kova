import { Text, View } from "react-native";
import type { ReactNode } from "react";
import { useTheme } from "./theme";

/** 内联错误条 */
export function ErrorNote({ children }: { children: ReactNode }) {
  const { colors, radius, space } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: colors.destructive,
        paddingHorizontal: space(3),
        paddingVertical: space(2),
      }}
    >
      <Text style={{ color: colors.destructive, fontSize: 13, lineHeight: 18 }}>
        {children}
      </Text>
    </View>
  );
}
