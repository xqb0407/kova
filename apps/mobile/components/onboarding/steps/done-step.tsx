import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { CheckIcon, CircleIcon, SparklesIcon } from "lucide-react-native";
import { ActionButton } from "@/components/ui/action-button";
import { fontWeight, radius, space, useTheme, withAlpha } from "@/components/ui/theme";
import { ONBOARDING_SECTIONS } from "../onboarding-sections";
import { useOnboarding } from "../onboarding-context";
import logo from "../../../assets/images/icon.png";

/**
 * 完成页：按 ONBOARDING_SECTIONS 逐条回顾这次配了什么。
 * 条目不写死：清单加一节，这里自动多一行；跳过的项照实显示为未配置。
 * 「开始使用」收起引导露出配对屏；已配对时（重新查看引导）收起即回首页。
 */

export function DoneStep() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { results, finish, back } = useOnboarding();

  return (
    <View style={styles.root}>
      <Image source={logo} style={styles.logo} contentFit="cover" />
      <Text style={styles.title}>配置好了</Text>
      <Text style={styles.desc}>随时可以在设置里改，接下来就交给你了。</Text>

      <View style={styles.list}>
        {ONBOARDING_SECTIONS.map((section) => {
          const result = results[section.id];
          const done = !!result?.done;
          return (
            <View key={section.id} style={styles.row}>
              {done ? (
                <CheckIcon size={16} strokeWidth={2} color={colors.primary} />
              ) : (
                <CircleIcon
                  size={16}
                  strokeWidth={2}
                  color={withAlpha(colors.mutedForeground, 0.5)}
                />
              )}
              <Text
                style={[
                  styles.rowText,
                  { color: done ? colors.primary : colors.mutedForeground },
                ]}
              >
                {done
                  ? `${section.title} · ${result?.summary ?? "已配置"}`
                  : `${section.title}未配置 —— ${section.missing}`}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.tip}>
        <SparklesIcon size={15} strokeWidth={1.8} color={colors.mutedForeground} />
        <Text style={styles.tipText}>
          配对屏支持扫码：桌面端「远程访问」窗口里的二维码对准即可；地址栏直接粘贴二维码原文也能识别。
        </Text>
      </View>

      <View style={styles.actions}>
        <ActionButton label="开始使用" onPress={finish} />
        <ActionButton label="回去改改" variant="ghost" onPress={back} />
      </View>
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors } = t;
    return StyleSheet.create({
      root: { gap: space(2), alignItems: "flex-start" },
      logo: {
        width: 56,
        height: 56,
        borderRadius: radius.xl,
        marginBottom: space(1),
      },
      title: {
        color: colors.foreground,
        fontSize: 24,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.3,
      },
      desc: {
        color: colors.mutedForeground,
        fontSize: 14,
        lineHeight: 20,
      },
      list: { marginTop: space(4), alignSelf: "stretch", gap: space(1) },
      row: {
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space(2.5),
        paddingVertical: space(1.5),
      },
      rowText: { flex: 1, color: colors.primary, fontSize: 14, lineHeight: 20 },
      rowMuted: { color: colors.mutedForeground },
      tip: {
        alignSelf: "stretch",
        flexDirection: "row",
        gap: space(2.5),
        alignItems: "flex-start",
        backgroundColor: withAlpha(colors.foreground, 0.04),
        borderRadius: radius["2xl"],
        padding: space(4),
        marginTop: space(3),
      },
      tipText: {
        flex: 1,
        color: colors.mutedForeground,
        fontSize: 12.5,
        lineHeight: 19,
      },
      actions: {
        flexDirection: "row",
        gap: space(2),
        marginTop: space(5),
      },
    });
  }, [t]);
}
