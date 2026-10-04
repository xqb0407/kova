import { useMemo } from "react";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ActionButton } from "@/components/ui/action-button";
import { fontWeight, space, useTheme } from "@/components/ui/theme";

/**
 * 步骤页共享部件，与桌面端 steps/step-parts.tsx 同语义：
 * 标题块、底部导航（上一步 / 跳过这一步 / 下一步）。
 * onSkip 是「跳过这一节」（记 done=false 继续走），与顶栏的「跳过」
 * （结束整个引导）是两回事。
 */

export function StepHeading({ title, desc }: { title: string; desc?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.heading}>
      <Text style={styles.headingTitle}>{title}</Text>
      {desc ? <Text style={styles.headingDesc}>{desc}</Text> : null}
    </View>
  );
}

export function StepFooter({
  onBack,
  onSkip,
  children,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  children?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.footer}>
      {onBack ? (
        <ActionButton label="上一步" variant="ghost" onPress={onBack} />
      ) : null}
      <View style={styles.footerSpacer} />
      {onSkip ? (
        <ActionButton label="跳过这一步" variant="ghost" onPress={onSkip} />
      ) : null}
      {children}
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors } = t;
    return StyleSheet.create({
      heading: { gap: space(1.5), marginBottom: space(6) },
      headingTitle: {
        color: colors.foreground,
        fontSize: 22,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.3,
      },
      headingDesc: {
        color: colors.mutedForeground,
        fontSize: 14,
        lineHeight: 21,
      },
      footer: {
        flexDirection: "row",
        alignItems: "center",
        gap: space(2),
        marginTop: space(8),
      },
      footerSpacer: { flex: 1 },
    });
  }, [t]);
}
