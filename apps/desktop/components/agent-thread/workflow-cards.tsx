"use client";

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import {
  SquareArrowOutUpRightIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchWorkflowStepDetail, openWorkflowPanel } from "@/lib/pi/pi-workflow";
import { openSubagentTab } from "@/lib/subagent/subagent-runs";
import { WorkflowGraph } from "@/components/agent-thread/workflow-graph";
import type {
  WorkflowSnapshot,
  WorkflowStepState,
  WorkflowStepView,
} from "@/lib/pi/pi-workflow";
import type { WorkflowStepDetail } from "pi-protocol";

/**
 * 工作流卡片组(v3,设计见 plans/workflow-ui-design.md):
 * - WorkflowPlanCard:待确认剧本卡 —— 编排图 + 参数槽 + 确认/驳回。
 * - WorkflowRunCard:运行进度卡 —— 同一张编排图随状态着色(运行中脉冲/失败红/
 *   中断琥珀),终态默认折叠成执行凭据。
 * - WorkflowStepDrawer:单步详情,按需拉 workflow_step_detail(prompt 与步骤结果
 *   是最重的两块,刻意不进常规快照)。
 *
 * 编排图承担「谁先跑、谁能并行、结果汇到哪」的表达(依赖即连线),抽屉承担
 * 「这一步到底要干什么」的深查。卡片本体不持有请求逻辑:动作由调用方注入
 * (onConfirm/onReject/onPause/onResume),因为两处的 threadId 来源不同。
 */

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

const STEP_STATUS_DOT: Record<WorkflowStepState["status"], string> = {
  pending: "bg-muted-foreground/30",
  running: "animate-pulse bg-emerald-500",
  done: "bg-emerald-500/70",
  failed: "bg-red-500",
  skipped: "bg-amber-500/80",
  interrupted: "bg-amber-500",
};

/** interrupted 的补充说明:与 pending 的视觉分离要配得上一句解释 */
const INTERRUPTED_HINT = "该步上次运行被中断,继续运行时会从起点重跑";

/** 缺省超时兜底(旧协议快照没有 timeoutMs 时用;新投影恒带解析后的值) */
const DEFAULT_STEP_TIMEOUT_FALLBACK_MS = 20 * 60_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest ? `${mins}m${rest}s` : `${mins}m`;
}

/**
 * 该步是否已超过超时上限仍未结算(running 且 startedAt 距现在 > timeoutMs)。
 * 审计缺陷 4(无步骤超时 → UI 永远「运行中」)的 UI 兜底:哪怕执行器的超时修复
 * 失效,用户也能看见异常,而不是盯着一个撒谎的「运行中」。
 */
export function stepTimedOut(
  step: WorkflowStepView | undefined,
  state: WorkflowStepState | undefined,
  now: number,
): boolean {
  if (!state || state.status !== "running" || !state.startedAt) return false;
  const limit = step?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_FALLBACK_MS;
  return now - state.startedAt > limit;
}

/** 秒级重渲染:只在有活跃步骤时跑(running 的用时与超时标记要跟着走) */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/* --------------------------- 状态与派生(图与抽屉共用) --------------------------- */

/** 顶层状态表 + foreach 子项表(run.stepStates 一维数组 → 两张表) */
export function splitStepStates(states: readonly WorkflowStepState[] | undefined): {
  top: Map<string, WorkflowStepState>;
  childrenByParent: Map<string, WorkflowStepState[]>;
} {
  const top = new Map<string, WorkflowStepState>();
  const childrenByParent = new Map<string, WorkflowStepState[]>();
  for (const s of states ?? []) {
    if (s.parent) {
      childrenByParent.set(s.parent, [...(childrenByParent.get(s.parent) ?? []), s]);
    } else {
      top.set(s.key, s);
    }
  }
  return { top, childrenByParent };
}

