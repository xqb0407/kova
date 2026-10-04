import { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { XIcon } from "lucide-react-native";
import { fontWeight, radius, space, useTheme, withAlpha } from "./theme";
import { PillButton } from "./pill-button";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import { usePiRuntimeExtras } from "@/lib/pi/pi-runtime";
import {
  answerQuestion,
  removePendingQuestion,
  usePendingQuestions,
  type PendingQuestionView,
} from "@/lib/pi/pi-question";

/**
 * Question 提问卡片（pi-interactions 台账版）：sidecar 的 Question 工具挂起等答
 * 时渲染在 composer 上方。整流经 onComplete 一次性把全部答案经 question_answer
 * 回传 sidecar，execute 解开挂起、模型收到格式化答案。
 *
 * RN 精简版提问流：逐题推进——单选题点选即前进；多选题勾选 + 继续；allowOther
 * 给「其它」输入行；freeText 是纯输入框；可跳过当前题。
 *
 * 关闭（header X）＝ 停止本轮：走与 Stop 按钮同一条 PiRuntimeExtras.cancel 路径
 * （全局中断，手机和桌面看到的是同一个 agent），sidecar abortRun 把挂起提问按
 * 取消结算并回 finish，台账随 clearQuestions 清空。取消前先本地 removePendingQuestion：
 * cancelRun 拆掉本地流后 finish chunk 不会再来 clearQuestions，不就地移除会让
 * 卡片常驻。
 */

/** 单题草稿（键 = q-<i>，与 sidecar 格式化端同约定） */
type Draft = {
  selectedIds: string[];
  otherText: string;
  skipped: boolean;
};

const EMPTY_DRAFT: Draft = { selectedIds: [], otherText: "", skipped: false };

function QuestionFlow({
  threadId,
  pending,
}: {
  threadId: string;
  pending: PendingQuestionView;
}) {
  const styles = useStyles();
  const extras = usePiRuntimeExtras();
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // onComplete 后本地隐藏：结算回环（sidecar 恢复流式输出）期间不该再允许重复提交
  const [answered, setAnswered] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const total = pending.questions.length;
  if (total === 0 || answered || dismissed) return null;

  const q = pending.questions[Math.min(step, total - 1)];
  const qId = `q-${step}`;
  const draft = drafts[qId] ?? EMPTY_DRAFT;

  const patch = (p: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [qId]: { ...draft, ...p } }));

  const finish = (lastDraft: Draft) => {
    const all = { ...drafts, [qId]: lastDraft };
    setAnswered(true);
    answerQuestion(
      threadId,
      pending.questionId,
      pending.questions.map((_, i) => {
        const d = all[`q-${i}`] ?? EMPTY_DRAFT;
        return {
          questionId: `q-${i}`,
          selectedIds: d.selectedIds,
          ...(d.otherText.trim() ? { otherText: d.otherText.trim() } : {}),
          skipped: d.skipped,
        };
      }),
    ).catch(() => {});
  };

  const advance = (finalDraft: Draft) => {
    if (step + 1 < total) setStep(step + 1);
    else finish(finalDraft);
  };

  const pick = (optId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    advance({ ...draft, selectedIds: [optId], skipped: false });
  };

  const toggle = (optId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const set = new Set(draft.selectedIds);
    if (set.has(optId)) set.delete(optId);
    else set.add(optId);
    patch({ selectedIds: Array.from(set), skipped: false });
  };

  const skip = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    advance({ ...draft, skipped: true });
  };

  const hasAnswer =
    draft.selectedIds.length > 0 || draft.otherText.trim().length > 0;
  const canContinue = q.freeText
    ? draft.otherText.trim().length > 0
    : q.multiSelect
      ? hasAnswer
      : // 单选点选即前进；继续按钮只在「其它」输入行有内容时出现
        draft.otherText.trim().length > 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.progress}>
          {total > 1 ? `问题 ${step + 1}/${total}` : "需要你的输入"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭并停止"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setDismissed(true);
            removePendingQuestion(threadId, pending.questionId);
            extras.cancel();
          }}
          hitSlop={8}
          style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}
        >
          <XIcon size={16} color={styles.closeColor.color} />
        </Pressable>
      </View>

      <Text style={styles.title}>{q.title}</Text>

      {q.options?.length ? (
        <ScrollView style={styles.optionsScroll} nestedScrollEnabled>
          {q.options.map((o, j) => {
            const optId = `o-${j}`;
            const selected = draft.selectedIds.includes(optId);
            return (
              <Pressable
                key={optId}
                disabled={!!q.multiSelect}
                onPress={() => (q.multiSelect ? toggle(optId) : pick(optId))}
                style={({ pressed }) => [
                  styles.option,
                  selected && styles.optionPicked,
                  pressed && styles.optionPressed,
                ]}
              >
                <View
                  style={[styles.marker, q.multiSelect ? styles.checkbox : styles.radio, selected && styles.markerOn]}
                />
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{o.title}</Text>
                  {o.description ? (
                    <Text style={styles.optionDesc}>{o.description}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {/* 选择题默认给「其它」输入行（freeText 本身就是整框输入，不再叠加） */}
      {!q.freeText && (q.allowOther ?? true) ? (
        <TextInput
          value={draft.otherText}
          onChangeText={(t) => patch({ otherText: t, skipped: false })}
          placeholder={q.otherPlaceholder ?? "其它…"}
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.input}
        />
      ) : null}
      {q.freeText ? (
        <TextInput
          value={draft.otherText}
          onChangeText={(t) => patch({ otherText: t, skipped: false })}
          placeholder={q.freeTextPlaceholder ?? "输入你的回答"}
          placeholderTextColor={styles.placeholderColor.color}
          multiline
          style={[styles.input, styles.inputTall]}
        />
      ) : null}

      <View style={styles.actions}>
        <PillButton label="跳过" variant="ghost" onPress={skip} style={styles.button} />
        {(q.multiSelect || q.freeText || canContinue) && (
          <PillButton
            label={step + 1 < total ? "继续" : "提交"}
            disabled={!canContinue}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              advance({ ...draft, skipped: false });
            }}
            style={styles.button}
          />
        )}
      </View>
    </View>
  );
}

export function QuestionCard() {
  const styles = useStyles();
  // 台账键 = pi sessionId（不是 mainThreadId：本会话新建的线程是 __LOCALID_
  // 草稿 id，拿它查永远 miss，卡片不上屏），作答/就地移除也用同一键
  const sessionId = useInteractionSessionId();
  const pending = usePendingQuestions(sessionId);

  if (!sessionId || pending.length === 0) return null;

  return (
    <View style={styles.stack}>
      {pending.map((q) => (
        <QuestionFlow key={q.questionId} threadId={sessionId} pending={q} />
      ))}
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  // 样式表跟着主题走：主题对象稳定，没切换就不该每次渲染重建一张
  return useMemo(() => {
    const { colors, radius, space, fontWeight } = t;
    return StyleSheet.create({
      stack: { gap: space(2) },
      card: {
        // marginHorizontal: space(4),
        marginVertical: space(2),
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius["2xl"],
        padding: space(4),
        gap: space(2.5),
        // 实心卡轻投影：毛玻璃在这个位置会跟 composer 的玻璃叠成一团灰雾
        ...Platform.select({
          ios: {
            shadowColor: colors.foreground,
            shadowOpacity: 0.06,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          },
          android: { elevation: 2 },
        }),
      },
      header: { flexDirection: "row", alignItems: "center" },
      progress: {
        color: colors.warning,
        fontSize: 11.5,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        fontWeight: fontWeight("600"),
        flex: 1,
      },
      close: { padding: space(1) },
      closeColor: { color: colors.mutedForeground },
      title: {
        color: colors.foreground,
        fontSize: 15.5,
        fontWeight: fontWeight("600"),
        lineHeight: 22,
      },
      optionsScroll: { maxHeight: 240 },
      option: {
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space(2.5),
        backgroundColor: colors.muted,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        paddingHorizontal: space(3),
        paddingVertical: space(2.5),
        marginBottom: space(2),
      },
      optionPicked: {
        borderColor: colors.sidebarPrimary,
        backgroundColor: withAlpha(colors.sidebarPrimary, 0.06),
      },
      optionPressed: { opacity: 0.7 },
      marker: {
        marginTop: 2,
        borderWidth: 1.5,
        borderColor: colors.border,
      },
      radio: { width: 16, height: 16, borderRadius: radius.pill },
      checkbox: { width: 16, height: 16, borderRadius: 4 },
      markerOn: { borderColor: colors.sidebarPrimary, backgroundColor: colors.sidebarPrimary },
      optionText: { flex: 1, minWidth: 0 },
      optionLabel: { color: colors.foreground, fontSize: 14 },
      optionDesc: { color: colors.mutedForeground, fontSize: 12.5, marginTop: 2 },
      input: {
        backgroundColor: colors.background,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        padding: space(3),
        minHeight: 44,
        color: colors.foreground,
        fontSize: 14,
      },
      inputTall: { minHeight: 120, textAlignVertical: "top" },
      actions: { flexDirection: "row", justifyContent: "flex-end", gap: space(2) },
      button: { minHeight: 38, paddingHorizontal: space(3.5) },
      placeholderColor: { color: colors.mutedForegroundFaint },
    });
  }, [t]);
}
