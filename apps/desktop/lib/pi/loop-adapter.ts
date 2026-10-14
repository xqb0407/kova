import type { PiTraceRun, PiTraceSpan } from "@/lib/pi/pi-bridge";
import type {
  IterationStop,
  LoopIteration,
  LoopRun,
  LoopStep,
  OutcomeReason,
  StepStatus,
  TokenUsage,
} from "./loop-model";

/**
 * trace 记录（span 树）→ loop 视图模型（迭代结构）。
 *
 * 三件真正需要动脑的事：
 * 1. **子 run 还原成树**。sidecar 把子代理存成独立记录，靠 parentRunId /
 *    parentSpanId 两条边指回父 run 里那次 Task。v2 的身份模型（spanId 持久化）
 *    在这里兑现——没有它，子 run 就是一片孤儿，只能平铺。
 * 2. **intent 不新增采集字段**。llm span 的 detail.response 里就有模型这一轮写的
 *    原话，取首句即可，犯不上为它改契约。
 * 3. **atMs 全部转成相对 run 起点的偏移**。trace 存的是墙钟，视图要的是时间轴。
 */

const KIND_LABEL: Record<PiTraceSpan["kind"], string> = {
  turn: "轮次",
  llm_call: "LLM 调用",
  tool_call: "工具",
  retry: "重试",
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** 回复正文 → 本轮意图：取第一句（中英文句读都认），截 80 字 */
export function extractIntent(response: string | undefined): string | undefined {
  if (!response) return undefined;
  const text = response.trim();
  if (!text) return undefined;
  // detail.response 可能带 [assistant] 前缀之类的渲染痕迹，先剥掉行首标记
  const body = text.replace(/^\[[^\]]+\]\s*/, "");
  const m = body.match(/^[\s\S]{1,80}?[。！？.!?\n]/);
  const sentence = (m ? m[0] : body.slice(0, 80)).trim();
  return sentence || undefined;
}

function stepStatus(span: PiTraceSpan): StepStatus {
  if (span.kind === "retry") return "retry";
  return span.status === "error" ? "error" : "ok";
}

function usageOf(span: PiTraceSpan): TokenUsage | undefined {
  const a = span.attrs;
  if (!a) return undefined;
  const input = num(a.inputTokens);
  const output = num(a.outputTokens);
  if (input == null && output == null) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(a.cacheRead),
    cacheWrite: num(a.cacheWrite),
  };
}

/** args 在 trace 里是被 clip 过的 JSON 串；能解析就还原成对象，不能就原样给字符串 */
function parseArgs(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // 截断的 JSON 解析不了，退回原文——面板按字符串渲染，不假装是对象
    return raw;
  }
}

function toStep(span: PiTraceSpan, runStartMs: number, index: number): LoopStep {
  const id = span.spanId ?? `${runStartMs}:${index}`;
  const attrs = span.attrs ?? {};
  const startMs = span.startMs || runStartMs;
  return {
    id,
    kind: span.kind === "llm_call" ? "llm" : span.kind === "retry" ? "retry" : "tool",
    name:
      span.name ??
      str(attrs.model) ??
      (num(attrs.attempt) != null ? str(attrs.code) ?? "retry" : KIND_LABEL[span.kind]),
    atMs: Math.max(0, startMs - runStartMs),
    durationMs: span.endMs ? Math.max(0, span.endMs - startMs) : null,
    status: stepStatus(span),
    usage: usageOf(span),
    args: parseArgs(attrs.args),
    result: span.detail?.response,
    ...(span.status === "error"
      ? {
          error: {
            message: str(attrs.errorMessage) ?? span.detail?.response ?? "工具执行失败",
            exitCode: num(attrs.exitCode),
          },
        }
      : {}),
    ...(span.kind === "retry"
      ? {
          retry: {
            attempt: num(attrs.attempt) ?? 1,
            delayMs: num(attrs.delayMs) ?? 0,
            reason: str(attrs.message) ?? str(attrs.code) ?? "provider 重试",
          },
        }
      : {}),
  };
}

function toIteration(turn: PiTraceSpan, index: number, runStartMs: number): LoopIteration {
  const steps = (turn.children ?? []).map((c, i) => toStep(c, runStartMs, i));
  const llm = [...steps].reverse().find((s) => s.kind === "llm");
  const tools = steps.filter((s) => s.kind === "tool");
  const stoppedBecause: IterationStop =
    turn.status === "aborted"
      ? "aborted"
      : tools.length > 0
        ? "tool-call"
        : "final-answer";
  const failed = tools.filter((s) => s.status === "error").length;
  return {
    index,
    intent: extractIntent(llm?.result),
    steps,
    stoppedBecause,
    feedBack:
      tools.length > 0
        ? `${tools.length} 个工具结果已回喂${failed ? `，${failed} 个失败` : ""}`
        : undefined,
  };
}

function outcomeOf(rec: PiTraceRun): LoopRun["outcome"] {
  const reason = str(rec.outcome?.reason) as OutcomeReason | undefined;
  // 记录没带 outcome（旧 JSONL）时按 status 兜底翻译；aborted 是用户停止不是错误
  if (!reason) {
    return {
      reason:
        rec.status === "aborted" ? "user-stop" : rec.status === "error" ? "error" : "completed",
    };
  }
  return { reason, detail: str(rec.outcome?.detail) };
}

function toLoopRun(rec: PiTraceRun): LoopRun {
  const turns = rec.spans.filter((s) => s.kind === "turn");
  // partial 有两种：在飞（无 outcome，durationMs=null → 视图按"运行中"渲染）
  // 与中断残留（有 outcome.reason=interrupted，时长已定格）
  const inFlight = rec.partial === true && !rec.outcome;
  return {
    traceId: rec.traceId ?? rec.runId,
    source: rec.source,
    model: rec.model ?? "未知模型",
    startMs: rec.startMs,
    durationMs: inFlight
      ? null
      : rec.endMs
        ? Math.max(0, rec.endMs - rec.startMs)
        : null,
    iterations: turns.map((t, i) => toIteration(t, i + 1, rec.startMs)),
    outcome: inFlight ? undefined : outcomeOf(rec),
    usage: rec.usage ? { ...rec.usage } : undefined,
  };
}

/**
 * 扁平 trace 记录 → 迭代视图模型（子 run 还原成树）。
 *
 * 输入是 trace_query 的返回（按时间正序）。父不在结果集里的记录当根处理——
 * limit 截断只可能砍掉更早的父 run，不能因此把子 run 变没。
 */
export function toLoopRuns(records: PiTraceRun[]): LoopRun[] {
  const runs = records.map(toLoopRun);
  const byTraceId = new Map(runs.map((r) => [r.traceId, r]));
  // 记录顺序不等于树顺序：先按 parentSpanId 挂到父 run 的对应 Task 步骤之后
  const roots: LoopRun[] = [];
  records.forEach((rec, i) => {
    const run = runs[i]!;
    const parentTrace = str(rec.parentRunId);
    const parent = parentTrace ? byTraceId.get(parentTrace) : undefined;
    if (parent && parent !== run) {
      (parent.children ??= []).push(run);
    } else {
      roots.push(run);
    }
  });
  // 子代理按发生时刻排序，父 Task 步骤下的阅读顺序才和实际委派一致
  const sortKids = (r: LoopRun) => {
    r.children?.sort((a, b) => a.startMs - b.startMs).forEach(sortKids);
  };
  roots.forEach(sortKids);
  return roots;
}
