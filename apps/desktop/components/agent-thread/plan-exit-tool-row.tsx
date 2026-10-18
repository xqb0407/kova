"use client";

import { ChevronDownIcon, CircleCheckIcon, LogOutIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning";
import { ToolRow } from "@/components/assistant-ui/elements/tool-row.aui";

/**
 * plan_exit 在消息列表里的留痕：运行中显示「申请批准计划」+ rationale；
 * 结束后按 tool result 显示批准 / 拒绝（带修改意见）/ 未填理由停止。
 * 拒绝理由与 Question 的已答留痕同构（折叠条目，展开看全文）——两者都是
 * 「用户拍过板」的记录；交互当下的卡片在 composer 上方，见
 * tool-approval-card.tsx。
 */

type Decision =
  | { kind: "approved" }
  | { kind: "rejected"; reason: string }
  | { kind: "dismissed" }
  | { kind: "cleared" }
  | { kind: "unknown" };

const REJECT_PREFIX = "User rejected the plan with this feedback:";
const REJECT_SUFFIX = "\n\nRevise the plan file with plan_write";

/** tool result 在消息投影里是文本串；兼容旧形 object 兜底 */
function outputText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as {
      text?: unknown;
      error?: unknown;
      content?: Array<{ text?: unknown }>;
    };
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join("\n");
    }
    if (typeof r.text === "string") return r.text;
    if (typeof r.error === "string") return r.error;
  }
  return "";
}

/** 解析 sidecar modes.ts 里 plan_exit 的三条结果文案 */
function parseDecision(result: unknown): Decision {
  const text = outputText(result);
  if (!text) return { kind: "unknown" };
  const at = text.indexOf(REJECT_PREFIX);
  if (at >= 0) {
    const rest = text.slice(at + REJECT_PREFIX.length);
    const end = rest.indexOf(REJECT_SUFFIX);
    const reason = (end >= 0 ? rest.slice(0, end) : rest).trim();
    return { kind: "rejected", reason };
  }
  if (text.includes("User approved the plan")) return { kind: "approved" };
  if (text.includes("User dismissed the plan approval without feedback")) {
    return { kind: "dismissed" };
  }
  if (text.includes("Plan approval was cleared")) return { kind: "cleared" };
  return { kind: "unknown" };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

/** 与 reasoning-trigger 的 chevron 同款（-rotate-90 收起、展开转正） */
const Chevron = () => (
  <ChevronDownIcon className="aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none -rotate-90 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0" />
);

export const PlanExitToolRow: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const rationale =
    typeof (args as { rationale?: unknown } | undefined)?.rationale === "string"
      ? (args as { rationale: string }).rationale
      : "";
  const running = status?.type === "running";
  const output = outputText(result);

  // 挂起阶段/结果未到：保留原来的模式动作行（审批交互本身在 composer 卡片）
  if (running || result == null) {
    return (
      <ToolRow
        label="申请批准计划"
        icon={<LogOutIcon className="size-4 shrink-0" />}
        primary={rationale || undefined}
        running={running}
      />
    );
  }

  if (isError) {
    return (
      <ToolRow
        label="申请批准计划"
        icon={<LogOutIcon className="size-4 shrink-0" />}
        primary={output || rationale || undefined}
        failed
      />
    );
  }

  const decision = parseDecision(result);

  if (decision.kind === "approved") {
    return (
      <ToolRow
        label="计划已批准"
        icon={<CircleCheckIcon className="size-4 shrink-0" />}
        primary={rationale || undefined}
      />
    );
  }

  if (decision.kind === "rejected") {
    return (
      <ReasoningRoot variant="ghost" data-slot="plan-exit-tool-row">
        <CollapsibleTrigger className="group/trigger text-muted-foreground hover:text-foreground flex w-full max-w-[85%] origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] ">
          <LogOutIcon className="size-4 shrink-0" />
          <span className="shrink-0">计划未批准</span>
          <span
            className="min-w-0 truncate opacity-70"
            title={decision.reason || undefined}
          >
            · {firstLine(decision.reason) || "已提交修改意见"}
          </span>
          <Chevron />
        </CollapsibleTrigger>
        <ReasoningContent>
          <ReasoningText>
            <div className="space-y-2">
              <p className="font-medium text-foreground/90">修改意见</p>
              <p className="whitespace-pre-wrap">
                {decision.reason || "（理由为空）"}
              </p>
            </div>
          </ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>
    );
  }

  if (decision.kind === "dismissed") {
    return (
      <ToolRow
        label="计划未批准"
        icon={<LogOutIcon className="size-4 shrink-0" />}
        primary="未填写理由 · 本轮已停止"
      />
    );
  }

  if (decision.kind === "cleared") {
    return (
      <ToolRow
        label="计划审批已取消"
        icon={<LogOutIcon className="size-4 shrink-0" />}
        primary="用户停止或发送了新消息"
      />
    );
  }

  // 未知结果（旧转录/异常）：退回原来的模式动作行
  return (
    <ToolRow
      label="申请批准计划"
      icon={<LogOutIcon className="size-4 shrink-0" />}
      primary={rationale || undefined}
    />
  );
};
