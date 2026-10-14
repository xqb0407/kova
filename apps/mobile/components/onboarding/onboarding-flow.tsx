import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppBackground } from "@/components/ui/glass";
import { useTheme } from "@/components/ui/theme";
import { useOnboardingGate } from "./onboarding-gate";
import {
  EMPTY_RESULTS,
  OnboardingContext,
  type OnboardingContextValue,
  type OnboardingResults,
  type OnboardingSectionResult,
} from "./onboarding-context";
import { ONBOARDING_SECTIONS } from "./onboarding-sections";
import { WelcomeStep } from "./steps/welcome-step";
import { DoneStep } from "./steps/done-step";

/**
 * 首次启动的配置向导：欢迎页 → 连接指引 → 外观 → 完成页。
 * 与桌面端 onboarding-flow 同构：0 是欢迎页，1..N 是分区，N+1 是完成页；
 * 每一步都可跳过，跳过记完成标记、不写任何配置。
 *
 * 桌面端是盖在主界面上的 fixed 浮层；移动端同样渲染为不透明全屏层——
 * 未配对时盖住配对屏，已配对时（设置里「重新查看引导」）盖住首页。
 * 进度切换不做动画：桌面端靠 framer-motion，移动端为这一步引入动画库不值当。
 */

/** 参与进度计数的分区数（欢迎页与完成页不计入） */
const COUNTED_STEPS = ONBOARDING_SECTIONS.length;
/** 完成页在 step 上的位置：0 欢迎页，1..N 分区，N+1 完成页 */
const DONE_STEP = COUNTED_STEPS + 1;

export function OnboardingFlow() {
  const styles = useStyles();
  const { active, finish } = useOnboardingGate();
  const [step, setStep] = useState(0);
  const [results, setResults] = useState<OnboardingResults>(EMPTY_RESULTS);

  const patch = useCallback(
    (id: string, next: Partial<OnboardingSectionResult>) => {
      setResults((prev) => {
        const base = prev[id] ?? { done: false, summary: null };
        return { ...prev, [id]: { ...base, ...next } };
      });
    },
    [],
  );

  // 设置里「重新查看引导」是重走一遍，不是接着上次那一步继续：
  // 每次重新展开都回到第 0 步（与桌面端同款处理，setStep(0) 幂等）
  useEffect(() => {
    if (active) setStep(0);
  }, [active]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      step,
      results,
      patch,
      next: () => setStep((s) => Math.min(s + 1, DONE_STEP)),
      back: () => setStep((s) => Math.max(s - 1, 0)),
      finish,
    }),
    [step, results, patch, finish],
  );

  // 未展开时不渲染任何东西；展开时机由 gate 在读完成标记后决定
  if (!active) return null;

  const isWelcome = step === 0;
  const isDone = step === DONE_STEP;
  const Current = isWelcome
    ? WelcomeStep
    : isDone
      ? DoneStep
      : (ONBOARDING_SECTIONS[step - 1]?.Component ?? WelcomeStep);
  const counted = Math.min(Math.max(step, 1), COUNTED_STEPS);

  return (
    <OnboardingContext.Provider value={value}>
      {/* 绝对铺满的浮层：AppBackground 自己是 flex:1，直接当兄弟节点会排在
          内容下面而不是盖在上面；后渲染保证在配对屏/首页之上。 */}
      <View style={StyleSheet.absoluteFill}>
      <AppBackground>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          {/* 顶栏：欢迎页留空，其余右侧「第 n 步，共 N 步」+「跳过」 */}
          <View style={styles.topBar}>
            {isWelcome ? null : (
              <>
                <Text style={styles.stepLabel}>
                  {isDone ? "完成" : `第 ${counted} 步，共 ${COUNTED_STEPS} 步`}
                </Text>
                {!isDone && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={finish}
                    hitSlop={12}
                    style={styles.skip}
                  >
                    <Text style={styles.skipText}>跳过</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>

          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.content}>
              <Current />
            </View>
          </ScrollView>

          {/* 进度点：仅中间步骤 */}
          {!isWelcome && !isDone ? (
            <View style={styles.dots}>
              {Array.from({ length: COUNTED_STEPS }, (_, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    i === counted - 1 ? styles.dotActive : null,
                  ]}
                />
              ))}
            </View>
          ) : null}
        </SafeAreaView>
      </AppBackground>
      </View>
    </OnboardingContext.Provider>
  );
}

function useStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors, radius: r, space: sp, fontWeight: fw } = t;
    return StyleSheet.create({
      safe: { flex: 1 },
      topBar: {
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: sp(3),
        paddingHorizontal: sp(5),
      },
      stepLabel: {
        color: colors.mutedForeground,
        fontSize: 12.5,
        fontVariant: ["tabular-nums"],
      },
      skip: { padding: sp(1) },
      skipText: { color: colors.mutedForeground, fontSize: 14 },
      body: {
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: sp(5),
        paddingVertical: sp(6),
      },
      content: { width: "100%", maxWidth: 480, alignSelf: "center" },
      dots: {
        flexDirection: "row",
        justifyContent: "center",
        gap: 6,
        paddingBottom: sp(6),
      },
      dot: {
        height: 4,
        width: 12,
        borderRadius: r.pill,
        backgroundColor: colors.muted,
      },
      dotActive: {
        width: 24,
        backgroundColor: colors.primary,
      },
    });
  }, [t]);
}
