/**
 * Agent loop 可视化的领域模型：视图吃的形状，与采集形状（PiTraceRun / sidecar
 * TraceRunRecord）解耦。
 *
 * 为什么不直接把 trace 形状丢给组件：trace 是 span 树（按类型分层看耗时），
 * 这一层是迭代结构（意图 → 工具 → 结果回喂）。两者关注点不同，中间放一层映射，
 * 上游改采集形状只动 loop-adapter.ts，不动视图。
 *
 * 与既有「链路追踪」面板的分工：那边是 span 瀑布，这边是迭代视图。
 */

export type StepStatus = "ok" | "error" | "retry";

/** 单次调用的用量。llm step 带；工具 step 不带。
 *  input = 这次请求带进去的上下文总量（逐轮累积，是 loop 成本的主驱动） */
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type LoopStep = {
  id: string;
  kind: "llm" | "tool" | "retry";
  /** 工具名 / retry 错误码 / 模型名 */
  name: string;
  /** 相对 run 起点的毫秒偏移 */
  atMs: number;
  /** null = 尚未结束（实时生长） */
  durationMs: number | null;
  status: StepStatus;
  usage?: TokenUsage;
  args?: unknown;
  result?: string;
  error?: { message: string; exitCode?: number; stderr?: string };
  retry?: { attempt: number; delayMs: number; reason: string };
};

/** 为什么循环在这一轮停：调工具（loop 继续）还是给最终答案（loop 结束） */
export type IterationStop = "tool-call" | "final-answer" | "aborted";

export type LoopIteration = {
  index: number;
  /** 模型这一轮自己写的计划/说明（取回复首句）—— loop 的「意图」层 */
  intent?: string;
  steps: LoopStep[];
  /** 喂给下一次迭代的工具结果摘要 */
  feedBack?: string;
  stoppedBecause: IterationStop;
};

/** 为什么整个 run 停了。与 sidecar TraceOutcomeReason 同集合 */
export type OutcomeReason =
  | "completed"
  | "user-stop"
  | "context-overflow"
  | "length-budget-exhausted"
  | "error"
  /** 进程中断：从增量落盘抢救回来的不完整 run */
  | "interrupted";

export type LoopRun = {
  traceId: string;
  source: "ui" | "automation" | "subagent";
  model: string;
  startMs: number;
  /** null = 还在跑 */
  durationMs: number | null;
  iterations: LoopIteration[];
  outcome?: { reason: OutcomeReason; detail?: string };
  usage?: TokenUsage;
  /** 子代理嵌套：由 parentRunId/parentSpanId 因果边还原出来的子 run */
  children?: LoopRun[];
};

/* ------------------------------- 派生读数 ------------------------------- */

export function runDuration(run: LoopRun, running: boolean): number | null {
  if (run.durationMs != null) return run.durationMs;
  if (!running) return null;
  // 在飞：取已录制到的最后时刻
  let max = 0;
  const walk = (r: LoopRun) => {
    for (const it of r.iterations)
      for (const s of it.steps) max = Math.max(max, s.atMs + (s.durationMs ?? 1_200));
    for (const c of r.children ?? []) walk(c);
  };
  walk(run);
  return max;
}

export function iterationUsage(iteration: LoopIteration): TokenUsage | null {
  const llms = iteration.steps.filter((s) => s.usage);
  if (llms.length === 0) return null;
  return llms.reduce<TokenUsage>(
    (acc, s) => ({
      input: acc.input + (s.usage?.input ?? 0),
      output: acc.output + (s.usage?.output ?? 0),
      cacheRead: (acc.cacheRead ?? 0) + (s.usage?.cacheRead ?? 0),
      cacheWrite: (acc.cacheWrite ?? 0) + (s.usage?.cacheWrite ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/** 本轮结束时的上下文规模：最后一次 llm 的 input。逐轮累积，是「循环为什么越跑越贵」的读数 */
export function contextAfter(iteration: LoopIteration): number | null {
  for (let i = iteration.steps.length - 1; i >= 0; i--) {
    const s = iteration.steps[i];
    if (s.usage) return s.usage.input;
  }
  return null;
}

export function countIterations(run: LoopRun): number {
  return (
    run.iterations.length + (run.children ?? []).reduce((n, c) => n + countIterations(c), 0)
  );
}

export function countFailures(run: LoopRun): number {
  const own = run.iterations
    .flatMap((it) => it.steps)
    .filter((s) => s.status === "error").length;
  return own + (run.children ?? []).reduce((n, c) => n + countFailures(c), 0);
}

export function countRetries(run: LoopRun): number {
  const own = run.iterations.flatMap((it) => it.steps).filter((s) => s.kind === "retry").length;
  return own + (run.children ?? []).reduce((n, c) => n + countRetries(c), 0);
}

/** run 的 token 合计（含子代理递归） */
export function runUsage(run: LoopRun): TokenUsage {
  const acc: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const add = (u: TokenUsage | null | undefined) => {
    if (!u) return;
    acc.input += u.input;
    acc.output += u.output;
    acc.cacheRead = (acc.cacheRead ?? 0) + (u.cacheRead ?? 0);
    acc.cacheWrite = (acc.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
  };
  add(run.usage);
  for (const child of run.children ?? []) add(runUsage(child));
  return acc;
}

/** 会话汇总：跨 run 的模式 */
export function summarize(runs: LoopRun[]) {
  const acc = { runs: 0, iterations: 0, failures: 0, retries: 0, input: 0, output: 0, cacheRead: 0 };
  for (const run of runs) {
    acc.runs += 1;
    acc.iterations += countIterations(run);
    acc.failures += countFailures(run);
    acc.retries += countRetries(run);
    const u = runUsage(run);
    acc.input += u.input;
    acc.output += u.output;
    acc.cacheRead += u.cacheRead ?? 0;
  }
  return acc;
}

/* --------------------------------- 筛选 --------------------------------- */

export type StepFilter = {
  /** 只看失败 / 重试 / 在飞 */
  onlyProblems: boolean;
  /** 限定工具名；空数组 = 不限 */
  tools: string[];
};

export const NO_FILTER: StepFilter = { onlyProblems: false, tools: [] };

export function stepMatches(step: LoopStep, f: StepFilter): boolean {
  if (f.tools.length > 0 && (step.kind !== "tool" || !f.tools.includes(step.name))) return false;
  if (f.onlyProblems) {
    return step.status === "error" || step.kind === "retry" || step.durationMs == null;
  }
  return true;
}

/** 该 run（含子代理）出现过的全部工具名，供筛选器列选项 */
export function toolNames(run: LoopRun): string[] {
  const set = new Set<string>();
  const walk = (r: LoopRun) => {
    for (const it of r.iterations)
      for (const s of it.steps) if (s.kind === "tool") set.add(s.name);
    for (const c of r.children ?? []) walk(c);
  };
  walk(run);
  return [...set].sort();
}

/* ------------------------------ 展示元数据 ------------------------------ */

export const OUTCOME_META: Record<
  OutcomeReason,
  { label: string; tone: "ok" | "warn" | "error" }
> = {
  completed: { label: "自然收尾", tone: "ok" },
  "user-stop": { label: "用户停止", tone: "warn" },
  "context-overflow": { label: "上下文溢出", tone: "error" },
  "length-budget-exhausted": { label: "长度续跑预算耗尽", tone: "error" },
  error: { label: "异常终止", tone: "error" },
  interrupted: { label: "意外中断", tone: "warn" },
};