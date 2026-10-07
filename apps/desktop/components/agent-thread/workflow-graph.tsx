"use client";

import { useId, useMemo, type FC } from "react";
import { cn } from "@/lib/utils";
import {
  layoutWorkflowGraph,
  phaseStyle,
  type GraphNode,
} from "@/lib/pi/workflow-graph";
import type { WorkflowStepState, WorkflowStepView } from "@/lib/pi/pi-workflow";

/**
 * 工作流编排图(提案卡与运行卡共用):节点 = 步骤,连线 = dependsOn——
 * 「先跑谁、谁和谁能并行、结果汇到哪」一眼可见,替代原先的阶段分组列表。
 *
 * 节点按状态着色(待跑灰 / 运行中翠绿脉冲 / 完成淡绿 / 失败红 / 中断琥珀),
 * 左侧色条按 phase 区分并配图例;gate 节点的命令行在节点内逐字展示(截断,
 * 全文与参数在抽屉里)。点节点 → 调用方在下方的抽屉里展开详情。
 */

const STATUS_NODE: Record<WorkflowStepState["status"], string> = {
  pending: "border-border/60",
  // running 要跳出来:实心描边 + 柔光圈(与 done 的淡绿描边+浅底明显区分)
  running: "border-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15",
  // 底色一律**不透明**(50/950 档而不是 0.0x 的透明度):半透明底会让 SVG 连线
  // 从节点身上透出来(实机反馈「线段不要穿透」),也会让被压在下层的节点露边
  done: "border-emerald-700/25 bg-emerald-50 dark:bg-emerald-950",
  failed: "border-red-500/70 bg-red-50 dark:bg-red-950",
  skipped: "border-amber-500/50 bg-amber-50 dark:bg-amber-950",
  interrupted: "border-amber-500/70 bg-amber-50 dark:bg-amber-950",
};

const STATUS_DOT: Record<WorkflowStepState["status"], string> = {
  pending: "bg-muted-foreground/30",
  running: "animate-pulse bg-emerald-500",
  // 完成态收敛为淡绿:亮绿+脉冲从此专指「在跑」,不再两义
  done: "bg-emerald-900/25 dark:bg-emerald-200/30",
  failed: "bg-red-500",
  skipped: "bg-amber-500/80",
  interrupted: "bg-amber-500",
};

const STATUS_LABEL: Record<WorkflowStepState["status"], string> = {
  pending: "待跑",
  running: "运行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
  interrupted: "已中断",
};

