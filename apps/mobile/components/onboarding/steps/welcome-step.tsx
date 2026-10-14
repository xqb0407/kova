import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { ActionButton } from "@/components/ui/action-button";
import { fontWeight, radius, space, useTheme, withAlpha } from "@/components/ui/theme";
import { ONBOARDING_SECTIONS } from "../onboarding-sections";
import { useOnboarding } from "../onboarding-context";
import logo from "../../../assets/images/icon.png";

/**
 * 欢迎页：吉祥物 + 主标 + 行动，下面按 ONBOARDING_SECTIONS 列「接下来要走的几步」。
 * 桌面端是左右双栏（目录竖排在右），手机宽度只够单栏，目录改成带序号的竖排列表，
 * 读法不变：它们读作「接下来的几步」，不是功能罗列。
 */

export function WelcomeStep() {
  const styles = useStyles();
  const { next, finish } = useOnboarding();

  return (
    <View style={styles.root}>
      <Image
        source={logo}
        style={styles.logo}
        contentFit="cover"
        accessibilityLabel="扣瓦"
      />
      <Text style={styles.title}>两分钟，连上就能开工</Text>
      <Text style={styles.desc}>
        扣瓦跑在你的桌面端，手机随身带着同一个会话。
      </Text>

      <View style={styles.actions}>
        <ActionButton label="开始配置" onPress={next} />
        <ActionButton label="稍后再说" variant="ghost" onPress={finish} />
      </View>

      <View style={styles.toc}>
        {ONBOARDING_SECTIONS.map((section, i) => (
          <View key={section.id} style={styles.tocRow}>
            <Text style={styles.tocIndex}>{i + 1}</Text>
            <View style={styles.tocText}>
              <Text style={styles.tocTitle}>{section.title}</Text>
              <Text style={styles.tocDesc}>{section.desc}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors } = t;
    return StyleSheet.create({
      root: { gap: space(3) },
      logo: {
        width: 56,
        height: 56,
        borderRadius: radius.xl,
        marginBottom: space(1),
      },
      title: {
        color: colors.foreground,
        fontSize: 28,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.5,
        lineHeight: 34,
      },
      desc: {
        color: colors.mutedForeground,
        fontSize: 15,
        lineHeight: 22,
      },
      actions: {
        flexDirection: "row",
        gap: space(2),
        marginTop: space(2),
      },
      toc: {
        marginTop: space(6),
        gap: space(4),
        paddingLeft: space(4),
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: withAlpha(colors.foreground, 0.12),
      },
      tocRow: { flexDirection: "row", gap: space(3) },
      tocIndex: {
        color: withAlpha(colors.mutedForeground, 0.6),
        fontSize: 13,
        fontVariant: ["tabular-nums"],
        width: 16,
        lineHeight: 19,
      },
      tocText: { flex: 1, gap: 2 },
      tocTitle: {
        color: colors.foreground,
        fontSize: 14,
        fontWeight: fontWeight("500"),
      },
      tocDesc: {
        color: colors.mutedForeground,
        fontSize: 12.5,
        lineHeight: 18,
      },
    });
  }, [t]);
}
