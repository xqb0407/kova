"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PauseIcon, PlayIcon, Trash2Icon, WorkflowIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  clearWorkflowNow,
  confirmWorkflowNow,
  fetchWorkflowState,
  isWorkflowAwaitingConfirmation,
  pauseWorkflowNow,
  rejectWorkflowNow,
  resumeWorkflowNow,
  useWorkflowLiveHydration,
  useWorkflowState,
  type WorkflowSnapshot,
} from "@/lib/pi/pi-workflow";
import { WorkflowConfirmPanel, WorkflowStepDrawer, splitStepStates } from "@/components/agent-thread/workflow-cards";
import { WorkflowGraph } from "@/components/agent-thread/workflow-graph";
import { openSubagentTab } from "@/lib/subagent/subagent-runs";
import { TabEmpty } from "./tab-empty";

/**
 * 工作流面板 tab:编排图 + 运行控制(暂停/继续/清除;待确认时是参数与确认/驳回)。
 *
 * 与常驻条的差异是**视野**:条只有一行状态,面板有整列宽度——图在这里是完整可读的,
 * 点节点开详情抽屉也不用挤在对话流里。数据源与条、对话卡同一个 pi-workflow store,
 * 三处永远一致(push 通知行为主通道,挂载时水合一次)。
 */

const STATUS_LABEL: Record<WorkflowSnapshot["status"], string> = {
  proposing: "编排中",
  proposed: "待确认",
  running: "运行中",
  paused: "已暂停",
  complete: "已完成",
  failed: "失败",
};

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

export const WorkflowTab: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { run } = useWorkflowState(threadId);
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  // 挂载水合:面板可能先于对话打开(刷新后 restore 的槽在 sidecar,不在本地 store)
  useEffect(() => {
    if (!threadId) return;
    fetchWorkflowState(threadId).catch(() => {});
  }, [threadId]);
  useWorkflowLiveHydration(threadId, run?.status === "running");

  if (!threadId) return <TabEmpty icon={WorkflowIcon} text="没有活动会话" />;
  if (!run) {
    return (
      <TabEmpty
        icon={WorkflowIcon}
        text="这个会话还没有工作流运行。在工作流档里描述要编排的任务，模型拟定剧本后这里会显示编排图与控制。"
      />
    );
  }

  const act = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    fn(threadId)
      .catch((err) => console.error("workflow panel action failed:", err))
      .finally(() => setBusy(false));
  };

  const steps = run.steps ?? [];
  const awaiting = isWorkflowAwaitingConfirmation(run);
  const { top, childrenByParent } = splitStepStates(run.stepStates);
  const openStepDef = steps.find((s) => s.key === openKey);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部:标题 + 状态读数 + 控制(与常驻条/运行卡同一套动作) */}
      <div className="border-border/50 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.objective}>
          {run.title || run.objective}
        </span>
        <span className={cn("shrink-0 text-[11px]", STATUS_CLASS[run.status])}>
          {STATUS_LABEL[run.status]}
        </span>
        <span className="text-muted-foreground/70 shrink-0 text-[11px]">{run.statusLine}</span>
        <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums">
          {formatTokens(run.tokensUsed)} token
        </span>
        {run.status === "running" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => act(pauseWorkflowNow)}
            title="暂停运行(已完成的步骤不重跑)"
            className="h-6 shrink-0 gap-1 px-2 text-[11px]"
          >
            <PauseIcon className="size-3" /> 暂停
          </Button>
        )}
        {run.status === "paused" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => act(resumeWorkflowNow)}
            title="继续运行(已完成的步骤不重跑)"
            className="h-6 shrink-0 gap-1 px-2 text-[11px]"
          >
            {busy ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
            继续
          </Button>
        )}
        {(run.status === "paused" || run.status === "complete" || run.status === "failed") && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => act(clearWorkflowNow)}
            title="清除这次运行(写进工作区的产物不动)"
            className="h-6 shrink-0 gap-1 px-2 text-[11px]"
          >
            <Trash2Icon className="size-3" /> 清除
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {run.resultsUnavailable && (
          <p className="text-amber-600/90 dark:text-amber-400/90 mb-2 text-[11px] leading-relaxed">
            历史步骤结果未能读回(进程重启后 run 文件缺失):相关步骤将重跑,不沿用旧产出。
          </p>
        )}
        {awaiting ? (
          /* 待确认:面板里就能填参数并确认/驳回(与常驻条同一个面板组件) */
          <WorkflowConfirmPanel
            run={run}
            busy={busy}
            threadId={threadId}
            onConfirm={(args) => act((id) => confirmWorkflowNow(id, args))}
            onReject={(text) => act((id) => rejectWorkflowNow(id, text))}
          />
        ) : steps.length === 0 ? (
          <div className="text-muted-foreground/70 flex items-center gap-1.5 text-[11px]">
            <Loader2Icon className="size-3 animate-spin" /> 正在拟剧本…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <WorkflowGraph
              steps={steps}
              states={top}
              childrenByParent={childrenByParent}
              onOpen={(key) => {
                const st = top.get(key);
                const ids =
                  st?.delegationIds?.length
                    ? st.delegationIds
                    : st?.delegationId
                      ? [st.delegationId]
                      : [];
                // 一个委派 → 子智能体面板看实时流;0 个或 ≥2 个(复核)→ 就地抽屉
                if (ids.length === 1) {
                  openSubagentTab(ids[0]!, steps.find((s) => s.key === key)?.title ?? key);
                  return;
                }
                setOpenKey(openKey === key ? null : key);
              }}
              activeKey={openKey}
            />
            {openStepDef && (
              <WorkflowStepDrawer
                threadId={threadId}
                step={openStepDef}
                state={top.get(openStepDef.key)}
                now={Date.now()}
                onClose={() => setOpenKey(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
