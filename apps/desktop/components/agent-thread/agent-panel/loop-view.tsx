"use client";

/**
 * Agent loop 视图：运行列表（run rail）、迭代脊（核心）、检查器三块。
 *
 * 核心是 IterationSpine——它按 loop 的真实结构分层：一次迭代 = 模型意图 →
 * N 个工具 → 结果回喂。与链路追踪面板（span 瀑布，按 llm/tool/retry 类型看耗时）
 * 是两种切法，分界线是迭代边界与回喂边。
 *
 * 数据来源与视图解耦：真实数据经 lib/pi/loop-adapter 从 traces JSONL 映射而来，
 * 这里只吃 loop-model 的形状。LoopExplorer 是自带选中/筛选状态的三栏外壳，
 * 面板 tab 与 dev-preview 页共用同一份实现。
 */

import { useCallback, useMemo, useState, type FC } from "react";
import {
  ArrowDownIcon,
  BotIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  CpuIcon,
  Loader2Icon,
  RepeatIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  NO_FILTER,
  OUTCOME_META,
  contextAfter,
  countFailures,
  countIterations,
  countRetries,
  iterationUsage,
  runDuration,
  runUsage,
  stepMatches,
  summarize,
  toolNames,
  type LoopIteration,
  type LoopRun,
  type LoopStep,
  type StepFilter,
} from "@/lib/pi/loop-model";

