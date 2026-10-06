"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PauseIcon, PlayIcon, WorkflowIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSessionMode } from "@/lib/pi/pi-session-mode";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  clearWorkflowNow,
  confirmWorkflowNow,
  fetchWorkflowState,
  isWorkflowAwaitingConfirmation,
  pauseWorkflowNow,
  rejectWorkflowNow,
  resumeWorkflowNow,
  useWorkflowState,
  type WorkflowSnapshot,
} from "@/lib/pi/pi-workflow";
import { WorkflowPlanCard } from "@/components/agent-thread/workflow-cards";

/**
 * 工作流模式常驻条(composer 正上方,与 goal-strip 同一外壳与定位)。
 *
 * 定位:一条始终在场的状态行——运行执行在 sidecar 后台,用户离开十分钟回来,
 * 条上要能立刻看出「跑到哪一步、停在哪、还是跑完了」。步骤级的展开视图在
 * 对话里的运行卡(workflow-cards)与这条的 Popover 里,条本身只报状态。
 *
 * 三个状态面:
 * - proposed:待确认剧本 → Popover 里是共享的 WorkflowPlanCard(与提案行同卡)
 * - running:状态行 + 呼吸点 + 暂停
 * - paused/complete/failed:继续/摘要/原因 + 清除
 */

const STRIP_SHELL =
  "bg-(--composer-bg) border-border/60 mb-2 backdrop-blur-md backdrop-saturate-110";

const STATUS_CLASS: Record<WorkflowSnapshot["status"], string> = {
  proposing: "text-emerald-600 dark:text-emerald-400",
  proposed: "text-amber-600 dark:text-amber-400",
  running: "text-emerald-600 dark:text-emerald-400",
  paused: "text-amber-600 dark:text-amber-400",
  complete: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export const WorkflowStrip: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { mode } = useSessionMode(threadId);
  const { run } = useWorkflowState(threadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [busy, setBusy] = useState(false);

  // 挂载/换线程时水合(刷新后本地 store 为空,sidecar 的 workflow_state 行才是事实源)
  useEffect(() => {
    if (!threadId) return;
    fetchWorkflowState(threadId).catch(() => {});
  }, [threadId]);

  // workflow 档下即使还没有运行也要挂:这一行提示是编排目标唯一的建运行入口
  if (!threadId || (mode !== "workflow" && !run)) return null;

  const act = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    fn(threadId)
      .catch((err) => console.error("workflow action failed:", err))
      .finally(() => setBusy(false));
  };

  if (!run) {
    return (
      <div
        data-slot="aui-workflow-strip"
        className={cn(
          STRIP_SHELL,
          "flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs",
        )}
      >
        <WorkflowIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-muted-foreground">
          描述要编排的任务,我先拟一份多智能体剧本(谁跑哪步、结果怎么汇),
          你确认后由执行器自动跑完。
        </span>
      </div>
    );
  }

  const awaiting = isWorkflowAwaitingConfirmation(run);
  const live = run.status === "running" || run.status === "proposing";
  const total = (run.steps ?? []).length;
  // 运行停了但对话轮还在跑(用户刚发消息接管):两个事实同时成立,条上要同时说
  const turnBusy = isRunning && !live;

  return (
    <div
      data-slot="aui-workflow-strip"
      className={cn(
        STRIP_SHELL,
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
      )}
    >
      <WorkflowIcon className={cn("size-3.5 shrink-0", STATUS_CLASS[run.status])} />
      <span className="min-w-0 flex-1 truncate" title={run.objective}>
        {run.title || run.objective}
      </span>
      {/* statusLine 是 sidecar 算好的一行摘要(运行步数/并发/暂停原因都在里面),
          两端不各算一遍;这里不再另拼文案 */}
      <span className={cn("shrink-0", STATUS_CLASS[run.status])}>{run.statusLine}</span>
      <span
        className="text-muted-foreground/70 hidden shrink-0 tabular-nums md:inline"
        title="本次运行消耗的 token,含所有子代理(仅供参考)"
      >
        {formatTokens(run.tokensUsed)} token
      </span>
      {awaiting && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px]"
                disabled={busy}
                title="查看并确认剧本"
              >
                确认剧本
                {total > 0 ? `(${total} 步)` : ""}
              </Button>
            }
          />
          <PopoverContent align="end" className="w-80 p-3">
            <WorkflowPlanCard
              run={run}
              busy={busy}
              onConfirm={() => act(confirmWorkflowNow)}
              onReject={(text) => act((id) => rejectWorkflowNow(id, text))}
            />
          </PopoverContent>
        </Popover>
      )}
      {live && (
        <span title="执行器运行中" className="flex shrink-0 items-center">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
        </span>
      )}
      {run.status === "running" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => act(pauseWorkflowNow)}
          title="暂停运行(已完成的步骤不重跑)"
          className="h-6 shrink-0 px-2"
        >
          <PauseIcon className="size-3" />
          <span className="sr-only">暂停</span>
        </Button>
      )}
      {run.status === "paused" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => act(resumeWorkflowNow)}
          title="继续运行(已完成的步骤不重跑)"
          className="h-6 shrink-0 px-2"
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
          <span className="sr-only">继续</span>
        </Button>
      )}
      {turnBusy && (
        <span className="text-muted-foreground/80 hidden shrink-0 md:inline">
          正在处理这条消息
        </span>
      )}
      {run.status !== "running" && run.status !== "proposing" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => act(clearWorkflowNow)}
          title="清除本次运行(不影响已写到工作区的改动)"
          className="h-6 shrink-0 px-2"
        >
          <XIcon className="size-3" />
          <span className="sr-only">清除</span>
        </Button>
      )}
    </div>
  );
};
