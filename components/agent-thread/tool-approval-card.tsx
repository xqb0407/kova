"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  confirmToolApproval,
  usePendingToolApprovals,
  type PendingToolApprovalView,
} from "@/lib/pi-tool-approval";

/**
 * 逐工具审批卡片：bash/write/edit 执行前（approvalBeforeToolCall 挂起时）显示在 composer 上方。
 * 批准 → tool_confirm(approved) 放行执行；拒绝 → 模型收到 blocked 工具结果继续对话。
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
