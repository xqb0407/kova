"use client";

/**
 * 消息流里的 Task 委派卡：把 TaskToolUI 原先的一行式条目换成
 * DelegationCardView（头像/模型/状态/描述/轮次/用时）。
 *
 * 数据来源（沿用 subagent-runs 的三条路）：
 * - 实时：prompt 流的 data-subagentDelegation 绑定 + 活动流，按 toolCallId 订阅；
 * - 历史：没有绑定，从 Task 结果文本的 8 位短 id 兜底；只订阅已有条目，
 *   打开面板水合后卡片自动补齐状态/模型；
 * - 启动失败：sidecar 用普通文本返回原因、没有 delegationId——红色错误卡，不可点。
 */
import { useEffect, useState, type FC, type ReactNode } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  openSubagentTab,
  parseDelegationIdFromResult,
  subagentElapsedSeconds,
  useSubagentRunById,
  useSubagentRunByToolCall,
  useSubagentRunsByToolCalls,
} from "@/lib/subagent/subagent-runs";
import { useSubagentEntry } from "@/lib/subagent/subagents";
import { useModelDisplayName } from "@/lib/pi/pi-models";
import {
  DelegationCardView,
  DelegationGroup,
  type DelegationCardStatus,
} from "./delegation-card.aui";

function strArg(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "error" in result) {
    const err = (result as { error?: unknown }).error;
    if (typeof err === "string") return err;
  }
  return JSON.stringify(result, null, 2);
}

const TERMINAL_STATUS: Partial<Record<string, DelegationCardStatus>> = {
  completed: "completed",
  failed: "failed",
  truncated: "truncated",
  aborted: "aborted",
  stopped: "stopped",
  interrupted: "interrupted",
};

export const TaskDelegationCard: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
}) => {
  const output = resultText(result);
  const parsedId = parseDelegationIdFromResult(output);
  const boundRun = useSubagentRunByToolCall(toolCallId);
  const historyRun = useSubagentRunById(parsedId);
  const run = boundRun ?? historyRun;

  const argAgent = strArg(args, "agent");
  const agentName = run?.agentName || argAgent || "委派";
  const entry = useSubagentEntry(run?.agentName || argAgent);
  const description =
    run?.description || strArg(args, "description") || strArg(args, "task");
  const delegationId = run?.delegationId ?? parsedId;

  // 启动失败：Task 结果只有原因文本、没有 delegationId（并发超限/未知子代理/无凭据…）
  const startFailed = !run && !delegationId && (isError === true || !!output);
  const errorText = startFailed ? output || "子智能体启动失败" : undefined;

  const modelId =
    run?.modelId ??
    (entry?.backend === "uhp" ? entry.uhp?.model || "uhp" : entry?.model);
  const modelLabel =
    useModelDisplayName(modelId === "uhp" ? undefined : modelId) ??
    (modelId === "uhp" ? "UHP" : undefined);

  const running = run?.status === "running" && !run.expired;
  // 运行中每秒一拍刷新用时（结算后自动停）
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  let cardStatus: DelegationCardStatus;
  if (run) {
    cardStatus = run.expired
      ? "expired"
      : run.status === "running"
        ? "running"
        : (TERMINAL_STATUS[run.status] ?? "dispatched");
  } else if (startFailed) {
    cardStatus = "failed";
  } else if (delegationId) {
    cardStatus = "dispatched";
  } else {
    cardStatus = status?.type === "running" ? "starting" : "dispatched";
  }

  const elapsedSeconds = run
    ? subagentElapsedSeconds(run)
    : cardStatus === "starting"
      ? 0
      : undefined;

  return (
    <DelegationCardView
      agentName={agentName}
      modelLabel={modelLabel}
      description={description}
      status={cardStatus}
      turns={run?.turns}
      elapsedSeconds={elapsedSeconds}
      errorText={errorText}
      avatar={entry?.avatar}
      onOpen={
        delegationId
          ? () => openSubagentTab(delegationId, description || agentName)
          : undefined
      }
    />
  );
};

/**
 * 并行组容器：根据 toolCallId 绑定的运行条目的实时状态决定展开/收起。
 * - 有任一派在跑：默认展开；
 * - 全部结算：自动收起（用户手动开合后不再自动）；
 * - 历史/刚派发还没拿到运行条目：保持展开，避免刷新后整组不可见。
 */
export const TaskDelegationGroup: FC<{
  toolCallIds: readonly string[];
  children: ReactNode;
  className?: string;
}> = ({ toolCallIds, children, className }) => {
  const runs = useSubagentRunsByToolCalls(toolCallIds);
  const running = toolCallIds.some((id) => {
    const run = runs.get(id);
    return run?.status === "running" && !run.expired;
  });
  const pending = toolCallIds.some((id) => !runs.get(id));
  return (
    <DelegationGroup
      className={className}
      running={running}
      pending={pending}
    >
      {children}
    </DelegationGroup>
  );
};