/** 已超时上限的运行中步骤集合(卡片头部与节点上的「?」标记共用) */
function timedOutKeysOf(
  steps: readonly WorkflowStepView[],
  top: Map<string, WorkflowStepState>,
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const step of steps) {
    if (stepTimedOut(step, top.get(step.key), now)) out.add(step.key);
  }
  return out;
}

/* ------------------------------ 步骤详情抽屉 ------------------------------ */

const DetailSection: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-1">
    <div className="text-muted-foreground/80 text-[10px] font-medium tracking-wide">{title}</div>
    {children}
  </div>
);

/** 正文块:散文用无衬线(可读性),命令/产出里的等宽内容靠 pre-wrap 保断行 */
const DetailText: FC<{ text: string; className?: string }> = ({ text, className }) => (
  <div
    className={cn(
      "bg-background/60 border-border/50 max-h-56 overflow-auto rounded border px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words",
      className,
    )}
  >
    {text}
  </div>
);

/**
 * 单步详情(图节点点开后的下方面板):状态与耗时在头部一行,正文按
 * 任务/判定/产出/错误分节。**不重复标题**——节点就在图里,面板只说这一步的细节。
 * 详情按需拉取(workflow_step_detail),组件本地持有,不进全局快照。
 */
export const WorkflowStepDrawer: FC<{
  threadId: string | undefined;
  step: WorkflowStepView;
  state?: WorkflowStepState;
  now: number;
  onClose: () => void;
  /** 预取的详情(预览页/测试注入):给了就不再发请求 */
  detail?: WorkflowStepDetail | null;
}> = ({ threadId, step, state, now, onClose, detail: injected }) => {
  const [detail, setDetail] = useState<WorkflowStepDetail | null>(injected ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(injected === undefined);

  useEffect(() => {
    // 注入路径:不动网络(预览与单测用)
    if (injected !== undefined) {
      setDetail(injected);
      setLoading(false);
      setError(null);
      return;
    }
    if (!threadId) {
      setLoading(false);
      setError("无法定位运行所在线程,详情不可用");
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    fetchWorkflowStepDetail(threadId, step.key)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        if (!d) setError("详情不可用(运行槽已回收或该步不存在)");
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // state.status 进依赖:步骤结算(运行中→完成)时抽屉要重拉一次,
    // 否则打开的抽屉永远停在「产出还没出现」的那一帧
  }, [threadId, step.key, state?.status, injected]);

  const reviewerIds =
    state?.delegationIds?.length
      ? state.delegationIds
      : detail?.delegationId
        ? [detail.delegationId]
        : [];
  const status = detail?.status ?? state?.status ?? "pending";
  const startedAt = detail?.startedAt ?? state?.startedAt;
  const endedAt = detail?.endedAt ?? state?.endedAt;
  const tokens = detail?.tokens ?? state?.tokens;
  const limit = detail?.timeoutMs ?? step.timeoutMs;
  const elapsed =
    startedAt !== undefined
      ? (endedAt ?? (status === "running" ? now : startedAt)) - startedAt
      : undefined;
  const overLimit =
    status === "running" && elapsed !== undefined && limit !== undefined && elapsed > limit;

  return (
    <div className="border-border/60 bg-muted/15 flex flex-col gap-2.5 rounded-lg border p-3">
      {/* 头部:状态 + 元信息;标题不在此重复(节点就在图上) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className={cn("flex items-center gap-1.5 font-medium", STEP_STATUS_CLASS[status])}>
          <span className={cn("size-1.5 rounded-full", STEP_STATUS_DOT[status])} />
          {STEP_STATUS_LABEL[status]}
        </span>
        {status === "interrupted" && (
          <span className="text-muted-foreground/70">{INTERRUPTED_HINT}</span>
        )}
        {(detail?.agent || detail?.model) && (
          <span className="text-muted-foreground">
            {[detail.agent ? `@${detail.agent}` : undefined, detail.model].filter(Boolean).join(" · ")}
          </span>
        )}
        {elapsed !== undefined && (
          <span
            className={cn(
              "tabular-nums",
              overLimit ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/80",
            )}
          >
            已 {formatDuration(elapsed)}
            {status === "running" && limit !== undefined ? ` / 上限 ${formatDuration(limit)}` : ""}
          </span>
        )}
        {tokens !== undefined && tokens > 0 && (
          <span className="text-muted-foreground/80 tabular-nums">{formatTokens(tokens)} token</span>
        )}
        {detail?.retries ? (
          <span className="text-muted-foreground/80">
            重试 {detail.retries} 次{detail.onFail === "skip" ? " · 失败跳过" : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground/70 hover:text-foreground shrink-0 cursor-pointer"
        >
          收起
        </button>
      </div>

      {loading && (
        <div className="text-muted-foreground/70 flex items-center gap-1.5 text-[11px]">
          <Loader2Icon className="size-3 animate-spin" /> 加载详情…
        </div>
      )}
      {error && !loading && <div className="text-muted-foreground/80 text-[11px]">{error}</div>}

      {detail?.gate && (
        <DetailSection title="命令(退出码即判定)">
          <code className="bg-background/60 border-border/50 block rounded border px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed break-all whitespace-pre-wrap">
            $ {[detail.gate.command, ...(detail.gate.args ?? [])].join(" ")}
          </code>
        </DetailSection>
      )}
      {detail?.verify && (
        <div className="text-muted-foreground/80 text-[10.5px]">
          对抗式评审 {detail.verify.reviewers ?? 2} 位 · 通过阈值{" "}
          {Math.round((detail.verify.threshold ?? 0.5) * 100)}%
        </div>
      )}
      {detail?.foreach && (
        <div className="text-muted-foreground/80 text-[10.5px]">
          按「{detail.foreach.from}」的结果逐行扇出
        </div>
      )}

      {detail?.prompt && (
        <DetailSection title="任务(插值后的最终 prompt)">
          <DetailText text={detail.prompt} />
        </DetailSection>
      )}
      {detail?.result && (
        <DetailSection
          title={detail.kind === "gate" ? "判定" : detail.kind === "verify" ? "投票" : "产出"}
        >
          <DetailText text={detail.result} />
        </DetailSection>
      )}
      {detail?.error && (
        <DetailSection title="错误">
          <DetailText text={detail.error} className="text-red-600/90 dark:text-red-400/90" />
        </DetailSection>
      )}

      {reviewerIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {reviewerIds.length === 1 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => openSubagentTab(reviewerIds[0]!, step.title)}
            >
              打开子智能体活动
            </Button>
          ) : (
            reviewerIds.map((id, i) => (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  openSubagentTab(id, `评审 ${i + 1}/${reviewerIds.length} · ${step.title}`)
                }
              >
                查看评审 {i + 1} 的过程
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------ 提案确认卡(v3) ------------------------------ */

/** 参数槽初值:已有值(库路径)> 声明默认值 > 空 */
function initArgInputs(run: WorkflowSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of run.args ?? []) {
    const v = run.argValues?.[a.name] ?? a.default;
    out[a.name] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

/**
 * 待确认剧本卡(对话内的**只读记录**):编排图 + 参数清单 + 去向提示。
 *
 * 动作(填参数/驳回/确认)全部收在输入框上方的 WorkflowConfirmPanel 里——
 * 同一件事两个按钮就是两份歧义,而确认面板还必须摆下「逐字命令门」(授权语义),
 * 弹层宽度放不下这张图。分工:对话里的卡负责**可回看的记录**,上方面板负责**决策**。
 */
export const WorkflowPlanCard: FC<{
  run: WorkflowSnapshot;
  /** 该运行所在线程(抽屉的详情请求带它) */
  threadId?: string;
}> = ({ run, threadId }) => {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const steps = run.steps ?? [];
  const args = run.args ?? [];
  const previousFeedback = run.proposalFeedback;
  const awaitConfirm = run.status === "proposed";
  const { top, childrenByParent } = useMemo(() => splitStepStates(run.stepStates), [run.stepStates]);

  const openStep = (key: string) => setOpenKey(openKey === key ? null : key);
  const openStepDef = steps.find((s) => s.key === openKey);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium">剧本</span>
        <span className="text-muted-foreground/70 text-[11px]">
          {steps.length} 步{awaitConfirm ? " · 待你确认" : ""}
        </span>
      </div>
      {previousFeedback && (
        <div className="border-border/60 text-muted-foreground rounded border border-dashed px-2.5 py-2 text-[11px] leading-relaxed">
          上一版为什么被退回:{previousFeedback}
        </div>
      )}

      <WorkflowGraph
        steps={steps}
        states={top}
        childrenByParent={childrenByParent}
        onOpen={openStep}
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

      {args.length > 0 && (
        <div className="text-muted-foreground/80 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="text-muted-foreground/60 text-[10px] tracking-wide">参数</span>
          {args.map((a) => (
            <span key={a.name} className="border-border/60 rounded border px-1.5 py-px font-mono text-[10px]">
              {a.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end justify-between gap-3">
        <p className="text-muted-foreground/70 text-[10.5px] leading-relaxed">
          无依赖的步骤并发跑;门按退出码判定;完成后自动交付报告。
        </p>
        {awaitConfirm && (
          <span className="text-muted-foreground/70 shrink-0 text-[10.5px]">
            在输入框上方的「确认剧本」里填参数并开始
          </span>
        )}
      </div>
    </div>
  );
};

/* ------------------------- 确认面板(输入框上方的决策面) ------------------------- */

/**
 * 确认面板(composer 区,审批卡形态):提案的**唯一动作面**。
 * 形态对齐 ToolApprovalCard:顶部是要批准的内容(**编排图**——先看清要跑什么,
 * 再决定批不批)、逐字命令门、参数槽,底部一行 驳回 / 确认并开始。
 * 图限高内滚:审批卡不该把输入框挤出屏幕。
 */
export const WorkflowConfirmPanel: FC<{
  run: WorkflowSnapshot;
  busy: boolean;
  /** 该运行所在线程(图上点节点开详情抽屉时要用) */
  threadId?: string;
  onConfirm: (args: Record<string, unknown>) => void;
  onReject: (feedback: string) => void;
}> = ({ run, busy, threadId, onConfirm, onReject }) => {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const steps = run.steps ?? [];
  const args = run.args ?? [];
  const gates = steps.filter((s) => s.kind === "gate" && s.gate);
  // 参数区默认折叠:这些占位符是「以后重跑会变的值」(模型的既定约定),对一次性
  // 运行大多可以留空(子代理自决)。一上来摆三个空框,读起来像在向用户要东西。
  // 已填过值、或确有必填缺口时才默认展开——那两种情况才真的需要用户动手
  const [argsOpen, setArgsOpen] = useState(
    () =>
      args.some((a) => a.required && a.default === undefined) ||
      args.some((a) => `${run.argValues?.[a.name] ?? ""}`.trim() !== ""),
  );
  const previousFeedback = run.proposalFeedback;

  // 参数槽表单:状态挂在「提案版本」上(驳回重拟后参数集可能变),
  // 同版本内保留用户输入——用版本键比较而不是 effect,避免每次快照重置输入
  const argVersion = `${run.id}:${args.map((a) => a.name).join(",")}`;
  const [argForm, setArgForm] = useState<{ version: string; values: Record<string, string> }>(
    () => ({ version: argVersion, values: initArgInputs(run) }),
  );
  const argValues = argForm.version === argVersion ? argForm.values : initArgInputs(run);
  const setArg = (name: string, value: string) =>
    setArgForm({ version: argVersion, values: { ...argValues, [name]: value } });

  // 确认前的参数体检,口径与运行时契约一致:
  // - 硬缺口(拦住确认):声明为必填而没填、或数字类型填了非数字(服务端必拒);
  // - 软提示(放行):可选参数留空——运行时的既定语义是插成显式缺口标记
  //   `<missing arg: x>`,让子代理自己判断,不替用户决定「必须给值」
  const argIssues: string[] = [];
  const argGaps: string[] = [];
  for (const a of args) {
    const raw = (argValues[a.name] ?? "").trim();
    if (!raw) {
      if (a.required && a.default === undefined) argIssues.push(`参数「${a.name}」未填写`);
      else argGaps.push(a.name);
      continue;
    }
    if (a.type === "number" && !Number.isFinite(Number(raw))) {
      argIssues.push(`参数「${a.name}」需要数字`);
    }
  }

  const submitConfirm = () => {
    if (argIssues.length > 0) return;
    const values: Record<string, unknown> = {};
    for (const a of args) {
      const raw = (argValues[a.name] ?? "").trim();
      if (!raw) continue;
      if (a.type === "number") values[a.name] = Number(raw);
      else if (a.type === "boolean") values[a.name] = raw === "true" || raw === "1";
      else values[a.name] = raw;
    }
    onConfirm(values);
  };

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

  const { top: stepStates, childrenByParent } = splitStepStates(run.stepStates);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openStepDef = steps.find((x) => x.key === openKey);

  return (
    <div className="flex flex-col gap-2.5">
      {/* 编排图:批准前先看清要跑什么(限高内滚,不把输入框顶出屏幕) */}
      <div className="border-border/50 bg-muted/10 max-h-[300px] overflow-auto rounded-lg border p-2">
        <WorkflowGraph
          steps={steps}
          states={stepStates}
          childrenByParent={childrenByParent}
          onOpen={(key) => setOpenKey(openKey === key ? null : key)}
          activeKey={openKey}
        />
      </div>
      {openStepDef && (
        <WorkflowStepDrawer
          threadId={threadId}
          step={openStepDef}
          state={stepStates.get(openStepDef.key)}
          now={Date.now()}
          onClose={() => setOpenKey(null)}
        />
      )}
      {previousFeedback && (
        <div className="border-border/60 text-muted-foreground rounded border border-dashed px-2 py-1.5 text-[10.5px] leading-relaxed">
          上一版为什么被退回:{previousFeedback}
        </div>
      )}

      {gates.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground/80 text-[10px] font-medium tracking-wide">
            将执行的命令门(逐字,退出码即判定)
          </div>
          {gates.map((g) => (
            <code
              key={g.key}
              className="bg-muted/40 block truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
              title={[g.gate!.command, ...(g.gate!.args ?? [])].join(" ")}
            >
              $ {[g.gate!.command, ...(g.gate!.args ?? [])].join(" ")}
            </code>
          ))}
        </div>
      )}

      {args.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setArgsOpen((v) => !v)}
            className="text-muted-foreground/80 hover:text-foreground flex w-full cursor-pointer items-center gap-1.5 text-left text-[10px] font-medium tracking-wide transition-colors"
          >
            {argsOpen ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            <span className="shrink-0">参数(可选 {args.length} 个)</span>
            {!argsOpen && (
              <>
                <span className="text-muted-foreground/60 min-w-0 truncate font-mono font-normal">
                  {args.map((a) => a.name).join("、")}
                </span>
                <span className="text-muted-foreground/50 ml-auto shrink-0 font-normal">
                  留空由子代理自行判断 · 点开可锁定
                </span>
              </>
            )}
          </button>
          {argsOpen && (
            <>
              <div className="flex flex-col gap-1.5">
                {args.map((a) => (
                  <label key={a.name} className="flex items-center gap-2 text-[11px]">
                    <span
                      className="text-muted-foreground w-24 shrink-0 truncate font-mono text-[10.5px]"
                      title={a.description}
                    >
                      {a.name}
                    </span>
                    <Input
                      value={argValues[a.name] ?? ""}
                      onChange={(e) => setArg(a.name, e.target.value)}
                      placeholder={
                        a.default !== undefined
                          ? String(a.default)
                          : a.type === "number"
                            ? "数字"
                            : ""
                      }
                      className="h-7 flex-1 px-2 text-[11px]"
                    />
                  </label>
                ))}
              </div>
              {argGaps.length > 0 && (
                <div className="text-muted-foreground/70 text-[10px] leading-relaxed">
                  留空:{argGaps.join("、")}——不插值,步骤里显示为缺口标记(&lt;missing arg&gt;),
                  由子代理自行判断;想锁定就填上
                </div>
              )}
            </>
          )}
          {/* 硬缺口永远可见:折叠着也要能看见「为什么不能确认」 */}
          {argIssues.length > 0 && (
            <div className="text-red-600/90 dark:text-red-400/90 text-[10px]">
              {argIssues.join(" · ")}——这些值会插进步骤 prompt,确认前必须填对
            </div>
          )}
        </div>
      )}

      <p className="text-muted-foreground/70 text-[10.5px] leading-relaxed">
        无依赖的步骤并发跑;门按退出码判定,完成后自动交付报告。
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
        <Button size="sm" className="h-7 px-3" disabled={busy || argIssues.length > 0} onClick={submitConfirm}>
          {busy ? "启动中…" : "确认并开始"}
        </Button>
      </div>
    </div>
  );
};

/* ------------------------------ 运行进度卡(v3) ------------------------------ */

/**
 * 运行进度卡:同一张编排图随状态着色 + 头部的状态行与暂停/继续。
 * 终态(complete/failed)默认折叠成「执行凭据」一行——报告本体已作为消息回投会话。
 * 失败时在图下方给一条明确的失败条(失败于哪一步 + 原因),不再重复 statusLine。
 */
export const WorkflowRunCard: FC<{
  run: WorkflowSnapshot;
  busy: boolean;
  /** 该运行所在线程(抽屉的详情请求带它) */
  threadId?: string;
  onPause: () => void;
  onResume: () => void;
  /** 存为剧本(仅完成的运行显示);解析后按钮转「已存为剧本」 */
  onSave?: () => Promise<void>;
  /** 清除运行槽(终止态显示):常驻条不再为完成态保留一行,出口在这里 */
  onClear?: () => void;
}> = ({ run, threadId, busy, onPause, onResume, onSave, onClear }) => {
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const steps = run.steps ?? [];
  const { top, childrenByParent } = useMemo(() => splitStepStates(run.stepStates), [run.stepStates]);
  const live = run.status === "running" || run.status === "proposing";
  const terminal = run.status === "complete" || run.status === "failed";
  const [expanded, setExpanded] = useState(false);
  const collapsed = terminal && !expanded;
  const now = useNowTick(run.status === "running");
  const timedOutKeys = useMemo(() => timedOutKeysOf(steps, top, now), [steps, top, now]);
  const failedStep = (run.stepStates ?? []).find((s) => s.status === "failed");
  const failedTitle = failedStep ? steps.find((s) => s.key === failedStep.key)?.title : undefined;
  const openStepDef = steps.find((s) => s.key === openKey);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        {terminal && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground/60 hover:text-foreground shrink-0 cursor-pointer"
            title={expanded ? "收起执行凭据" : "展开编排图"}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.objective}>
          {run.title || run.objective}
        </span>
        {timedOutKeys.size > 0 && <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" />}
        <span
          className={cn(
            "shrink-0 text-[11px]",
            run.status === "running" || run.status === "proposing"
              ? "text-emerald-600 dark:text-emerald-400"
              : run.status === "complete"
                ? "text-muted-foreground"
                : run.status === "failed"
                  ? "text-red-600 dark:text-red-400"
                  : "text-amber-600 dark:text-amber-400",
          )}
        >
          {run.statusLine}
        </span>
        <span
          className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums"
          title="本次运行消耗的 token,含所有子代理"
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openWorkflowPanel(run.title || run.objective)}
          title="在右侧面板打开完整编排图(暂停/继续/清除也在那里)"
          className="size-6 shrink-0"
          aria-label="在面板中打开工作流"
        >
          <SquareArrowOutUpRightIcon className="size-3" />
        </Button>
        {onClear && terminal && !cleared && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setCleared(true);
              onClear();
            }}
            title="从工作流槽里清除这次运行(对话里的记录保留)"
            className="h-6 shrink-0 px-2 text-[11px]"
          >
            清除
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
            title="把这套剧本存进剧本库,以后可带参数重跑(自动化 / 工作流 页)"
            className="h-6 shrink-0 px-2 text-[11px]"
          >
            {saved ? "已存为剧本 ✓" : "存为剧本"}
          </Button>
        )}
      </div>

      {/* 瘦身行恢复(重启后全量 run 文件缺失):结果不可用要显式说,不许静默 */}
      {run.resultsUnavailable && (
        <p className="text-amber-600/90 dark:text-amber-400/90 text-[11px] leading-relaxed">
          历史步骤结果未能读回(进程重启后 run 文件缺失):相关步骤将重跑,不沿用旧产出。
        </p>
      )}

      {!collapsed && (
        <>
          {steps.length > 0 ? (
            <WorkflowGraph
              steps={steps}
              states={top}
              childrenByParent={childrenByParent}
              onOpen={(key) => {
                // 一个委派(delegate/synthesize)→ 直接开「子智能体」面板看**实时**输出
                // (思考/工具/文本,与 Task 委派同一条活动流);
                // 0 个(门)或 ≥2 个(复核:N 个评审各有独立过程)→ 开抽屉:
                // 门的命令与判定、复核的票决与逐评审入口都在那里,二选一不如都摆出来
                const st = top.get(key);
                const ids =
                  st?.delegationIds?.length
                    ? st.delegationIds
                    : st?.delegationId
                      ? [st.delegationId]
                      : [];
                if (ids.length === 1) {
                  openSubagentTab(ids[0]!, steps.find((s) => s.key === key)?.title ?? key);
                  return;
                }
                setOpenKey(openKey === key ? null : key);
              }}
              activeKey={openKey}
              timedOutKeys={timedOutKeys}
            />
          ) : (
            /* 编排中还没有剧本:骨架图占位(与真实图的尺度和节奏一致),
                而不是再写一遍「正在拟剧本」——标题行的 statusLine 已经说过 */
            <div className="flex items-center py-1.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="flex items-center">
                  {i > 0 && <span className="border-border/60 w-8 border-t border-dashed" />}
                  <span
                    className={cn(
                      "border-border/60 bg-muted/30 h-[58px] w-[164px] animate-pulse rounded-lg border border-dashed",
                      i === 1 && "[animation-delay:150ms]",
                      i === 2 && "[animation-delay:300ms]",
                    )}
                  />
                </span>
              ))}
            </div>
          )}
          {openStepDef && (
            <WorkflowStepDrawer
              threadId={threadId}
              step={openStepDef}
              state={top.get(openStepDef.key)}
              now={now}
              onClose={() => setOpenKey(null)}
            />
          )}
          {failedStep && run.status === "failed" && (
            <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] px-2.5 py-2 text-[11px] leading-relaxed">
              <span className="font-medium text-red-600 dark:text-red-400">
                失败于「{failedTitle ?? failedStep.key}」
              </span>
              {failedStep.error && (
                <span className="text-muted-foreground"> · {failedStep.error}</span>
              )}
            </div>
          )}
        </>
      )}
      {collapsed && steps.length > 0 && (
        <div className="text-muted-foreground/70 text-[11px]">
          {steps.length} 步执行凭据已收起(报告已回投会话;点箭头展开编排图)
        </div>
      )}
    </div>
  );
};
