import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { GlassControl } from "./glass";
import { useTheme, withAlpha } from "./theme";

/**
 * 网关不在线弹窗（"app 开着但桌面端/网关没开"）。
 *
 * 为什么是弹窗而不是一条底部横幅：这不是运行中的偶发断链，而是根本没连上——
 * 列表、会话、模型全拉不到，界面看起来就像坏了。而且底层那句
 * `[assistant-ui] thread list load failed` 走 console.error，在 RN 开发构建里
 * 会被 LogBox 弹成底部红条盖住 UI（已在 core 的 patch 里把 connectivity 类降级）。
 * 用户该看到的是能解释"发生了什么 + 怎么办"的弹窗，而不是一条技术错误。
 */
export function GatewayOfflineDialog({
  url,
  reason,
  onRetry,
  onRepair,
  onDismiss,
}: {
  /** 网关地址（告诉用户"连的是哪儿"，便于自查） */
  url: string;
  /** 失败原因（通道给的原话，通常是 connection closed / unauthorized） */
  reason: string;
  /** 立刻重连一次（清退避计数）并重拉会话清单 */
  onRetry: () => void;
  /** 重走配对（token 失效/换了网关） */
  onRepair: () => void;
  /** 稍后再说：本轮到下一次失败之前不再弹 */
  onDismiss: () => void;
}) {
  const { colors, radius, space, fontWeight, mono } = useTheme();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.38)" }]}
        onPress={onDismiss}
      >
        <Pressable onPress={() => {}} style={styles.cardWrap}>
          <GlassControl
            radius={radius["2xl"]}
            fill={withAlpha(colors.card, 0.97)}
            style={[
              styles.card,
              { borderColor: colors.border, gap: space(3), padding: space(4.5) },
            ]}
          >
            <Text
              style={{
                color: colors.foreground,
                fontSize: 17,
                fontWeight: fontWeight("700"),
              }}
            >
              连不上桌面端
            </Text>
            <Text
              style={{
                color: colors.mutedForeground,
                fontSize: 13.5,
                lineHeight: 19,
              }}
            >
              扣瓦的桌面端没有在运行，或手机不在同一个网络里。桌面端打开后会自动
              重连，不用回到配对页。
            </Text>
            <View
              style={[
                styles.meta,
                { borderRadius: radius.lg, borderColor: colors.border },
              ]}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: colors.mutedForeground,
                  fontSize: 12,
                  fontFamily: mono ?? undefined,
                }}
              >
                {url}
              </Text>
              {reason ? (
                <Text
                  numberOfLines={1}
                  style={{ color: colors.mutedForegroundFaint, fontSize: 11.5 }}
                >
                  {reason}
                </Text>
              ) : null}
            </View>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={onDismiss}
                style={({ pressed }) => [
                  styles.button,
                  {
                    borderRadius: radius.xl,
                    borderColor: colors.border,
                    backgroundColor: withAlpha(colors.foreground, 0.04),
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 15,
                    fontWeight: fontWeight("600"),
                  }}
                >
                  稍后
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={onRepair}
                style={({ pressed }) => [
                  styles.button,
                  {
                    borderRadius: radius.xl,
                    borderColor: colors.border,
                    backgroundColor: withAlpha(colors.foreground, 0.04),
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 15,
                    fontWeight: fontWeight("600"),
                  }}
                >
                  重新配对
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={({ pressed }) => [
                  styles.button,
                  {
                    borderRadius: radius.xl,
                    backgroundColor: colors.primary,
                    borderColor: "transparent",
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text
                  style={{
                    color: colors.primaryForeground,
                    fontSize: 15,
                    fontWeight: fontWeight("700"),
                  }}
                >
                  重试
                </Text>
              </Pressable>
            </View>
          </GlassControl>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  cardWrap: { width: "100%", maxWidth: 420 },
  card: { borderWidth: StyleSheet.hairlineWidth },
  meta: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: {
    minWidth: 72,
    height: 40,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
