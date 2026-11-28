"use client";

import { useId, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  FileTextIcon,
  ShieldAlertIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { cn } from "@/lib/utils";
import { openToolCallPanel } from "@/lib/panels/tool-panel";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import {
  confirmToolApproval,
  usePendingToolApprovals,
  type PendingToolApprovalView,
  type RememberScope,
} from "@/lib/pi/pi-tool-approval";
import { Label } from "../ui/label";

/**
 * 逐工具审批卡片：显示在 composer 上方，两类挂起共用 tool_confirm 通道：
 * - bash/write/edit 执行前（approvalBeforeToolCall 挂起）：批准放行执行，拒绝回 blocked 结果；
 * - plan_exit 的模式退出确认（modes.ts plan_exit execute 内挂起，input 带计划快照）：
 *   计划正文内嵌在卡片里（默认展开、可收起）；批准 = sidecar 回 agent 模式同轮实施；
 *   拒绝并填写理由 = 留在 plan 同轮修订后再次申请；拒绝但不填理由 = 按停止处理
 *   （sidecar abort 本轮），计划文件保留。
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
          ? `${i.file_path ?? ""}${i.old_string !== undefined || i.edits !== undefined ? "（修改）" : "（新建）"}`
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
    markdown: typeof i.markdown === "string" ? i.markdown : "",
  };
}

/** 计划文件首行是落盘时补的 `# <title>`；模型的 markdown 也常以同名 H1 开头。
 *  卡片已经单独显示标题，正文开头连续去掉这两类标题，避免出现第二个大标题。 */
function stripPlanTitle(markdown: string, title: string): string {
  if (!markdown) return "";
  const lines = markdown.split(/\r?\n/);
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const wanted = norm(title);
  let i = 0;
  let sawTitleHeading = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      const heading = norm(line.replace(/^#\s+/, ""));
      // 第一条 H1 是落盘补的标题，无条件去掉；紧随其后的同名 H1 是模型
      // 自己写的标题，同样去掉。不同名的 H1 保留（由正文样式缩放）
      if (!sawTitleHeading || (wanted && heading === wanted)) {
        sawTitleHeading = true;
        i++;
        continue;
      }
    }
    break;
  }
  return lines.slice(i).join("\n").trimEnd();
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

/** plan_exit：计划审批卡（标题/rationale + 内嵌计划正文 + 拒绝理由/批准） */
const PlanExitRow: FC<{
  sessionId: string;
  approval: PendingToolApprovalView;
}> = ({ sessionId, approval }) => {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [contentOpen, setContentOpen] = useState(true);
  const inputId = useId();
  const info = planExitInfo(approval.input);
  const lastPlanWrite = useLastPlanWriteToolCallId();
  const planBody = stripPlanTitle(info?.markdown ?? "", info?.title ?? "");
  const hasReason = reason.trim().length > 0;

  const decide = (approved: boolean, feedback?: string) => {
    setBusy(true);
    confirmToolApproval(
      sessionId,
      approval.approvalId,
      approved,
      false,
      feedback,
    ).catch(() => {});
  };

  const submitReason = () => {
    // 有理由 = 让模型修订后再次申请；空理由 = 直接拒绝并停止本轮
    const feedback = reason.trim();
    decide(false, feedback || undefined);
  };

  const cancelReason = () => {
    setAsking(false);
    setReason("");
  };

  return (
    <div data-slot="aui-plan-approval" className="flex flex-col">
      <div className=" px-4 flex justify-between pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ClipboardListIcon className="size-4 shrink-0 " />
          <span className="text-muted-foreground font-medium">计划内容</span>
        </div>
        {lastPlanWrite && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="在面板中打开"
            title="在面板中打开"
            onClick={() =>
              openToolCallPanel("plan_write", lastPlanWrite, {
                title: info?.title || "计划",
              })
            }
            className=" ml-auto shrink-0 transition-colors"
          >
            <SquareArrowOutUpRightIcon className="size-4" />
          </Button>
        )}
        {/* <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium">
              计划待批准
            </span>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-3xs font-semibold whitespace-nowrap">
              Plan
            </span>
          
          </div>
          <h3 className="mt-0.5 truncate text-ui-lg leading-6 font-semibold">
            {info?.title || "实施计划"}
          </h3>
          {info?.rationale && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-ui leading-relaxed">
              {info.rationale}
            </p>
          )}
        </div> */}
      </div>

      {planBody && (
        <div className="border-t border-border/60">
          {/* <button
            type="button"
            aria-expanded={contentOpen}
            onClick={() => setContentOpen((v) => !v)}
            className="text-muted-foreground hover:bg-muted/40 hover:text-foreground flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors"
          >
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="font-medium">计划内容</span>
            <span className="ml-auto inline-flex items-center gap-1">
              {contentOpen ? "收起" : "展开"}
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform",
                  contentOpen && "rotate-180",
                )}
              />
            </span>
          </button> */}
          {/* {contentOpen && ( */}
          <div className="max-h-[min(45vh,20rem)] overflow-y-auto overscroll-contain px-4 pb-3 scroll-fade scroll-fade-30">
            <div
              className={cn(
                " leading-relaxed my-2",
                "[&_.aui-md]:text-ui [&_.aui-md]:leading-relaxed",
                // // 正文里的标题按卡片层级缩小：计划正文是预览，不该用文档级
                // // H1 字号把整张卡撑爆
                // "[&_.aui-md_h1]:mt-2.5 [&_.aui-md_h1]:mb-1 [&_.aui-md_h1]:text-sm [&_.aui-md_h1]:leading-5 [&_.aui-md_h1]:font-semibold",
                // "[&_.aui-md_h2]:mt-2.5 [&_.aui-md_h2]:mb-1 [&_.aui-md_h2]:text-ui [&_.aui-md_h2]:font-semibold",
                // "[&_.aui-md_h3]:mt-2 [&_.aui-md_h3]:mb-0.5 [&_.aui-md_h3]:text-ui [&_.aui-md_h3]:font-semibold",
                "[&_.aui-md_p]:my-1.5",
                "[&_.aui-md_ul]:my-1.5 [&_.aui-md_ol]:my-1.5",
                "[&_.aui-md_li]:my-0.5",
              )}
            >
              <MarkdownText text={planBody} />
            </div>
          </div>
          {/* )} */}
        </div>
      )}

      {asking ? (
        <div className="bg-muted/20 border-t border-border/60 px-4 py-3">
          <Label
            htmlFor={inputId}
            className="flex items-center gap-2 text-xs font-medium"
          >
            希望怎么改？
            <span className="text-muted-foreground/70 font-normal">选填</span>
          </Label>
          <Textarea
            id={inputId}
            autoFocus
            value={reason}
            disabled={busy}
            maxLength={4000}
            rows={3}
            placeholder="例如：第 2 步先补测试，暂时不要改 UI"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelReason();
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                submitReason();
              }
            }}
            className="bg-muted mt-1.5 min-h-20 resize-none text-sm"
          />
          <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
            填写理由后提交，Agent
            会按意见修订计划并再次确认；留空提交则直接停止本轮（计划文件保留）。
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy}
              onClick={cancelReason}
              className="px-3.5"
            >
              取消
            </Button>
            <Button
              type="button"
              variant={hasReason ? "default" : "destructive"}
              size="lg"
              disabled={busy}
              onClick={submitReason}
              className=" px-3.5"
            >
              {hasReason ? "提交修改意见" : "直接拒绝并停止"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="bg-muted/20 flex justify-end gap-2 border-t border-border/60 px-4 py-2.5">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={() => setAsking(true)}
            className="px-3.5"
          >
            拒绝并说明
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={busy}
            onClick={() => decide(true)}
            className=" px-3.5"
          >
            <CheckIcon className="size-3.5" />
            批准并开始实施
          </Button>
        </div>
      )}
    </div>
  );
};

