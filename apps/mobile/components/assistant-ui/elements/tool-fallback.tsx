import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  type ToolCallMessagePart,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react-native";
import { type FC } from "react";
import { WrenchIcon } from "lucide-react-native";
import { Text, View } from "react-native";
import { field, monoStyle } from "./surfaces";
import { formatUnknownValue } from "../utils/task";

/**
 * 未注册专属渲染的工具（Question、子代理、todo 等）的通用行，与桌面
 * tool-fallback.aui 同构：扁平、行内展开输出。差异是这里还承接 part 级
 * 审批状态的回执——但**流内不再渲染任何批准按钮**（决策面唯一在 composer
 * 上方的审批卡，pi-interactions 台账）：待批只是「等待确认」的中性提示，
 * 已决是过去时回执（已允许/已拒绝…），滚动回看永远不会出现活控制。
 */

/** 结果文本：字符串原样展示（不再 JSON.stringify 导致引号/\n 转义），对象才序列化 */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

const isQuestion = (approval: ToolCallMessagePart["approval"]) =>
  approval?.display === "select" || approval?.display === "text";

const isSettled = (approval: ToolCallMessagePart["approval"]) =>
  approval != null &&
  (approval.approved !== undefined || approval.resolution !== undefined);

/**
 * A settled request reads as a past-tense record of what happened to it, so
 * scrolling back never shows a live control for a decision already made.
 */
const approvalReceipt = (
  approval: NonNullable<ToolCallMessagePart["approval"]>,
) => {
  if (approval.resolution !== undefined)
    return {
      label:
        approval.resolution === "cancelled" ? "已取消（未决策）" : "已过期（未决策）",
      option: undefined,
    };

  const chosen =
    approval.optionId === undefined
      ? undefined
      : approval.options?.find((option) => option.id === approval.optionId);
  const answered = isQuestion(approval) || chosen !== undefined;
  const verb = approval.approved ? (answered ? "已回答" : "已允许") : answered ? "已关闭" : "已拒绝";

  return {
    label: `${verb}${approval.isAutomatic ? "（自动）" : ""}`,
    option: chosen?.label ?? approval.optionId,
  };
};

const ToolFallbackApprovalReceipt: FC<{
  approval: NonNullable<ToolCallMessagePart["approval"]>;
  className?: string;
}> = ({ approval, className }) => {
  const receipt = approvalReceipt(approval);
  const notes = [
    ...new Set(
      [approval.text, approval.reason].filter(
        (value): value is string => typeof value === "string" && value !== "",
      ),
    ),
  ];

  return (
    <View className={cn("aui-tool-fallback-approval-receipt gap-1", className)}>
      {approval.prompt ? (
        <Text className="aui-tool-fallback-approval-prompt text-muted-foreground text-sm">
          {approval.prompt}
        </Text>
      ) : null}
      <Text className="aui-tool-fallback-approval-receipt-label text-foreground text-sm font-medium">
        {receipt.label}
        {receipt.option !== undefined ? (
          <Text className="text-muted-foreground font-normal">
            {` · ${receipt.option}`}
          </Text>
        ) : null}
      </Text>
      {notes.map((text) => (
        <Text
          key={text}
          className="aui-tool-fallback-approval-receipt-note text-muted-foreground text-sm"
        >
          {text}
        </Text>
      ))}
    </View>
  );
};

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  approval,
}) => {
  const isCancelled =
    status.type === "incomplete" && status.reason === "cancelled";
  const label =
    status.type === "running"
      ? `执行中 ${toolName}…`
      : status.type === "requires-action"
        ? `等待确认 ${toolName}`
        : status.type === "incomplete"
          ? `${isCancelled ? "已取消" : "失败"} ${toolName}`
          : `已使用 ${toolName}`;
  const error =
    status.type === "incomplete" && status.error != null
      ? formatUnknownValue(status.error)
      : "";
  const output = resultText(result);

  return (
    <View className="aui-tool-fallback-root border-border bg-card my-1 gap-2 rounded-xl border px-3 py-2">
      <View className="aui-tool-fallback-header flex-row items-center gap-2">
        <Icon as={WrenchIcon} className="text-muted-foreground size-4" />
        <Text className="aui-tool-fallback-title text-muted-foreground text-sm">
          {label}
        </Text>
      </View>
      {argsText ? (
        <View className={cn("aui-tool-fallback-approval-args rounded-lg px-2.5 py-2", field)}>
          <Text className="text-foreground/70 text-xs" style={monoStyle} numberOfLines={4}>
            {argsText}
          </Text>
        </View>
      ) : null}
      {status.type === "requires-action" && !isSettled(approval) ? (
        // 待批只是提示：决策面在输入框上方的审批卡，流内不放第二套按钮
        <Text className="aui-tool-fallback-approval-hint text-muted-foreground text-xs">
          待处理：请在输入框上方的卡片中回应
        </Text>
      ) : null}
      {approval ? (
        <ToolFallbackApprovalReceipt approval={approval} className="ps-6" />
      ) : null}
      {error !== "" && (
        <View className="aui-tool-fallback-error gap-0.5 ps-6">
          <Text className="text-muted-foreground text-xs font-semibold">
            {isCancelled ? "取消原因：" : "错误："}
          </Text>
          <Text className="text-muted-foreground text-xs">{error}</Text>
        </View>
      )}
      {output !== "" && (
        <View className="aui-tool-fallback-output gap-0.5 ps-6">
          <Text className="text-muted-foreground text-xs" style={monoStyle} numberOfLines={8}>
            {output}
          </Text>
        </View>
      )}
    </View>
  );
};
