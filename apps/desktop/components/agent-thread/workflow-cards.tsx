"use client";

import { useState, type FC } from "react";
import { Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type {
  WorkflowSnapshot,
  WorkflowStepState,
  WorkflowStepView,
} from "@/lib/pi/pi-workflow";

/**
 * 工作流的两张共享卡片:
 * - WorkflowPlanCard:待确认剧本卡(常驻条 Popover 与对话里的提案行共用)。
 *   gate 命令逐字展示——用户确认的就是要执行的那串字面量。
 * - WorkflowRunCard:运行进度卡(对话里的提案行在确认后原地变卡;常驻条同源)。
 *
 * 卡片本体不持有请求逻辑:动作由调用方注入(onConfirm/onReject/onPause/onResume),
 * 因为两处的 threadId 来源不同(常驻条来自当前线程,提案行来自锚点表)。
 */

/** 步骤按 phase 分组(phase 是编排器写的中文展示分组) */
export function groupByPhase(steps: WorkflowStepView[]): Array<[string, WorkflowStepView[]]> {
  const groups = new Map<string, WorkflowStepView[]>();
  for (const s of steps) {
    const phase = s.phase || "执行";
    groups.set(phase, [...(groups.get(phase) ?? []), s]);
  }
  return [...groups.entries()];
}

const KIND_MARK: Record<string, string> = {
  synthesize: "◆ 汇总",
  gate: "▣ 门",
  verify: "◈ 复核",
  delegate: "▸",
};

const STEP_STATUS_CLASS: Record<WorkflowStepState["status"], string> = {
  pending: "text-muted-foreground",
  running: "text-emerald-600 dark:text-emerald-400",
  done: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  skipped: "text-muted-foreground/70",
  interrupted: "text-amber-600 dark:text-amber-400",
};

const STEP_STATUS_LABEL: Record<WorkflowStepState["status"], string> = {
  pending: "待跑",
  running: "运行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
  interrupted: "已中断",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 一步的展示行(声明 + 状态合一);foreach 展开的子项折叠成「n 项」小标 */
const StepLine: FC<{
  step: WorkflowStepView;
  state?: WorkflowStepState;
  children: WorkflowStepState[];
}> = ({ step, state, children }) => (
  <div className="flex flex-col gap-0.5 text-[11px] leading-relaxed">
    <div className="flex items-baseline gap-1.5">
      <span className={cn("shrink-0", state ? STEP_STATUS_CLASS[state.status] : "text-muted-foreground")}>
        {KIND_MARK[step.kind] ?? "▸"} {step.title}
      </span>
      {step.agent && <span className="text-muted-foreground/70 shrink-0">@{step.agent}</span>}
      {step.verify && (
        <span className="text-muted-foreground/70 shrink-0">
          {step.verify.reviewers ?? 2} 位评审
        </span>
      )}
      {state && (
        <span className={cn("shrink-0", STEP_STATUS_CLASS[state.status])}>
          {STEP_STATUS_LABEL[state.status]}
          {children.length > 0 && ` · ${children.filter((c) => c.status === "done" || c.status === "skipped").length}/${children.length} 项`}
        </span>
      )}
      {step.dependsOn.length > 0 && (
        <span className="text-muted-foreground/70 hidden shrink-0 sm:inline">
          ← {step.dependsOn.join(", ")}
        </span>
      )}
    </div>
    {/* gate 命令逐字展示:用户确认的就是要执行的这串字面量 */}
    {step.gate && (
      <code className="border-border/60 bg-background/70 text-foreground/80 block truncate rounded border px-1.5 py-0.5 font-mono text-[10px]">
        {[step.gate.command, ...(step.gate.args ?? [])].join(" ")}
      </code>
    )}
    {state?.error && (
      <span className="text-muted-foreground/80 line-clamp-2 break-all">{state.error}</span>
    )}
    {children.length > 0 && (
      <span className="flex flex-wrap items-center gap-1 pt-0.5">
        {children.map((c) => (
          <span
            key={c.key}
            title={c.item ?? c.key}
            className={cn(
              "inline-block size-1.5 rounded-full",
              c.status === "done"
                ? "bg-emerald-500/70"
                : c.status === "running"
                  ? "animate-pulse bg-emerald-500"
                  : c.status === "failed"
                    ? "bg-red-500/80"
                    : c.status === "skipped" || c.status === "interrupted"
                      ? "bg-amber-500/70"
                      : "bg-muted-foreground/40",
            )}
          />
        ))}
      </span>
    )}
  </div>
);

/**
 * 待确认剧本卡(常驻条 Popover 与对话提案行共用)。
 * 驳回必须带意见回流——重提轮的提示词里只有用户的这段话可依据。
 */
export const WorkflowPlanCard: FC<{
  run: WorkflowSnapshot;
  busy: boolean;
  onConfirm: () => void;
  onReject: (feedback: string) => void;
}> = ({ run, busy, onConfirm, onReject }) => {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const steps = run.steps ?? [];
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
          <Button variant="ghost" size="sm" className="h-7 px-2.5" onClick={() => setRejecting(false)}>
            返回
          </Button>
          <Button size="sm" className="h-7 px-3" disabled={busy} onClick={() => onReject(feedback)}>
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
          {phaseSteps.map((s) => (
            <StepLine key={s.key} step={s} children={[]} />
          ))}
        </div>
      ))}
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        确认后由执行器自动编排:无依赖的步骤并发跑,命令门按退出码判定,
        全部完成后自动交付报告。
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 px-2.5" disabled={busy} onClick={() => setRejecting(true)}>
          驳回
        </Button>
        <Button size="sm" className="h-7 px-3" disabled={busy} onClick={() => onConfirm()}>
          确认并开始
        </Button>
      </div>
    </div>
  );
};

