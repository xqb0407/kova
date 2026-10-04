import { useMemo, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { ClipboardListIcon, ShieldAlertIcon } from "lucide-react-native";
import { radius, space, useTheme, withAlpha } from "./theme";
import { PillButton } from "./pill-button";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import {
  confirmToolApproval,
  usePendingToolApprovals,
  type PendingToolApprovalView,
} from "@/lib/pi/pi-tool-approval";

/**
 * 逐工具审批卡片：显示在 composer 上方，两类挂起共用 tool_confirm 通道：
 * - bash/write/edit 执行前（approvalBeforeToolCall 挂起）：批准放行执行，拒绝回 blocked 结果；
 * - plan_exit 的模式退出确认（modes.ts plan_exit execute 内挂起，input 带计划快照）：
 *   桌面端计划正文在右侧面板展示；移动端没有面板，卡片上多带一段 rationale。
 *
 * 视觉：中性玻璃卡 + 局部警示（只染图标徽章，不染整卡边框），命令走终端风
 * 等宽块（与转录里终端工具行的展开区同语言），操作是一排右对齐胶囊。
 */

/** 工具参数的一行摘要（与桌面端 tool-approval-card 同款） */
function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const raw =
    toolName === "bash"
      ? i.command
      : toolName === "read"
        ? i.file_path
        : toolName === "write" || toolName === "edit"
          ? `${i.file_path ?? ""}${i.old_string !== undefined ? "（修改）" : "（新建）"}`
          : toolName === "mcp"
            ? `${i.tool ?? ""}${typeof i.args === "object" && i.args !== null ? ` ${JSON.stringify(i.args)}` : ""}`
            : undefined;
  const s = typeof raw === "string" ? raw : JSON.stringify(input);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** plan_exit 审批 input 的快照字段（sidecar modes.ts 里随 chunk 下发） */
function planExitInfo(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  return {
    rationale: typeof i.rationale === "string" ? i.rationale : "",
    title: typeof i.title === "string" ? i.title : "",
    filePath: typeof i.filePath === "string" ? i.filePath : "",
  };
}

function useCardStyles() {
  const t = useTheme();
  // 样式表跟着主题走：主题对象稳定，没切换就不该每次渲染重建一张
  return useMemo(() => {
    const { colors, radius, space, fontWeight, mono } = t;
    return StyleSheet.create({
      card: {
        // marginHorizontal: space(4),
        marginVertical: space(2),
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius["2xl"],
        padding: space(3.5),
        gap: space(3),
        // 实心卡轻投影：毛玻璃在这个位置会跟 composer 的玻璃叠成一团灰雾
        // ...Platform.select({
        //   ios: {
        //     shadowColor: colors.foreground,
        //     shadowOpacity: 0.06,
        //     shadowRadius: 12,
        //     shadowOffset: { width: 0, height: 4 },
        //   },
        //   android: { elevation: 2 },
        // }),
      },
      headerGap: { gap: space(3) },
      divider: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        paddingTop: space(3),
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
      toolChip: {
        backgroundColor: withAlpha(colors.foreground, 0.06),
        borderRadius: radius.sm,
        paddingHorizontal: space(1.5),
        paddingVertical: 2,
      },
      toolChipText: { color: colors.mutedForeground, fontFamily: mono, fontSize: 12 },
      planChip: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.pill,
        paddingHorizontal: space(2),
        paddingVertical: 2,
      },
      planChipText: {
        color: colors.mutedForeground,
        fontSize: 11,
        fontWeight: fontWeight("600"),
      },
      commandBlock: {
        backgroundColor: withAlpha(colors.foreground, 0.05),
        borderRadius: radius.md,
        paddingHorizontal: space(3),
        paddingVertical: space(2.5),
      },
      commandText: { color: colors.foreground, fontFamily: mono, fontSize: 12.5, lineHeight: 18 },
      note: { color: colors.mutedForeground, fontSize: 12, lineHeight: 17 },
      rationale: {
        color: colors.mutedForeground,
        fontSize: 13.5,
        lineHeight: 19,
      },
      actions: { flexDirection: "row", justifyContent: "flex-end", gap: space(2), flexWrap: "wrap" },
    });
  }, [t]);
}