const ApprovalRow: FC<{
  sessionId: string;
  approval: PendingToolApprovalView;
}> = ({ sessionId, approval }) => {
  const [busy, setBusy] = useState(false);
  const summary = summarizeInput(approval.toolName, approval.input);

  const decide = (approved: boolean, remember = false, scope?: RememberScope) => {
    setBusy(true);
    confirmToolApproval(
      sessionId,
      approval.approvalId,
      approved,
      remember,
      undefined,
      scope,
    ).catch(() => {});
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
        {approval.parentToolCallId && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            来自 <span className="font-mono">run_code</span>
            {approval.parentDescription ? ` · ${approval.parentDescription}` : ""}
          </p>
        )}
        {summary && (
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
            {summary}
          </p>
        )}
        {/* 「同意意味着什么」：如可写根清单的授权。不显式写出就是静默扩大权限 */}
        {approval.note && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {approval.note}
          </p>
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
            write/edit）：其余的没有"一条可记住的路径"可言，给了按钮就是骗人。
            MCP 审批带 rememberScopes：下拉选作用域（本会话/本项目/所有项目） */}
        {approval.canRemember &&
          (approval.rememberScopes?.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className="h-8 rounded-full px-3.5"
                  />
                }
              >
                <BookmarkPlusIcon className="size-3.5" />
                允许并记住
                <ChevronDownIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>记住这个 MCP 工具的范围</DropdownMenuLabel>
                <DropdownMenuItem disabled={busy} onClick={() => decide(true, true, "session")}>
                  本会话（重启后失效）
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => decide(true, true, "project")}>
                  本项目（.kova/permissions.local.json）
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => decide(true, true, "user")}>
                  所有项目（~/.kova/permissions.json）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
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
          ))}
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
        "border-border/60 relative z-10 mb-2 bg-card overflow-hidden rounded-2xl border shadow-sm",
        approvals.length > 1 && "divide-y",
      )}
    >
      {approvals.map((a) => (
        <ApprovalRow key={a.approvalId} sessionId={sessionId} approval={a} />
      ))}
    </div>
  );
};
