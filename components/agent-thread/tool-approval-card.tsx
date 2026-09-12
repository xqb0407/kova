"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import {
  CheckIcon,
  ClipboardListIcon,
  ShieldAlertIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openToolCallPanel } from "@/lib/tool-panel";
import {
  confirmToolApproval,
  usePendingToolApprovals,
  type PendingToolApprovalView,
} from "@/lib/pi-tool-approval";

/**
 * 逐工具审批卡片：显示在 composer 上方，两类挂起共用 tool_confirm 通道：
 * - bash/write/edit 执行前（approvalBeforeToolCall 挂起）：批准放行执行，拒绝回 blocked 结果；
 * - plan_exit 的模式退出确认（modes.ts plan_exit execute 内挂起，input 带计划快照）：
 *   渲染计划审批卡，批准 = sidecar 回 agent 模式同轮实施；
 *   拒绝 = 计划作废（sidecar 删除计划文件）并 abort 终止本轮，会话留在 plan 模式。
 */

/** 工具参数的一行摘要（与 tool-fallback 卡片的风格一致） */
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
    markdown: typeof i.markdown === "string" ? i.markdown : "",
    filePath: typeof i.filePath === "string" ? i.filePath : "",
  };
}

/** 最近一次 plan_write 提交的 toolCallId（「在面板中打开」定位用；兼容旧转录 SubmitPlan） */
function useLastPlanWriteToolCallId(): string | null {
  return useAuiState((s) => {
    for (let mi = s.thread.messages.length - 1; mi >= 0; mi--) {
      const c = s.thread.messages[mi].content;
      for (let pi = c.length - 1; pi >= 0; pi--) {
        const p = c[pi];
        if (
          p.type === "tool-call" &&
          (p.toolName === "plan_write" || p.toolName === "SubmitPlan")
        ) {
          return p.toolCallId;
        }
      }
    }
    return null;
  });
}

/** plan_exit：计划审批卡（标题 + 计划 Markdown 预览 + rationale + 批准/拒绝） */
const PlanExitRow: FC<{ threadId: string; approval: PendingToolApprovalView }> = ({
  threadId,
  approval,
}) => {
  const [busy, setBusy] = useState(false);
  const info = planExitInfo(approval.input);
  const lastPlanWrite = useLastPlanWriteToolCallId();

  const decide = (approved: boolean) => {
    setBusy(true);
    confirmToolApproval(threadId, approval.approvalId, approved).catch(() => {});
  };

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <ClipboardListIcon className="size-4 shrink-0" />
        <span className="truncate text-sm font-medium">
          {info?.title || "计划待批准"}
        </span>
        <span className="bg-muted text-muted-foreground ml-auto rounded-full px-2 py-0.5 text-xs whitespace-nowrap">
          Plan
        </span>
        {lastPlanWrite && (
          <button
            type="button"
            aria-label="在面板中打开"
            title="在面板中打开"
            onClick={() =>
              openToolCallPanel("plan_write", lastPlanWrite, {
                title: info?.title || "计划",
              })
            }
            className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors"
          >
            <SquareArrowOutUpRightIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="scrollbar-thin mt-2 max-h-72 overflow-y-auto">
        <div className="text-sm">
          <Streamdown plugins={{ code, cjk }}>{info?.markdown || ""}</Streamdown>
        </div>
      </div>
      {info?.rationale && (
        <p className="text-muted-foreground mt-3 border-t pt-3 text-sm">
          {info.rationale}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => decide(false)}
          className="h-8 rounded-full px-3.5"
        >
          <XIcon className="size-3.5" />
          拒绝并停止
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => decide(true)}
          className="h-8 rounded-full px-3.5"
        >
          <CheckIcon className="size-3.5" />
          批准并开始实施
        </Button>
      </div>
    </div>
  );
};

const ApprovalRow: FC<{ threadId: string; approval: PendingToolApprovalView }> = ({
  threadId,
  approval,
}) => {
  const [busy, setBusy] = useState(false);
  const summary = summarizeInput(approval.toolName, approval.input);

  const decide = (approved: boolean) => {
    setBusy(true);
    confirmToolApproval(threadId, approval.approvalId, approved).catch(() => {});
  };

  if (approval.toolName === "plan_exit") {
    return <PlanExitRow threadId={threadId} approval={approval} />;
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <span className="mt-0.5 shrink-0 text-amber-500 [&_svg]:size-4">
        <ShieldAlertIcon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          请求执行 <span className="font-mono">{approval.toolName}</span>
        </p>
        {summary && (
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{summary}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => decide(false)}
          className="h-8 rounded-full px-3.5"
        >
          <XIcon className="size-3.5" />
          拒绝
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => decide(true)}
          className="h-8 rounded-full px-3.5"
        >
          <CheckIcon className="size-3.5" />
          批准
        </Button>
      </div>
    </div>
  );
};

export const ToolApprovalCard: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const approvals = usePendingToolApprovals(threadId);

  if (!threadId || approvals.length === 0) return null;

  return (
    <div
      data-slot="aui-tool-approval-card"
      className={cn(
        "border-border/60  mb-1 bg-card overflow-hidden rounded-2xl border shadow-sm",
        approvals.length > 1 && "divide-y",
      )}
    >
      {approvals.map((a) => (
        <ApprovalRow key={a.approvalId} threadId={threadId} approval={a} />
      ))}
    </div>
  );
};
