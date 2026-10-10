"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  BookmarkPlusIcon,
  CheckIcon,
  ClipboardListIcon,
  ShieldAlertIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openToolCallPanel } from "@/lib/panels/tool-panel";
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
 *   计划正文由 sidecar 的 data-panelOpen 在右侧面板展示，卡片只留标题/rationale/操作，
 *   批准 = sidecar 回 agent 模式同轮实施；拒绝 = 计划作废（sidecar 删除计划文件）并
 *   abort 终止本轮，会话留在 plan 模式。
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

/** plan_exit：计划审批卡（标题 + rationale + 批准/拒绝；计划正文在右侧面板） */
const PlanExitRow: FC<{ sessionId: string; approval: PendingToolApprovalView }> = ({
  sessionId,
  approval,
}) => {
  const [busy, setBusy] = useState(false);
  const info = planExitInfo(approval.input);
  const lastPlanWrite = useLastPlanWriteToolCallId();

  const decide = (approved: boolean) => {
    setBusy(true);
    confirmToolApproval(sessionId, approval.approvalId, approved).catch(
      () => {},
    );
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
      {info?.rationale && (
        <p className="text-muted-foreground mt-2 border-t pt-3 text-sm">
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

const ApprovalRow: FC<{ sessionId: string; approval: PendingToolApprovalView }> = ({
  sessionId,
  approval,
}) => {
  const [busy, setBusy] = useState(false);
  const summary = summarizeInput(approval.toolName, approval.input);

  const decide = (approved: boolean, remember = false) => {
    setBusy(true);
    confirmToolApproval(sessionId, approval.approvalId, approved, remember).catch(
      () => {},
    );
  };

  if (approval.toolName === "plan_exit") {
    return <PlanExitRow sessionId={sessionId} approval={approval} />;
  }

  return (
    // flex-wrap：按钮组是 shrink-0（按钮不该被压扁），窄列下若不换行就会把文字块
    // 挤成一条竖缝（实测：三个按钮占掉大半张卡，正文每行只剩七八个字）。
    // 文字块给 basis-52 的最小可读宽度：放不下时按钮整组落到下一行右对齐
    <div className="flex flex-wrap items-start gap-x-2.5 gap-y-2 px-4 py-2.5">
      <span className="mt-0.5 shrink-0 text-amber-500 [&_svg]:size-4">
        <ShieldAlertIcon />
      </span>
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-sm font-medium">
          请求执行 <span className="font-mono">{approval.toolName}</span>
        </p>
        {summary && (
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{summary}</p>
        )}
        {/* 「同意意味着什么」：如可写根清单的授权。不显式写出就是静默扩大权限 */}
        {approval.note && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{approval.note}</p>
        )}
      </div>
      {/* ml-auto 让按钮组在换行后仍贴右；自身也能换行（极窄时按钮之间折行） */}
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
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
        {/* 「允许并记住」只在带可写根上下文的审批上出现（workspace-write 档的
            write/edit）：其余的没有"一条可记住的路径"可言，给了按钮就是骗人 */}
        {approval.canRemember && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => decide(true, true)}
            title={
              approval.toolName === "bash"
                ? "把这条命令的前缀（如前两个词）记进 .kova/permissions.local.json，之后同类命令不再询问"
                : approval.toolName === "mcp"
                  ? "把这个 MCP 工具（server__tool）记进 .kova/permissions.local.json，之后本机再调它不再询问；同一服务器的其他工具仍会逐次问"
                  : "把这次要写的目录记进 .kova/permissions.local.json，之后该目录不再询问"
            }
            className="h-8 rounded-full px-3.5"
          >
            <BookmarkPlusIcon className="size-3.5" />
            {approval.toolName === "bash"
              ? "允许并记住这类命令"
              : approval.toolName === "mcp"
                ? "允许并记住这个工具"
                : "允许并记住"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => decide(true)}
          className="h-8 rounded-full px-3.5"
        >
          <CheckIcon className="size-3.5" />
          {approval.canRemember ? "仅这一次" : "批准"}
        </Button>
      </div>
    </div>
  );
};

export const ToolApprovalCard: FC = () => {
  // 台账键 = pi sessionId（不是 mainThreadId：本会话新建的线程是 __LOCALID_
  // 草稿 id，拿它查永远 miss，卡片不上屏），结算也用同一键
  const sessionId = useInteractionSessionId();
  const approvals = usePendingToolApprovals(sessionId);

  if (!sessionId || approvals.length === 0) return null;

  return (
    <div
      data-slot="aui-tool-approval-card"
      className={cn(
        "border-border/60 mb-2 bg-card overflow-hidden rounded-2xl border shadow-sm",
        approvals.length > 1 && "divide-y",
      )}
    >
      {approvals.map((a) => (
        <ApprovalRow key={a.approvalId} sessionId={sessionId} approval={a} />
      ))}
    </div>
  );
};