export const fmtMs = (ms: number): string =>
  ms >= 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(2)}s`
      : `${Math.round(ms)}ms`;

/** token 紧凑写法：12.3k / 1.2M */
export const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const fmtClock = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/* ============================== 迭代脊 ============================== */

/** 步骤图标：按 kind 区分 llm / 工具 / 重试 */
const kindIcon: Record<LoopStep["kind"], FC<{ className?: string }>> = {
  llm: CpuIcon,
  tool: TerminalIcon,
  retry: RepeatIcon,
};

/**
 * 单个步骤行：图标 + 名称 + 时间轴条 + 耗时 + 状态。
 * 失败行整行染红（左边框 + 淡红底），重试行染琥珀——整页里失败路径要第一眼能捞到。
 */
const StepRow: FC<{
  step: LoopStep;
  totalMs: number;
  running: boolean;
  selected: boolean;
  onSelect: () => void;
}> = ({ step, totalMs, running, selected, onSelect }) => {
  const open = running && step.durationMs == null;
  const Icon = kindIcon[step.kind];
  const failed = step.status === "error";
  const retried = step.kind === "retry";

  // 时间轴：起点按 atMs 定位，宽度按已进行时长占全程的比例
  const left = Math.min(100, (step.atMs / totalMs) * 100);
  const width =
    step.durationMs != null
      ? Math.max(0.6, (step.durationMs / totalMs) * 100)
      : open
        ? 100 - left
        : 100 - left;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        "group hover:bg-muted/60 flex w-full items-center gap-2 rounded px-1.5 py-[3px] text-left text-[12px] leading-[1.35] transition-colors",
        selected && "bg-muted",
        failed && "bg-red-500/8",
        retried && "bg-amber-500/8",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded",
          failed
            ? "text-red-500"
            : retried
              ? "text-amber-500"
              : open
                ? "text-amber-500"
                : "text-muted-foreground",
        )}
      >
        {open ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <Icon className="size-3" />
        )}
      </span>

      <span
        className={cn(
          "w-32 shrink-0 truncate font-medium",
          failed ? "text-red-500" : open ? "text-amber-500" : "text-foreground",
        )}
      >
        {step.name}
      </span>

      {/* 时间轴条：在飞时用脉冲动画表示持续生长 */}
      <span className="bg-muted/60 relative h-1.5 min-w-8 flex-1 overflow-hidden rounded">
        <span
          className={cn(
            "absolute inset-y-0 rounded",
            failed
              ? "bg-red-500/60"
              : retried
                ? "bg-amber-500/60"
                : step.kind === "llm"
                  ? "bg-violet-500/50"
                  : "bg-primary/50",
          )}
          style={{
            left: `${left}%`,
            width: `${width}%`,
          }}
        />
        {open ? (
          <span className="absolute inset-y-0 animate-pulse rounded bg-amber-500/45" style={{ left: `${left}%`, width: `${width}%` }} />
        ) : null}
      </span>

      {/* token 列：只 llm step 有（工具不耗 token）。input = 该次请求带入的
          上下文总量，逐轮累积——扫一眼就知道循环贵在哪一轮 */}
      <span
        className="text-muted-foreground/80 w-14 shrink-0 text-right text-[10px] tabular-nums"
        title={step.usage ? `入 ${step.usage.input} · 出 ${step.usage.output}` : undefined}
      >
        {step.usage ? `↑${fmtTok(step.usage.input)}` : ""}
      </span>

      <span className="text-muted-foreground w-12 shrink-0 text-right text-[10px] tabular-nums">
        {open ? "…" : step.durationMs != null ? fmtMs(step.durationMs) : ""}
      </span>

      <span className="flex w-8 shrink-0 justify-end">
        {open ? (
          <Loader2Icon className="size-3 animate-spin text-amber-500" />
        ) : failed ? (
          <CircleXIcon className="size-3 text-red-500" />
        ) : retried ? (
          <RepeatIcon className="size-3 text-amber-500" />
        ) : step.kind === "llm" ? null : (
          <CircleCheckIcon className="size-3 text-emerald-500/70" />
        )}
      </span>
    </button>
  );
};

/**
 * 一条迭代带：头（序号 / 模型意图 / 本轮耗时）+ 身（步骤行）。
 * 意图是这一层最值钱的东西——它回答「模型这一轮想干什么」，瀑布图里没有。
 */
const IterationBand: FC<{
  iteration: LoopIteration;
  totalMs: number;
  running: boolean;
  selectedId: string | null;
  filter: StepFilter;
  onSelect: (stepId: string) => void;
}> = ({ iteration, totalMs, running, selectedId, filter, onSelect }) => {
  const steps = iteration.steps.filter((s) => stepMatches(s, filter));
  if (steps.length === 0) return null;
  // 本轮从第一个可见 step 开始到最后一个可见 step 结束
  const first = steps[0];
  const last = steps[steps.length - 1];
  const endAt = last.atMs + (last.durationMs ?? 1_200);
  const span = endAt - first.atMs;
  const hasError = steps.some((s) => s.status === "error");
  // 本轮 llm 的上下文规模与输出量：逐轮累积，是「循环为什么越跑越贵」的读数
  const ctx = contextAfter(iteration);
  const usage = iterationUsage(iteration);

  return (
    <div
      className={cn(
        "rounded-md border",
        hasError ? "border-red-500/25 bg-red-500/[0.03]" : "border-border/60",
      )}
    >
      {/* 带头：序号 + 意图 + 本轮 token + 耗时 */}
      <div className="flex items-baseline gap-2 border-b px-2.5 py-1.5">
        <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
          迭代 {iteration.index}
        </span>
        <span className="text-foreground min-w-0 flex-1 truncate text-[12px] leading-[1.35]">
          {iteration.intent ?? "（模型未给出说明）"}
        </span>
        {ctx != null ? (
          <span
            className="text-muted-foreground shrink-0 text-[10px] tabular-nums"
            title={`本轮结束时上下文 ${ctx} tok`}
          >
            上下文 {fmtTok(ctx)}
            {usage ? ` · 出 ${fmtTok(usage.output)}` : ""}
          </span>
        ) : null}
        <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
          {fmtMs(span)}
        </span>
      </div>

      {/* 带身：步骤行（已按筛选过滤） */}
      <div className="flex flex-col gap-px p-1">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            totalMs={totalMs}
            running={running}
            selected={selectedId === step.id}
            onSelect={() => onSelect(step.id)}
          />
        ))}
      </div>
    </div>
  );
};

/** 回喂边：迭代之间那条「工具结果喂回模型」的连接线 */
const FeedBackEdge: FC<{ label: string | undefined }> = ({ label }) => (
  <div className="flex items-center gap-2 py-0.5 pl-4">
    <span className="text-muted-foreground/50 flex flex-col items-center">
      <span className="bg-border h-2 w-px" />
      <ArrowDownIcon className="size-3 -translate-y-1" />
    </span>
    <span className="text-muted-foreground/70 min-w-0 truncate text-[10px]">
      {label ? `结果回喂 · ${label}` : "结果回喂"}
    </span>
  </div>
);

/** 子代理 run：缩进 + 左竖线，表示嵌套在父 run 的某次委派里 */
const NestedRun: FC<{
  run: LoopRun;
  running: boolean;
  selectedId: string | null;
  filter: StepFilter;
  onSelect: (stepId: string) => void;
}> = ({ run, running, selectedId, filter, onSelect }) => {
  const total = runDuration(run, running) ?? 1;
  return (
    <div className="border-primary/40 ml-3 border-l-2 pl-2.5">
      <div className="text-muted-foreground flex items-center gap-1.5 py-1 text-[10px]">
        <BotIcon className="text-primary size-3" />
        <span className="text-foreground font-medium">子代理</span>
        <span>{run.model}</span>
        <span className="tabular-nums">{fmtMs(runDuration(run, running) ?? 0)}</span>
        <span className="text-primary/70">· Task 委派产生</span>
      </div>
      <RunSpine
        run={run}
        running={running}
        selectedId={selectedId}
        filter={filter}
        onSelect={onSelect}
      />
    </div>
  );
};

/** 一个 run 的完整循环主体：迭代带序列 + 回喂边 + 嵌套子 run */
export const RunSpine: FC<{
  run: LoopRun;
  running: boolean;
  selectedId: string | null;
  filter: StepFilter;
  onSelect: (stepId: string) => void;
}> = ({ run, running, selectedId, filter, onSelect }) => {
  const total = runDuration(run, running) ?? 1;
  const meta = run.outcome ? OUTCOME_META[run.outcome.reason] : null;
  // 整轮都不命中筛选时不占位，回喂边跟着一起消失（否则会连到空带）
  const visible = run.iterations.filter((it) => it.steps.some((s) => stepMatches(s, filter)));

  return (
    <div className="flex flex-col gap-1">
      {visible.map((iteration, i) => (
        <div key={iteration.index} className="flex flex-col gap-1">
          <IterationBand
            iteration={iteration}
            totalMs={total}
            running={running}
            selectedId={selectedId}
            filter={filter}
            onSelect={onSelect}
          />
          {/* 迭代之间的回喂边 */}
          {i < visible.length - 1 ? <FeedBackEdge label={iteration.feedBack} /> : null}
          {/* 委派产生的子 run 挂在本轮末尾 */}
          {i === run.iterations.findIndex((it) => it.steps.some((s) => s.name === "Task")) ? (
            (run.children ?? []).map((child) => (
              <NestedRun
                key={child.traceId}
                run={child}
                running={running}
                selectedId={selectedId}
                filter={filter}
                onSelect={onSelect}
              />
            ))
          ) : null}
        </div>
      ))}

      {/* 终止原因：现有 trace 完全没有这个维度 */}
      {run.outcome ? (
        <div
          className={cn(
            "mt-1 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] leading-[1.35]",
            meta?.tone === "ok" && "border-emerald-500/25 bg-emerald-500/[0.05]",
            meta?.tone === "warn" && "border-amber-500/25 bg-amber-500/[0.05]",
            meta?.tone === "error" && "border-red-500/25 bg-red-500/[0.05]",
          )}
        >
          <span className="text-muted-foreground shrink-0 text-[10px]">终止</span>
          <span
            className={cn(
              "shrink-0 font-medium",
              meta?.tone === "ok" && "text-emerald-600 dark:text-emerald-400",
              meta?.tone === "warn" && "text-amber-600 dark:text-amber-400",
              meta?.tone === "error" && "text-red-600 dark:text-red-400",
            )}
          >
            {meta?.label}
          </span>
          {run.outcome.detail ? (
            <span className="text-muted-foreground min-w-0 truncate">
              {run.outcome.detail}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/* ============================== 运行列表 ============================== */

const sourceLabel: Record<LoopRun["source"], string> = {
  ui: "会话",
  automation: "定时任务",
  subagent: "子代理",
};

export const RunRail: FC<{
  runs: LoopRun[];
  selectedTraceId: string | null;
  liveTraceId: string | null;
  onSelect: (traceId: string) => void;
}> = ({ runs, selectedTraceId, liveTraceId, onSelect }) => {
  const activeLive = liveTraceId
    ? runs.find((r) => r.traceId === liveTraceId)
    : null;
  const total = summarize(runs);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* run 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => {
          const isLive = run.traceId === liveTraceId;
          const dur = runDuration(run, isLive);
          const meta = run.outcome ? OUTCOME_META[run.outcome.reason] : null;
          return (
            <button
              key={run.traceId}
              type="button"
              onClick={() => onSelect(run.traceId)}
              data-active={selectedTraceId === run.traceId}
              className="hover:bg-muted/60 data-active:bg-muted flex w-full flex-col gap-1 border-b px-2.5 py-2 text-left transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    isLive
                      ? "animate-pulse bg-amber-500"
                      : meta?.tone === "ok"
                        ? "bg-emerald-500"
                        : meta?.tone === "warn"
                          ? "bg-amber-500"
                          : "bg-red-500",
                  )}
                />
                <span className="text-foreground text-[12px] font-medium tabular-nums">
                  {fmtClock(run.startMs)}
                </span>
                {isLive ? (
                  <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    进行中
                  </span>
                ) : null}
                <span className="text-muted-foreground ml-auto shrink-0 text-[10px] tabular-nums">
                  {dur != null ? fmtMs(dur) : ""}
                </span>
              </span>
              <span className="text-muted-foreground flex items-center gap-1.5 pl-3 text-[11px]">
                <span className="min-w-0 truncate">{run.model}</span>
                <span className="shrink-0">· {countIterations(run)} 迭代</span>
                {countFailures(run) > 0 ? (
                  <span className="shrink-0 text-red-500">{countFailures(run)} 失败</span>
                ) : null}
              </span>
              <span className="text-muted-foreground/70 flex items-center gap-1.5 pl-3 text-[10px]">
                <span>{sourceLabel[run.source]}</span>
                {(() => {
                  const u = runUsage(run);
                  return (
                    <span className="tabular-nums">
                      · ↑{fmtTok(u.input)} ↓{fmtTok(u.output)}
                    </span>
                  );
                })()}
              </span>
            </button>
          );
        })}
      </div>

      {/* 会话汇总：跨 run 的模式，单个 run 的瀑布看不出来 */}
      <div className="border-t px-2.5 py-2">
        <div className="text-muted-foreground mb-1.5 text-[10px]">会话汇总</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
          <Stat label="运行" value={runs.length} />
          <Stat label="迭代" value={total.iterations} />
          <Stat label="失败" value={total.failures} tone={total.failures > 0 ? "error" : undefined} />
          <Stat label="重试" value={total.retries} tone={total.retries > 0 ? "warn" : undefined} />
        </div>
        <div className="text-muted-foreground mt-1.5 flex items-center gap-2 border-t pt-1.5 text-[10px]">
          <span className="tabular-nums">
            ↑ {total.input.toLocaleString()}
          </span>
          <span className="tabular-nums">↓ {total.output.toLocaleString()}</span>
          <span
            className="text-emerald-600 dark:text-emerald-400 ml-auto tabular-nums"
            title="缓存命中：不重复计费的输入部分"
          >
            缓存 {fmtTok(total.cacheRead)}
          </span>
        </div>
      </div>
    </div>
  );
};

const Stat: FC<{ label: string; value: number; tone?: "error" | "warn" }> = ({
  label,
  value,
  tone,
}) => (
  <span className="flex items-baseline gap-1">
    <span className="text-muted-foreground">{label}</span>
    <span
      className={cn(
        "font-medium tabular-nums",
        tone === "error" && "text-red-500",
        tone === "warn" && "text-amber-500",
      )}
    >
      {value}
    </span>
  </span>
);

/* ============================== 筛选器 ============================== */

/**
 * 筛选条：大会话 118 节点靠滚是找不到东西的，「只看失败」是最常用的一刀，
 * 再叠一层工具名收窄。全在客户端，不回后端。
 */
export const FilterBar: FC<{
  filter: StepFilter;
  tools: string[];
  matched: number;
  total: number;
  onChange: (f: StepFilter) => void;
}> = ({ filter, tools, matched, total, onChange }) => {
  const toggleTool = (name: string) => {
    const has = filter.tools.includes(name);
    onChange({
      ...filter,
      tools: has ? filter.tools.filter((t) => t !== name) : [...filter.tools, name],
    });
  };
  const active = filter.onlyProblems || filter.tools.length > 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => onChange({ ...filter, onlyProblems: !filter.onlyProblems })}
        data-active={filter.onlyProblems}
        className={cn(
          "rounded border px-1.5 py-0.5 text-[11px]",
          filter.onlyProblems
            ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
            : "hover:bg-muted/60",
        )}
      >
        只看失败
      </button>

      <span className="text-muted-foreground mx-0.5 h-3.5 w-px bg-border" />

      {tools.map((name) => {
        const on = filter.tools.includes(name);
        return (
          <button
            key={name}
            type="button"
            onClick={() => toggleTool(name)}
            data-active={on}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[11px]",
              on
                ? "border-primary/50 bg-primary/10 text-primary"
                : "hover:bg-muted/60 text-muted-foreground",
            )}
          >
            {name}
          </button>
        );
      })}

      <span className="text-muted-foreground ml-auto text-[10px] tabular-nums">
        {matched}/{total} 步
      </span>
      {active ? (
        <button
          type="button"
          onClick={() => onChange({ onlyProblems: false, tools: [] })}
          className="hover:bg-muted/60 text-muted-foreground rounded px-1.5 py-0.5 text-[11px]"
        >
          清除
        </button>
      ) : null}
    </div>
  );
};

/* ============================== 检查器 ============================== */

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-2">
    <div className="text-muted-foreground mb-0.5 text-[10px] font-medium">{label}</div>
    {children}
  </div>
);

const CodeBlock: FC<{ children: React.ReactNode; tone?: "error" }> = ({ children, tone }) => (
  <pre
    className={cn(
      "max-h-56 overflow-auto rounded p-2 font-mono text-[11px] leading-[1.45] break-all whitespace-pre-wrap",
      tone === "error" ? "bg-red-500/8 text-red-600 dark:text-red-400" : "bg-muted/40",
    )}
  >
    {children}
  </pre>
);

/**
 * 检查器：选中步骤的入参 / 出参 / 报错 / 重试详情。
 * 没有选中时给引导，而不是空白。
 */
export const StepInspector: FC<{
  step: LoopStep | null;
  iteration: LoopIteration | null;
  run: LoopRun;
}> = ({ step, iteration, run }) => {
  if (!step || !iteration) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-[12px] leading-[1.5]">
        点左侧任意一步
        <br />
        看它的入参、出参与失败原因
      </div>
    );
  }

  const Icon = kindIcon[step.kind];
  const open = step.durationMs == null;
  const failed = step.status === "error";

  return (
    <div className="h-full overflow-y-auto px-3 py-2.5">
      {/* 标题行 */}
      <div className="mb-2.5 flex items-center gap-2">
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground min-w-0 truncate font-medium">{step.name}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-[10px] tabular-nums">
          迭代 {iteration.index}/{run.iterations.length}
        </span>
      </div>

      {/* 状态条 */}
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-muted-foreground flex items-center gap-1">
          <ClockIcon className="size-3" />
          {open ? "进行中" : step.durationMs != null ? fmtMs(step.durationMs) : "—"}
        </span>
        <span
          className={cn(
            "flex items-center gap-1",
            failed ? "text-red-500" : open ? "text-amber-500" : "text-emerald-500",
          )}
        >
          {failed ? (
            <CircleXIcon className="size-3" />
          ) : open ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <CircleCheckIcon className="size-3" />
          )}
          {failed
            ? `失败${step.error?.exitCode != null ? ` · exit ${step.error.exitCode}` : ""}`
            : open
              ? "运行中"
              : "成功"}
        </span>
      </div>

      {/* 这一轮的意图：模型自己写的 */}
      {iteration.intent ? (
        <Field label="本轮意图（模型原话）">
          <div className="bg-muted/40 rounded p-2 text-[12px] leading-[1.5]">
            {iteration.intent}
          </div>
        </Field>
      ) : null}

      {/* token 明细：input 就是这次请求带入的上下文总量 */}
      {step.usage ? (
        <Field label="token 用量">
          <div className="bg-muted/40 space-y-1 rounded p-2 text-[11px] leading-[1.5]">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">输入（上下文）</span>
              <span className="tabular-nums">{step.usage.input.toLocaleString()}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">输出</span>
              <span className="tabular-nums">{step.usage.output.toLocaleString()}</span>
            </div>
            {step.usage.cacheRead ? (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 shrink-0">缓存命中</span>
                <span className="text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {step.usage.cacheRead.toLocaleString()}
                </span>
              </div>
            ) : null}
            {step.usage.cacheWrite ? (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-20 shrink-0">缓存写入</span>
                <span className="tabular-nums">{step.usage.cacheWrite.toLocaleString()}</span>
              </div>
            ) : null}
          </div>
        </Field>
      ) : null}

      {step.args != null ? (
        <Field label="入参">
          <CodeBlock>{JSON.stringify(step.args, null, 2)}</CodeBlock>
        </Field>
      ) : null}

      {step.result ? (
        <Field label="出参">
          <CodeBlock>{step.result}</CodeBlock>
        </Field>
      ) : null}

      {step.error ? (
        <Field label={`错误${step.error.exitCode != null ? ` · exit ${step.error.exitCode}` : ""}`}>
          <CodeBlock tone="error">
            {step.error.message}
            {step.error.stderr ? `\n\n${step.error.stderr}` : ""}
          </CodeBlock>
        </Field>
      ) : null}

      {step.retry ? (
        <Field label="重试详情">
          <div className="bg-amber-500/8 space-y-1 rounded p-2 text-[11px] leading-[1.5]">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">第几次</span>
              <span className="tabular-nums">第 {step.retry.attempt} 次</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">退避</span>
              <span className="tabular-nums">{fmtMs(step.retry.delayMs)}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-16 shrink-0">原因</span>
              <span className="min-w-0 break-words">{step.retry.reason}</span>
            </div>
          </div>
        </Field>
      ) : null}

      {/* 这一轮喂回模型的内容：回喂边上的实质 */}
      {iteration.feedBack ? (
        <Field label="回喂给模型">
          <CodeBlock>{iteration.feedBack}</CodeBlock>
        </Field>
      ) : null}
    </div>
  );
};
/* ============================ 三栏外壳 ============================ */

/** 展平一个 run（含子代理）的全部步骤，供选中态反查 */
function indexSteps(run: LoopRun) {
  const map = new Map<string, { step: LoopStep; iteration: LoopIteration }>();
  const walk = (r: LoopRun) => {
    for (const iteration of r.iterations) {
      for (const step of iteration.steps) map.set(step.id, { step, iteration });
    }
    for (const child of r.children ?? []) walk(child);
  };
  walk(run);
  return map;
}

/**
 * 三栏外壳：左 run 列表 / 中迭代脊 / 右检查器，自带选中与筛选状态。
 *
 * 面板 tab 与 dev-preview 页共用它，差异全在 toolbar / empty 两个插槽里——
 * 页面放数据源切换，tab 不需要。这样两处不会各长一份布局逻辑。
 */
export const LoopExplorer: FC<{
  runs: LoopRun[];
  /** 顶部工具条右侧的自定义控件（页面放数据源切换等） */
  toolbar?: React.ReactNode;
  /** 无 run 时的提示内容 */
  empty?: React.ReactNode;
  /** 把该 traceId 的 run 按在飞态渲染（录制数据源专用；真实数据由 durationMs 自然表达） */
  simulateLiveTraceId?: string | null;
}> = ({ runs, toolbar, empty, simulateLiveTraceId = null }) => {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StepFilter>(NO_FILTER);

  const selectedRun = useMemo(
    () => runs.find((r) => r.traceId === selectedTraceId) ?? runs[0] ?? null,
    [runs, selectedTraceId],
  );
  const running = !!selectedRun && selectedRun.traceId === simulateLiveTraceId;

  // 选中步：数据源/run 变化后旧 id 可能悬空，用有效值兜底
  const stepIndex = useMemo(
    () => (selectedRun ? indexSteps(selectedRun) : new Map()),
    [selectedRun],
  );
  const effectiveStepId =
    selectedStepId && stepIndex.has(selectedStepId)
      ? selectedStepId
      : (selectedRun?.iterations[0]?.steps[0]?.id ?? null);
  const inspected = effectiveStepId ? stepIndex.get(effectiveStepId) : undefined;

  const tools = useMemo(() => (selectedRun ? toolNames(selectedRun) : []), [selectedRun]);
  const counts = useMemo(() => {
    const all = stepIndex.size;
    let hit = 0;
    for (const { step } of stepIndex.values()) if (stepMatches(step, filter)) hit++;
    return { all, hit };
  }, [stepIndex, filter]);

  const onSelectRun = useCallback((traceId: string) => {
    setSelectedTraceId(traceId);
    setSelectedStepId(null);
    setFilter(NO_FILTER);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
          {toolbar}
          <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">
            {runs.length} 条运行
          </span>
        </div>
      ) : null}

      {!selectedRun ? (
        <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[12px] leading-relaxed">
          {empty}
        </div>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel id="loop-run-rail" defaultSize={220} minSize={160} className="min-w-0">
            <RunRail
              runs={runs}
              selectedTraceId={selectedRun.traceId}
              liveTraceId={simulateLiveTraceId}
              onSelect={onSelectRun}
            />
          </ResizablePanel>

          <ResizableHandle className="[&>div]:opacity-100" />

          <ResizablePanel id="loop-spine" minSize={320} className="min-w-0">
            <div className="flex h-full min-h-0 flex-col">
              {/* run 概要 */}
              <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-[11px]">
                <span className="text-foreground font-medium">{selectedRun.model}</span>
                <span className="tabular-nums">{fmtClock(selectedRun.startMs)}</span>
                <span className="tabular-nums">{selectedRun.iterations.length} 次迭代</span>
                {(() => {
                  const u = runUsage(selectedRun);
                  return (
                    <>
                      <span className="tabular-nums" title="输入（上下文）/ 输出">
                        ↑ {u.input.toLocaleString()} / ↓ {u.output.toLocaleString()}
                      </span>
                      {u.cacheRead ? (
                        <span
                          className="tabular-nums text-emerald-600 dark:text-emerald-400"
                          title="缓存命中的输入部分，不重复计费"
                        >
                          缓存命中 {u.cacheRead.toLocaleString()}
                        </span>
                      ) : null}
                    </>
                  );
                })()}
                {running ? (
                  <span className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
                    <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                    运行中
                  </span>
                ) : null}
              </div>

              <FilterBar
                filter={filter}
                tools={tools}
                matched={counts.hit}
                total={counts.all}
                onChange={setFilter}
              />

              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                <RunSpine
                  run={selectedRun}
                  running={running}
                  selectedId={effectiveStepId}
                  filter={filter}
                  onSelect={setSelectedStepId}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle className="[&>div]:opacity-100" />

          <ResizablePanel id="loop-inspector" defaultSize={300} minSize={220} className="min-w-0">
            <StepInspector
              step={inspected?.step ?? null}
              iteration={inspected?.iteration ?? null}
              run={selectedRun}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
};
