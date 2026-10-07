"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PauseIcon, PlayIcon, WorkflowIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  clearWorkflowNow,
  confirmWorkflowNow,
  fetchWorkflowState,
  isWorkflowAwaitingConfirmation,
  pauseWorkflowNow,
  rejectWorkflowNow,
  openWorkflowPanel,
  resumeWorkflowNow,
  useWorkflowLiveHydration,
  useWorkflowState,
  type WorkflowSnapshot,
} from "@/lib/pi/pi-workflow";
import {
  WorkflowConfirmPanel,
  stepTimedOut,
  useNowTick,
} from "@/components/agent-thread/workflow-cards";

/**
 * 工作流模式常驻条(composer 正上方,与 goal-strip 同一外壳与定位)。
 *
 * 定位:一条始终在场的状态行——运行执行在 sidecar 后台,用户离开十分钟回来,
 * 条上要能立刻看出「跑到哪一步、停在哪、还是跑完了」。步骤级的展开视图在
 * 剧本明细在对话里的剧本卡上(编排图 + 参数名);这条负责状态与动作。
 *
 * 三个状态面:
 * - proposed:待确认剧本 → 整条升级成审批卡(图在上、确认/驳回在底部,见 WorkflowConfirmPanel)
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
  const { run } = useWorkflowState(threadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [busy, setBusy] = useState(false);

  // 挂载/换线程时水合(刷新后本地 store 为空,sidecar 的 workflow_state 行才是事实源)
  useEffect(() => {
    if (!threadId) return;
    fetchWorkflowState(threadId).catch(() => {});
  }, [threadId]);
  // 运行中兜底轮询:推进 chunk 丢掉时条不至于冻在「运行中 0/7 步」
  useWorkflowLiveHydration(threadId, run?.status === "running");
  // 秒级重渲染(running 的超时标记要跟着走)。必须在提前 return 之前调用——
  // 提前 return 之后的条件 hook 会在「无 run → 有 run」的渲染之间改变 hook 顺序
  const now = useNowTick(run?.status === "running");

  // 没有运行不渲染:建运行的入口就是「在工作流档里发一条消息」,提案一到对话里
  // 就长出剧本卡——再挂一条教程行只是占着输入框上方(实机反馈:对话已经会显示)
  if (!threadId || !run) return null;
  // 已完成不显示:报告已回投对话、凭据在运行卡上,这条只剩「已完成 N/N 步 · token」
  // ——信息价值为零,却永久占着输入框上方一行(实机反馈)。终止态的**清除**入口
  // 因此挪到运行卡上(槽位不清,下一条消息起不了新运行,出口不能跟着一起消失)
  if (run.status === "complete") return null;

  const act = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    fn(threadId)
      .catch((err) => console.error("workflow action failed:", err))
      .finally(() => setBusy(false));
  };

  const awaiting = isWorkflowAwaitingConfirmation(run);
  const live = run.status === "running" || run.status === "proposing";
  // 运行停了但对话轮还在跑(用户刚发消息接管):两个事实同时成立,条上要同时说
  const turnBusy = isRunning && !live;
  // 超时兜底标记(审计缺陷 4 的 UI 侧显式化):某步 running 已超过其超时上限
  // 仍未结算——条上出「?」,用户能看到异常而不是永远「运行中」
  const stepByKey = new Map((run.steps ?? []).map((s) => [s.key, s] as const));
  const timedOutStep = (run.stepStates ?? []).find((s) => stepTimedOut(stepByKey.get(s.key), s, now));

  // 待确认:整条升级成「审批卡」(与 ToolApprovalCard 同族、同在 composer 区)——
  // 上部是编排图与逐字命令门,底部一行 驳回 / 确认并开始。原先靠一个 320px 的
  // 弹层装这些东西,图在里面横向滚得没法看(实机反馈:把工作流放到上面,底部点确认)
  if (awaiting) {
    return (
      <div
        data-slot="aui-workflow-strip"
        className={cn(STRIP_SHELL, "flex flex-col overflow-hidden rounded-2xl border shadow-sm")}
      >
        <div className="flex items-center gap-2 px-4 py-2.5">
          <WorkflowIcon className={cn("size-3.5 shrink-0", STATUS_CLASS[run.status])} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.objective}>
            {run.title || run.objective}
          </span>
          <span className={cn("shrink-0 text-[11px]", STATUS_CLASS[run.status])}>
            {run.statusLine}
          </span>
        </div>
        <div className="border-border/40 border-t px-4 py-3">
          <WorkflowConfirmPanel
            run={run}
            busy={busy}
            threadId={threadId}
            onConfirm={(args) => act((id) => confirmWorkflowNow(id, args))}
            onReject={(text) => act((id) => rejectWorkflowNow(id, text))}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="aui-workflow-strip"
      className={cn(
        STRIP_SHELL,
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
      )}
    >
      <WorkflowIcon className={cn("size-3.5 shrink-0", STATUS_CLASS[run.status])} />
      <button
        type="button"
        onClick={() => openWorkflowPanel(run.title || run.objective)}
        className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
        title="在右侧面板打开完整编排图(暂停/继续/清除也在那里)"
      >
        {run.title || run.objective}
      </button>
      {/* statusLine 是 sidecar 算好的一行摘要(运行步数/并发/暂停原因都在里面),
          两端不各算一遍;这里不再另拼文案 */}
      <span className={cn("shrink-0", STATUS_CLASS[run.status])}>{run.statusLine}</span>
      {timedOutStep && (
        <span
          className="shrink-0 text-amber-600 dark:text-amber-400"
          title={`步骤「${stepByKey.get(timedOutStep.key)?.title ?? timedOutStep.key}」已运行超过其超时上限,执行器仍在等待——可能已挂死`}
        >
          ?
        </span>
      )}
      {run.resultsUnavailable && (
        <span
          className="shrink-0 text-amber-600/90 dark:text-amber-400/90"
          title="进程重启后 run 文件缺失:历史步骤结果不可用,相关步骤将重跑"
        >
          历史结果不可用
        </span>
      )}
      <span
        className="text-muted-foreground/70 hidden shrink-0 tabular-nums md:inline"
        title="本次运行消耗的 token,含所有子代理(仅供参考)"
      >
        {formatTokens(run.tokensUsed)} token
      </span>
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
