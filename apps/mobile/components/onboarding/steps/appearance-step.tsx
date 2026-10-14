import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react-native";
import { ActionButton } from "@/components/ui/action-button";
import { fontWeight, radius, space, useTheme, withAlpha } from "@/components/ui/theme";
import {
  setThemeMode,
  useThemeMode,
  type ThemeMode,
} from "@/lib/settings/appearance-settings";
import { useOnboarding } from "../onboarding-context";
import { StepFooter, StepHeading } from "./step-parts";

/**
 * 外观：主题档位（跟随系统 / 浅色 / 深色）。与桌面端 appearance-step 同位，
 * 但只保留主题一档——强调色、字号、对话宽度是桌面端渲染语境里的东西，
 * 移动端的主题令牌表里也没有对应旋钮。
 *
 * 改的是 appearance-settings 那份偏好，与 ThemeProvider 读同一份数据，
 * 点下去整屏即时换色（引导页本身就跟着变，所见即所得）。
 */

const THEMES: { value: ThemeMode; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "跟随系统", Icon: MonitorIcon },
  { value: "light", label: "浅色", Icon: SunIcon },
  { value: "dark", label: "深色", Icon: MoonIcon },
];

export function AppearanceStep() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { next, back, patch } = useOnboarding();
  const mode = useThemeMode();

  // 三档都有默认值，走完这一步就算配过了；完成清单显示当前档
  const label = THEMES.find((t) => t.value === mode)?.label ?? "跟随系统";
  useEffect(() => {
    patch("appearance", { done: true, summary: label });
  }, [patch, label]);

  return (
    <View>
      <StepHeading
        title="挑个顺眼的样子"
        desc="只是起点，之后在「设置」里随时能改。"
      />
      <View style={styles.grid}>
        {THEMES.map(({ value, label: optionLabel, Icon }) => {
          const active = mode === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setThemeMode(value)}
              style={({ pressed }) => [
                styles.cell,
                active && styles.cellActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Icon
                size={20}
                strokeWidth={1.8}
                color={active ? colors.foreground : colors.mutedForeground}
              />
              <Text
                style={[styles.cellLabel, active && { color: colors.foreground }]}
              >
                {optionLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {/* 跳过只放行不撤销：选档是即时生效的，没有「草稿」可丢 */}
      <StepFooter onBack={back} onSkip={next}>
        <ActionButton label="下一步" onPress={next} />
      </StepFooter>
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors: c } = t;
    return StyleSheet.create({
      grid: { flexDirection: "row", gap: space(2) },
      cell: {
        flex: 1,
        height: 84,
        alignItems: "center",
        justifyContent: "center",
        gap: space(2),
        borderRadius: radius["2xl"],
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: withAlpha(c.foreground, 0.12),
        backgroundColor: withAlpha(c.foreground, 0.03),
      },
      cellActive: {
        borderColor: withAlpha(c.foreground, 0.35),
        backgroundColor: withAlpha(c.foreground, 0.07),
      },
      cellLabel: {
        color: c.mutedForeground,
        fontSize: 13,
        fontWeight: fontWeight("500"),
      },
    });
  }, [t]);
}
