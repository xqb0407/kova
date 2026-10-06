import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAuiState } from "@assistant-ui/react-native";
import * as Haptics from "expo-haptics";
import { TargetIcon } from "lucide-react-native";
import { radius, space, useTheme, withAlpha } from "./theme";
import { PillButton } from "./pill-button";
import {
  confirmGoalCriteriaNow,
  rejectGoalCriteriaNow,
  setGoalObjectiveNow,
  skipGoalCriteriaNow,
  useGoalState,
} from "@/lib/pi/pi-goal";

/**
 * 目标契约卡片（移动端）：协商中显示进度 + 改目标入口，待确认时显示标准与三个决定。
 *
 * 没有它，目标模式在移动端会卡死：契约阶段的循环是**停着等人确认**的
 * （proposed 时 turn_end 不注入任何续跑），而移动端此前没有任何确认入口——
 * 用户在手机上设的目标会一直停在「待确认」，只有打开桌面端才能继续。
 *
 * 位置与形态照抄 ToolApprovalCard：同一个 composer 上方槽位、同一套玻璃卡 +
 * 胶囊按钮语言。区别在于它不是挂起交互（不占 pending 台账），状态就活在目标的
 * acceptance 字段里，所以刷新/重启后卡片自己会回来。
 */
function useCardStyles() {
  const t = useTheme();
  return useMemo(() => {
    const { colors, radius, space, fontWeight, mono } = t;
    return StyleSheet.create({
      card: {
        marginVertical: space(2),
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius["2xl"],
        padding: space(3.5),
        gap: space(3),
      },
      header: { flexDirection: "row", alignItems: "center", gap: space(2.5) },
      badge: {
        width: 28,
        height: 28,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
      },
      title: {
        color: colors.foreground,
        fontSize: 15,
        fontWeight: fontWeight("600"),
        flexShrink: 1,
      },
      objective: { color: colors.mutedForeground, fontSize: 12.5, lineHeight: 18 },
      itemRow: { flexDirection: "row", gap: space(2), alignItems: "flex-start" },
      itemId: {
        color: colors.mutedForeground,
        fontFamily: mono,
        fontSize: 12,
        lineHeight: 19,
      },
      itemText: { color: colors.foreground, fontSize: 13.5, lineHeight: 19, flexShrink: 1 },
      note: { color: colors.mutedForeground, fontSize: 12, lineHeight: 17 },
      input: {
        color: colors.foreground,
        backgroundColor: withAlpha(colors.foreground, 0.05),
        borderRadius: radius.md,
        paddingHorizontal: space(3),
        paddingVertical: space(2.5),
        fontSize: 13,
        minHeight: 64,
        textAlignVertical: "top",
      },
      actions: { flexDirection: "row", justifyContent: "flex-end", gap: space(2), flexWrap: "wrap" },
    });
  }, [t]);
}

export function GoalCriteriaCard() {
  const s = useCardStyles();
  const { colors } = useTheme();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const { goal } = useGoalState(threadId);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");

  // 协商中也要出卡：那一轮模型正在读工作区，用户最该能做的两件事是「看看它在
  // 为什么提标准」和「我目标说错了，改一下」。此前这段在移动端是一片空白——
  // 手机用户设完目标只能看着转圈，连条上那句「正在拟定验收标准」都看不到。
  // 已确认/跳过的目标是执行期的事，跟这张卡无关
  const status = goal?.acceptance?.status;
  if (!threadId || (status !== "proposed" && status !== "pending")) return null;
  const items = status === "proposed" ? (goal?.acceptance?.items ?? []) : [];
  const voidsCriteria = status === "proposed";

  const act = (fn: (id: string) => Promise<void>) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    fn(threadId)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const commitObjective = () => {
    const next = objective.trim();
    setEditing(false);
    if (!next || next === goal!.objective) return;
    act((id) => setGoalObjectiveNow(id, next));
  };

  // 改目标原文：协商阶段用户直接在对话里补一句判不出是「加要求」还是「换目标」，
  // 猜意图不如给个动作。改动会让已提的标准作废重谈，所以下面把那句话写出来
  if (editing) {
    return (
      <View style={s.card} className="shadow-sm">
        <Text style={s.title}>这条目标要做的事</Text>
        <TextInput
          multiline
          autoFocus
          value={objective}
          onChangeText={setObjective}
          placeholder="把目标说清楚"
          placeholderTextColor={colors.mutedForeground}
          style={s.input}
        />
        <Text style={s.note}>
          {voidsCriteria
            ? "验收标准是按原目标提的，改动后它们会作废、重新协商一轮。"
            : "改动后轮次与停滞计数重新起算，产物另存一份。"}
        </Text>
        <View style={s.actions}>
          <PillButton label="取消" variant="ghost" onPress={() => setEditing(false)} />
          <PillButton label="确定" disabled={busy} onPress={commitObjective} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.card} className="shadow-sm">
      <View style={s.header}>
        <View style={[s.badge, { backgroundColor: withAlpha(colors.warning, 0.14) }]}>
          <TargetIcon size={15} color={colors.warning} />
        </View>
        <Text style={s.title} numberOfLines={1}>
          {status === "proposed" ? "验收标准待确认" : "正在拟定验收标准"}
        </Text>
      </View>
      <Text style={s.objective} numberOfLines={3}>
        {goal!.objective}
      </Text>

      {status === "pending" && (
        <>
          <Text style={s.note}>
            模型正在读工作区，接下来会提出「怎么算做完」。目标说错了就现在改。
          </Text>
          <View style={s.actions}>
            <PillButton
              label="改目标"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setObjective(goal!.objective);
                setEditing(true);
              }}
            />
          </View>
        </>
      )}

      {status === "proposed" && !rejecting && (
        <>
          {goal!.acceptance?.feedback ? (
            <Text style={s.note}>
              上一版为什么被退回：{goal!.acceptance.feedback}
            </Text>
          ) : null}
          <View style={{ gap: space(1.5) }}>
            {items.map((c) => (
              <View key={c.id} style={s.itemRow}>
                <Text style={s.itemId}>{c.id}</Text>
                <Text style={s.itemText}>{c.text}</Text>
              </View>
            ))}
          </View>
          <Text style={s.note}>
            确认后模型开始动手；完成时它必须逐条给出证据，有标准没达标就不算完成。
          </Text>
          <View style={s.actions}>
            <PillButton
              label="改目标"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setObjective(goal!.objective);
                setEditing(true);
              }}
            />
            <PillButton
              label="驳回"
              variant="ghost"
              disabled={busy}
              onPress={() => setRejecting(true)}
            />
            <PillButton
              label="跳过标准"
              variant="ghost"
              disabled={busy}
              onPress={() => act(skipGoalCriteriaNow)}
            />
            <PillButton
              label="确认并开始"
              disabled={busy}
              onPress={() => act((id) => confirmGoalCriteriaNow(id))}
            />
          </View>
        </>
      )}

      {status === "proposed" && rejecting && (
        <>
          <TextInput
            multiline
            autoFocus
            value={feedback}
            onChangeText={setFeedback}
            placeholder="哪里不对？模型下一轮会按这段意见重提"
            placeholderTextColor={colors.mutedForeground}
            style={s.input}
          />
          <View style={s.actions}>
            <PillButton label="返回" variant="ghost" onPress={() => setRejecting(false)} />
            <PillButton
              label="提交意见"
              disabled={busy}
              onPress={() => act((id) => rejectGoalCriteriaNow(id, feedback))}
            />
          </View>
        </>
      )}
    </View>
  );
}
