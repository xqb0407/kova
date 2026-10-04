import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GlassControl } from "./glass";
import { useTheme, withAlpha } from "./theme";

/**
 * 重命名弹窗（居中卡片）。
 *
 * 不用 Alert.prompt：那是 iOS 原生专属，Android 的 Alert 没有输入形态，
 * RN Web 更是只落到 console——三个端各写一套不如一个自建 Modal，
 * 反正样式本来就得跟主题走。
 */
export function RenameDialog({
  initialTitle,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  onCancel: () => void;
  onSubmit: (next: string) => void;
}) {
  const { colors, radius, space, fontWeight } = useTheme();
  const [text, setText] = useState(initialTitle);
  const canSubmit = text.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(text.trim());
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      {/* 输入框 autoFocus，键盘一起来就占掉下半屏。卡片是居中的，不缩容器的话
          「保存 / 取消」那排正好落在键盘底下——看得见弹窗却点不到确认键。
          套一层 KeyboardAvoidingView，可用高度少掉键盘那一截，居中位置自然
          上移，按钮就回到键盘上方了。 */}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.38)" }]}
          onPress={onCancel}
        >
          {/* 卡片吃掉点击，别让它冒到背板把弹窗关了。
              卡片本身走 GlassControl：iOS 26 上是真 UIGlassEffect——弹窗压在
              压暗的背板上，正是玻璃最出效果的地方（底下那层暗被折射出来）。
              fill 只管回退路径：默认那层淡填充在压暗的背板上会透出灰底，
              文字对比度不够，这里给接近不透明的 card 底。 */}
          <GlassControl
            radius={radius["2xl"]}
            fill={withAlpha(colors.card, 0.97)}
            style={{
              width: "86%",
              maxWidth: 360,
              gap: space(4),
              padding: space(5),
            }}
          >
            <Text
              style={{
                color: colors.foreground,
                fontSize: 17,
                fontWeight: fontWeight("700"),
              }}
            >
              重命名对话
            </Text>
            {/* 输入框同样包一层玻璃。GlassControl 默认那圈白描边 + 投影是给
                「浮起来的按钮」用的，字段是凹进去的槽，用 style 把它们压掉，
                只留玻璃材质和半径。 */}
            <GlassControl
              radius={radius.md}
              fill={withAlpha(colors.foreground, 0.06)}
              style={{
                // 压掉 GlassControl 默认那圈白描边与投影：那是给「浮起来的
                // 按钮」用的，字段是凹进去的槽。白描边压在浅色底上等于没有边，
                // 所以轮廓另取前景色的淡一层。
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: withAlpha(colors.foreground, 0.16),
                shadowOpacity: 0,
                shadowRadius: 0,
                elevation: 0,
              }}
            >
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="对话标题"
                placeholderTextColor={colors.mutedForegroundFaint}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                onSubmitEditing={submit}
                style={{
                  color: colors.foreground,
                  fontSize: 15,
                  paddingHorizontal: space(3),
                  paddingVertical: space(2.5),
                  minHeight: 44,
                }}
              />
            </GlassControl>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: space(2),
              }}
            >
              <Pressable
                accessibilityRole="button"
                onPress={onCancel}
                style={{
                  paddingHorizontal: space(4),
                  paddingVertical: space(2),
                  borderRadius: radius.pill,
                  backgroundColor: colors.muted,
                }}
              >
                <Text style={{ color: colors.mutedForeground, fontSize: 15 }}>
                  取消
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!canSubmit}
                onPress={submit}
                style={{
                  paddingHorizontal: space(4),
                  paddingVertical: space(2),
                  borderRadius: radius.pill,
                  backgroundColor: colors.primary,
                  opacity: canSubmit ? 1 : 0.4,
                }}
              >
                <Text
                  style={{
                    color: colors.primaryForeground,
                    fontSize: 15,
                    fontWeight: fontWeight("600"),
                  }}
                >
                  保存
                </Text>
              </Pressable>
            </View>
          </GlassControl>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center" },
});
