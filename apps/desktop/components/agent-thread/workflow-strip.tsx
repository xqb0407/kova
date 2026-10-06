"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PlayIcon, WorkflowIcon, XIcon } from "lucide-react";
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
  type WorkflowStepState,
  type WorkflowStepView,
} from "@/lib/pi/pi-workflow";

/**
 * 工作流模式常驻条(composer 正上方,与 goal-strip 同一外壳与定位)。
 *
 * 「常驻」的理由同 goal-strip:工作流的后台执行是静默的——用户离开十分钟回来,
 * 扇出的步骤可能已经跑完/暂停/失败,条必须一直在,显示停在哪一步、还剩几步。
 *
 * 三个状态面:
 * - proposed:待确认剧本卡(折叠在 Popover 里,steps 按 phase 分组)——确认即授权
 *   整个计划,含每个 delegate 步骤要跑的子智能体
 * - running:状态行 + 呼吸点 + 暂停(执行器在 sidecar 后台跑,条只是投影)
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

const STEP_STATUS_LABEL: Record<WorkflowStepState["status"], string> = {
  pending: "待跑",
  running: "运行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
  interrupted: "已中断",
};

const STEP_STATUS_CLASS: Record<WorkflowStepState["status"], string> = {
  pending: "text-muted-foreground",
  running: "text-emerald-600 dark:text-emerald-400",
  done: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  skipped: "text-muted-foreground",
  interrupted: "text-amber-600 dark:text-amber-400",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 步骤按 phase 分组(phase 是编排器写的中文展示分组) */
function groupByPhase(steps: WorkflowStepView[]): Array<[string, WorkflowStepView[]]> {
  const groups = new Map<string, WorkflowStepView[]>();
  for (const s of steps) {
    const phase = s.phase || "执行";
    groups.set(phase, [...(groups.get(phase) ?? []), s]);
  }
  return [...groups.entries()];
}

/**
 * 待确认剧本卡:确认 = 授权整个计划(含每个步骤跑的子智能体)。
 * 驳回必须带意见回流——重提轮的提示词里只有用户的这段话可依据。
 */
const ProposalConfirmCard: FC<{
  run: WorkflowSnapshot;
  busy: boolean;
  onConfirm: () => void;
  onReject: (feedback: string) => void;
}> = ({ run, busy, onConfirm, onReject }) => {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const steps = run.steps ?? [];
  const states = new Map((run.stepStates ?? []).map((s) => [s.key, s]));
  const previousFeedback = run.proposalFeedback;

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          rows={3}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="哪里不对?模型下一轮会按这段意见重拟剧本"
          className="border-border/60 bg-background w-full resize-none rounded border p-2 text-[11px] leading-relaxed outline-none"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5"
            onClick={() => setRejecting(false)}
          >
            返回
          </Button>
          <Button
            size="sm"
            className="h-7 px-3"
            disabled={busy}
            onClick={() => onReject(feedback)}
          >
            提交意见
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium">剧本(确认后开始执行)</div>
      {previousFeedback && (
        <div className="border-border/60 text-muted-foreground rounded border border-dashed p-2 text-[11px] leading-relaxed">
          上一版为什么被退回:{previousFeedback}
        </div>
      )}
      {groupByPhase(steps).map(([phase, phaseSteps]) => (
        <div key={phase} className="flex flex-col gap-1">
          <div className="text-muted-foreground text-[11px] font-medium">{phase}</div>
          {phaseSteps.map((s) => {
            const st = states.get(s.key);
            return (
              <div key={s.key} className="flex items-baseline gap-1.5 text-[11px] leading-relaxed">
                <span className="text-muted-foreground shrink-0">
                  {s.kind === "synthesize" ? "◆ 汇总" : "▸"} {s.title}
                </span>
                {s.agent && (
                  <span className="text-muted-foreground/70 shrink-0">@{s.agent}</span>
                )}
                {s.dependsOn.length > 0 && (
                  <span className="text-muted-foreground/70 hidden shrink-0 sm:inline">
                    ← {s.dependsOn.join(", ")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        确认后由执行器自动编排:无依赖的步骤并发跑,全部完成后自动交付报告。
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          disabled={busy}
          onClick={() => setRejecting(true)}
        >
          驳回
        </Button>
        <Button size="sm" className="h-7 px-3" disabled={busy} onClick={() => onConfirm()}>
          确认并开始
        </Button>
      </div>
    </div>
  );
};

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
  const done = (run.stepStates ?? []).filter((s) => s.status === "done").length;
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
            <ProposalConfirmCard
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