const CHILD_DOT: Record<WorkflowStepState["status"], string> = {
  pending: "bg-muted-foreground/40",
  running: "animate-pulse bg-emerald-500",
  done: "bg-emerald-500/70",
  failed: "bg-red-500/80",
  skipped: "bg-amber-500/70",
  interrupted: "bg-amber-500/70",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 步骤类型徽标:delegate 是轻量小方块(多数),其余三种给文字徽标(语义重要) */
const KindBadge: FC<{ kind: string }> = ({ kind }) => {
  if (kind === "gate") {
    return (
      <span className="shrink-0 rounded border border-sky-500/40 px-1 text-[9px] leading-4 text-sky-700 dark:text-sky-300">
        门
      </span>
    );
  }
  if (kind === "verify") {
    return (
      <span className="shrink-0 rounded border border-violet-500/40 px-1 text-[9px] leading-4 text-violet-700 dark:text-violet-300">
        复核
      </span>
    );
  }
  if (kind === "synthesize") {
    return (
      <span className="shrink-0 rounded border border-foreground/25 px-1 text-[9px] leading-4 text-foreground/70">
        汇总
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/50 shrink-0 text-[10px] leading-none" aria-hidden>
      ▸
    </span>
  );
};

const NodeCard: FC<{
  node: GraphNode;
  state?: WorkflowStepState;
  subItems: WorkflowStepState[];
  phases: readonly string[];
  active: boolean;
  timedOut: boolean;
  clickable: boolean;
  /** 无依赖的门:会排在第一波执行——实机里正是它把整轮跑死在空产出上 */
  warnNoDeps: boolean;
  onOpen?: (key: string) => void;
}> = ({ node, state, subItems, phases, active, timedOut, clickable, warnNoDeps, onOpen }) => {
  const { step } = node;
  const status = state?.status;
  const body = (
    <>
      <span className="flex items-center gap-1.5 pr-2">
        <KindBadge kind={node.kind} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] leading-tight font-medium">
          {step.title}
        </span>
      </span>
      {/* 状态灯放右上角(绝对定位):不占标题宽度,长标题不再被挤到截断;
          待跑是默认态不画灯——一排灰点看着像排字错误 */}
      {status && status !== "pending" && (
        <span
          className={cn("absolute top-1.5 right-1.5 size-1.5 rounded-full", STATUS_DOT[status])}
          title={
            status === "interrupted"
              ? `${STATUS_LABEL[status]}——该步上次被中断,继续运行时会从起点重跑`
              : STATUS_LABEL[status]
          }
        />
      )}
      <span className="flex items-center gap-1.5 text-[10px] leading-none text-muted-foreground/70">
        {step.agent && (
          <span className="min-w-0 truncate text-blue-500/90 dark:text-blue-400/90">
            @{step.agent}
          </span>
        )}
        {step.verify && <span className="shrink-0">{step.verify.reviewers ?? 2} 位评审</span>}
        {status === "running" && (
          <span className="shrink-0 text-emerald-600 dark:text-emerald-400">运行中</span>
        )}
        {status === "failed" && (
          <span className="shrink-0 text-red-600 dark:text-red-400">失败</span>
        )}
        {status === "interrupted" && (
          <span className="shrink-0 text-amber-600 dark:text-amber-400">已中断</span>
        )}
        {status === "skipped" && (
          <span className="text-muted-foreground/70 shrink-0">跳过</span>
        )}
        {status === "done" && <span className="text-emerald-600/70 shrink-0">完成</span>}
        {warnNoDeps && (
          <span
            className="shrink-0 rounded border border-amber-500/40 px-1 text-[9px] leading-4 text-amber-700 dark:text-amber-300"
            title="这门没有任何依赖,会最先执行——若它检查的是其它步骤的产出,应把那些步骤加进 dependsOn(可在提案卡上驳回并说明)"
          >
            最先执行
          </span>
        )}
        {state?.tokens !== undefined && state.tokens > 0 && (
          <span className="shrink-0 tabular-nums">{formatTokens(state.tokens)}</span>
        )}
        {timedOut && (
          <span
            className="shrink-0 text-amber-600 dark:text-amber-400"
            title={`已运行超过超时上限(${step.timeoutMs ? Math.round(step.timeoutMs / 60_000) : 20} 分钟),执行器仍在等待`}
          >
            ?
          </span>
        )}
        {subItems.length > 0 && (
          <span className="flex shrink-0 items-center gap-[3px]" title={`扇出 ${subItems.length} 项`}>
            {subItems.slice(0, 6).map((c) => (
              <span key={c.key} className={cn("size-1 rounded-full", CHILD_DOT[c.status])} />
            ))}
            {subItems.length > 6 && <span className="text-[9px]">+{subItems.length - 6}</span>}
          </span>
        )}
      </span>
      {step.gate && (
        <code className="bg-background/70 text-foreground/75 mt-0.5 block truncate rounded px-1.5 py-0.5 font-mono text-[10px] leading-none">
          $ {[step.gate.command, ...(step.gate.args ?? [])].join(" ")}
        </code>
      )}
    </>
  );
  const className = cn(
    "absolute flex flex-col justify-center gap-1 overflow-hidden rounded-lg border border-l-2 bg-card px-3 py-2 text-left shadow-xs transition-colors",
    phaseStyle(node.phase, phases).accent,
    status ? STATUS_NODE[status] : "border-border/60",
    clickable && "cursor-pointer hover:border-foreground/30",
    active && "ring-1 ring-foreground/25",
  );
  const style = { left: node.x, top: node.y, width: node.w, height: node.h };
  // 「点了会开什么」要可发现:有委派的步骤开的是实时输出面板,其余是详情抽屉
  const delegationCount = state?.delegationIds?.length ?? (state?.delegationId ? 1 : 0);
  const hint =
    delegationCount === 1
      ? "查看实时输出(子智能体面板)"
      : delegationCount > 1
        ? "查看票决与各评审过程"
        : "查看步骤详情";
  if (!clickable) {
    return (
      <div className={className} style={style}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen?.(node.key)}
      className={className}
      style={style}
      title={hint}
    >
      {body}
    </button>
  );
};

export const WorkflowGraph: FC<{
  steps: WorkflowStepView[];
  /** 顶层步骤状态(key 对齐;foreach 子项在 childrenByParent 里) */
  states: Map<string, WorkflowStepState>;
  childrenByParent: Map<string, WorkflowStepState[]>;
  /** 点节点(不传则纯展示) */
  onOpen?: (key: string) => void;
  activeKey?: string | null;
  timedOutKeys?: ReadonlySet<string>;
}> = ({ steps, states, childrenByParent, onOpen, activeKey, timedOutKeys }) => {
  const layout = useMemo(() => layoutWorkflowGraph(steps), [steps]);
  // SVG marker 的 id 必须每个实例唯一:同一线程历史里同剧本可能渲染多张卡
  const rawId = useId();
  const arrowId = `wfg-${rawId.replace(/[^A-Za-z0-9_-]/g, "")}`;

  if (layout.nodes.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {layout.phases.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {layout.phases.map((p) => (
            <span key={p} className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground/80">
              <span
                className={cn("inline-block size-2 rounded-[3px]", phaseStyle(p, layout.phases).swatch)}
              />
              {p}
            </span>
          ))}
        </div>
      )}
      <div className="overflow-x-auto pb-1">
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground/40" />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const dx = Math.max(20, Math.round((e.toX - e.fromX) / 2));
              const fromState = states.get(e.from);
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={`M ${e.fromX} ${e.fromY} C ${e.fromX + dx} ${e.fromY}, ${e.toX - dx} ${e.toY}, ${e.toX} ${e.toY}`}
                  fill="none"
                  strokeWidth={1.5}
                  className={cn(
                    fromState?.status === "done"
                      ? "stroke-emerald-600/40"
                      : fromState?.status === "running"
                        ? // 流动虚线:静态图里唯一的动效,一眼看出「有东西正经过这条边」
                          "[stroke-dasharray:6_5] stroke-emerald-500/70 animate-wf-edge-flow"
                        : fromState?.status === "failed"
                          ? "stroke-red-500/30"
                          : "stroke-muted-foreground/30",
                  )}
                  markerEnd={`url(#${arrowId})`}
                />
              );
            })}
          </svg>
          {layout.nodes.map((n) => (
            <NodeCard
              key={n.key}
              node={n}
              state={states.get(n.key)}
              subItems={childrenByParent.get(n.key) ?? []}
              phases={layout.phases}
              active={activeKey === n.key}
              timedOut={timedOutKeys?.has(n.key) ?? false}
              clickable={!!onOpen}
              warnNoDeps={
                steps.length > 1 && n.kind === "gate" && n.step.dependsOn.length === 0
              }
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
