import { Pressable, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./theme";
import { GlassSurface } from "./glass";

/** 顶部横幅（连接状态、活动提示）—— 磨砂，不透明底会挡住下面的滚动内容。
 *  横幅挂在路由层最顶上（Stack 之外），页面自己的 SafeAreaView 护不到它：
 *  玻璃底要铺满到屏幕顶（含状态栏/刘海），文字再压到安全区之下，
 *  否则文案正好印在 iPhone 时钟上。 */
export function Banner({
  text,
  tone = "info",
  action,
}: {
  text: string;
  tone?: "info" | "danger";
  action?: { label: string; onPress: () => void };
}) {
  const { colors, space, fontWeight } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <GlassSurface
      thickness="regular"
      level={tone === "danger" ? 70 : 60}
      radius={0}
      bordered={false}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space(3),
        paddingHorizontal: space(4),
        paddingTop: insets.top + space(1),
        paddingBottom: space(2),
      }}
    >
      <Text
        style={{ flex: 1, color: tone === "danger" ? colors.destructive : colors.mutedForeground, fontSize: 13 }}
        numberOfLines={2}
      >
        {text}
      </Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: fontWeight("600") }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </GlassSurface>
  );
}
