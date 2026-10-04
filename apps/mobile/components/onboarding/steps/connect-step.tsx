import { useEffect, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ActionButton } from "@/components/ui/action-button";
import { fontWeight, radius, space, useTheme, withAlpha } from "@/components/ui/theme";
import { useOnboarding } from "../onboarding-context";
import { StepFooter, StepHeading } from "./step-parts";

/**
 * 连接指引：把「怎么把手机连上桌面端」讲清楚，点下一步后落到配对屏。
 *
 * 这一步不验证连接结果——真正的配对发生在配对屏（扫码 / 手输 + 6 位码），
 * 引导页只负责让人知道去哪儿开网关。所以「完成」的含义是「已了解配对方式」，
 * 跳过也只是不再讲，不影响配对屏照常工作。
 */

const STEPS = [
  "在桌面端打开「设置 → 远程访问」，开启网关并允许局域网访问。",
  "回到配对屏扫桌面端窗口里的二维码，或手输地址 + 6 位配对码。",
  "配对成功后凭据存进系统钥匙串，之后打开应用自动重连。",
];

export function ConnectStep() {
  const styles = useStyles();
  const { next, back, patch } = useOnboarding();

  useEffect(() => {
    patch("connect", { done: true, summary: "配对方式已了解" });
  }, [patch]);

  return (
    <View>
      <StepHeading
        title="连上你的桌面端"
        desc="手机不含后端：所有处理都在你的桌面端，这里只做三件事的说明。"
      />
      <View style={styles.list}>
        {STEPS.map((line, i) => (
          <View key={line} style={styles.row}>
            <View style={styles.index}>
              <Text style={styles.indexText}>{i + 1}</Text>
            </View>
            <Text style={styles.rowText}>{line}</Text>
          </View>
        ))}
      </View>
      <StepFooter onBack={back} onSkip={() => { patch("connect", { done: false }); next(); }}>
        <ActionButton label="下一步" onPress={next} />
      </StepFooter>
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors } = t;
    return StyleSheet.create({
      list: { gap: space(4) },
      row: { flexDirection: "row", gap: space(3), alignItems: "flex-start" },
      index: {
        width: 24,
        height: 24,
        borderRadius: radius.pill,
        backgroundColor: withAlpha(colors.foreground, 0.06),
        alignItems: "center",
        justifyContent: "center",
        marginTop: 1,
      },
      indexText: {
        color: colors.mutedForeground,
        fontSize: 12,
        fontWeight: fontWeight("600"),
        fontVariant: ["tabular-nums"],
      },
      rowText: {
        flex: 1,
        color: colors.foreground,
        fontSize: 14.5,
        lineHeight: 22,
      },
    });
  }, [t]);
}