/**
 * 运行进度卡:phase 分节的步骤列表 + 状态 + 子项点阵 + 暂停/继续。
 * 与常驻条同源(同一个 data-workflow-state 快照),但这里按步骤展开——
 * 「谁在做、做到哪、哪一步错了」在这张卡里一眼可见。
 */
export const WorkflowRunCard: FC<{
  run: WorkflowSnapshot;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  /** 存为剧本(仅完成的运行显示);解析后按钮转「已存为剧本」 */
  onSave?: () => Promise<void>;
}> = ({ run, busy, onPause, onResume, onSave }) => {
  const [saved, setSaved] = useState(false);
  const steps = run.steps ?? [];
  const states = new Map<string, WorkflowStepState>();
  const childrenByParent = new Map<string, WorkflowStepState[]>();
  for (const s of run.stepStates ?? []) {
    if (s.parent) {
      childrenByParent.set(s.parent, [...(childrenByParent.get(s.parent) ?? []), s]);
    } else {
      states.set(s.key, s);
    }
  }
  const live = run.status === "running" || run.status === "proposing";
  const failedStep = (run.stepStates ?? []).find((s) => s.status === "failed");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.objective}>
          {run.title || run.objective}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            run.status === "running" || run.status === "proposing"
              ? "text-emerald-600 dark:text-emerald-400"
              : run.status === "complete"
                ? "text-muted-foreground"
                : "text-amber-600 dark:text-amber-400",
          )}
        >
          {run.statusLine}
        </span>
        <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums" title="本次运行消耗的 token,含所有子代理">
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
            onClick={onPause}
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
            onClick={onResume}
            title="继续运行(已完成的步骤不重跑)"
            className="h-6 shrink-0 px-2"
          >
            {busy ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
            <span className="sr-only">继续</span>
          </Button>
        )}
        {onSave && run.status === "complete" && !run.playbookName && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || saved}
            onClick={() => {
              void onSave()
                .then(() => setSaved(true))
                .catch((err) => console.error("save playbook failed:", err));
            }}
            title="把这套剧本存进剧本库,以后可带参数重跑(设置 → 工作流剧本)"
            className="h-6 shrink-0 px-2 text-[11px]"
          >
            {saved ? "已存为剧本 ✓" : "存为剧本"}
          </Button>
        )}
      </div>
      {steps.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {groupByPhase(steps).map(([phase, phaseSteps]) => (
            <div key={phase} className="flex flex-col gap-1">
              <div className="text-muted-foreground text-[11px] font-medium">{phase}</div>
              {phaseSteps.map((s) => (
                <StepLine
                  key={s.key}
                  step={s}
                  state={states.get(s.key)}
                  children={childrenByParent.get(s.key) ?? []}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground text-[11px]">正在拟剧本…</div>
      )}
      {failedStep && run.status === "failed" && (
        <p className="text-red-600/90 dark:text-red-400/90 text-[11px] leading-relaxed">
          {run.statusLine}
        </p>
      )}
    </div>
  );
};