/** plan_exit：计划审批卡（标题 + rationale + 批准/拒绝） */
function PlanExitRow({
  sessionId,
  approval,
}: {
  sessionId: string;
  approval: PendingToolApprovalView;
}) {
  const s = useCardStyles();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const info = planExitInfo(approval.input);

  const decide = (approved: boolean) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    confirmToolApproval(sessionId, approval.approvalId, approved).catch(() => {});
  };

  return (
    <View style={s.headerGap}>
      <View style={s.header}>
        <View style={[s.badge, { backgroundColor: withAlpha(colors.sidebarPrimary, 0.12) }]}>
          <ClipboardListIcon size={15} color={colors.sidebarPrimary} />
        </View>
        <Text style={s.title} numberOfLines={1}>
          {info?.title || "计划待批准"}
        </Text>
        <View style={s.planChip}>
          <Text style={s.planChipText}>Plan</Text>
        </View>
      </View>
      {info?.rationale ? (
        <Text style={s.rationale}>{info.rationale}</Text>
      ) : null}
      <View style={s.actions}>
        <PillButton
          label="拒绝并停止"
          variant="ghost"
          disabled={busy}
          onPress={() => decide(false)}
        />
        <PillButton
          label="批准并开始实施"
          disabled={busy}
          onPress={() => decide(true)}
        />
      </View>
    </View>
  );
}

function ApprovalRow({
  sessionId,
  approval,
}: {
  sessionId: string;
  approval: PendingToolApprovalView;
}) {
  const s = useCardStyles();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const summary = summarizeInput(approval.toolName, approval.input);

  if (approval.toolName === "plan_exit") {
    return <PlanExitRow sessionId={sessionId} approval={approval} />;
  }

  const decide = (approved: boolean, remember = false) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    confirmToolApproval(sessionId, approval.approvalId, approved, remember).catch(
      () => {},
    );
  };

  return (
    <View style={s.headerGap}>
      <View style={s.header}>
        <View style={[s.badge, { backgroundColor: withAlpha(colors.warning, 0.14) }]}>
          <ShieldAlertIcon size={15} color={colors.warning} />
        </View>
        <Text style={s.title}>请求执行</Text>
        <View style={s.toolChip}>
          <Text style={s.toolChipText}>{approval.toolName}</Text>
        </View>
      </View>
      {summary ? (
        <View style={s.commandBlock}>
          <Text style={s.commandText} numberOfLines={3}>
            {approval.toolName === "bash" ? `$ ${summary}` : summary}
          </Text>
        </View>
      ) : null}
      {/* 「同意意味着什么」：如可写根清单的授权。不显式写出就是静默扩大权限 */}
      {approval.note ? <Text style={s.note}>{approval.note}</Text> : null}
      <View style={s.actions}>
        <PillButton label="拒绝" variant="ghost" disabled={busy} onPress={() => decide(false)} />
        {/* 「允许并记住」只在带可写根上下文的审批上出现（workspace-write 档的
            write/edit）：其余的没有"一条可记住的路径"可言，给了按钮就是骗人 */}
        {approval.canRemember ? (
          <PillButton
            label={approval.toolName === "bash" ? "记住这类命令" : "允许并记住"}
            variant="ghost"
            disabled={busy}
            onPress={() => decide(true, true)}
          />
        ) : null}
        <PillButton
          label={approval.canRemember ? "仅这一次" : "批准"}
          disabled={busy}
          onPress={() => decide(true)}
        />
      </View>
    </View>
  );
}

export function ToolApprovalCard() {
  const s = useCardStyles();
  // 台账键 = pi sessionId（不是 mainThreadId：本会话新建的线程是 __LOCALID_
  // 草稿 id，拿它查永远 miss，卡片不上屏），结算也用同一键
  const sessionId = useInteractionSessionId();
  const approvals = usePendingToolApprovals(sessionId);

  if (!sessionId || approvals.length === 0) return null;

  return (
    <View style={s.card} className="shadow-sm">
      {approvals.map((a, index) => (
        <View key={a.approvalId} style={index > 0 ? s.divider : undefined}>
          <ApprovalRow sessionId={sessionId} approval={a} />
        </View>
      ))}
    </View>
  );
}
