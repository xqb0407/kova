import type { PiTraceRun, PiTraceSpan, PiTraceStatus } from "@/lib/pi/pi-bridge";

/**
 * 链路追踪（瀑布视图）的领域模型：PiTraceRun 记录 → 可渲染的 span 树。
 *
 * 与 loop-model 的分工：loop-model 把 trace 折叠成「迭代」结构（意图 → 工具 →
 * 回喂），这里保留 span 的原始树形与时间轴——瀑布图按开始/结束时点定位条形，
 * 回放按时间裁切可见性，两者都需要未被折叠的时序。
 *
 * 子代理记录在 sidecar 里是独立 run（parentRunId / parentSpanId 两条边指回父
 * run 的那次 Task）。这里把它们挂回父 span 之下，父 run 的 token/span 统计
 * 同步递归累加，面板看到的才是一条完整调用链。
 */

export type TraceCategory = "agent" | "llm" | "tool" | "retry";

export type TraceSpanStatus = PiTraceStatus | "running";

export type TraceUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type TraceSpanNode = {
  /** 稳定身份（spanId 优先；旧记录用 traceId:序号派生），选中/折叠都用它 */
  id: string;
  kind: "run" | PiTraceSpan["kind"];
  category: TraceCategory;
  name: string;
  /** 绝对时间（与 PiTraceRun.startMs 同一时钟） */
  startMs: number;
  /** null = 未收口（在飞 run 的尾部） */
  endMs: number | null;
  status: TraceSpanStatus;
  attrs: Record<string, string | number | boolean>;
  detail?: { request?: string; response?: string };
  usage?: TraceUsage;
  /** 该节点是某个子 run 的根时，指向子 run 的 traceId */
  childRunTraceId?: string;
  children: TraceSpanNode[];
};

export type TraceViewRun = {
  traceId: string;
  runId: string;
  sessionId: string;
  source: PiTraceRun["source"];
  agentName?: string;
  model?: string;
  /** 本次 run 触发的用户输入（首个 LLM 请求上下文里最后一个 [user] 段）。
   *  运行记录列表用它区分「同一个会话里第几次发送」；旧记录/请求上下文被
   *  内存预算摘掉时缺失，消费方回落到模型名/代理名 */
  prompt?: string;
  startMs: number;
  /** 已解析的结束时刻：在飞 run 取最后观察到的 span 末点 */
  endMs: number;
  durationMs: number;
  running: boolean;
  status: TraceSpanStatus;
  outcome?: { reason: string; detail?: string };
  /** 递归含子代理 run */
  usage: TraceUsage;
  spanCount: number;
  root: TraceSpanNode;
};

export type TraceRow = { span: TraceSpanNode; depth: number };

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const statusOf = (status: PiTraceStatus): TraceSpanStatus =>
  status === "error" ? "error" : status === "aborted" ? "aborted" : "ok";

const categoryOf = (kind: PiTraceSpan["kind"]): TraceCategory =>
  kind === "llm_call" ? "llm" : kind === "tool_call" ? "tool" : kind === "retry" ? "retry" : "agent";

function usageOfAttrs(attrs: Record<string, unknown> | undefined): TraceUsage | undefined {
  if (!attrs) return undefined;
  const input = num(attrs.inputTokens);
  const output = num(attrs.outputTokens);
  if (input == null && output == null) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(attrs.cacheRead) ?? 0,
    cacheWrite: num(attrs.cacheWrite) ?? 0,
  };
}

/** 短模型名：provider/model → model（行宽有限，provider 对读时序没帮助） */
const shortModel = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const i = raw.lastIndexOf("/");
  return i >= 0 && i < raw.length - 1 ? raw.slice(i + 1) : raw;
};

function spanName(span: PiTraceSpan, fallbackTurnIndex: number): string {
  if (span.kind === "turn") {
    return `第 ${num(span.attrs?.index) ?? fallbackTurnIndex} 轮`;
  }
  if (span.kind === "llm_call") {
    return shortModel(str(span.attrs?.model)) ?? "LLM 调用";
  }
  return span.name ?? (span.kind === "retry" ? "重试" : "工具");
}

/** 运行记录标题的单行上限：超出截断并标省略号（列表里只用来看「哪次发送」） */
const PROMPT_LABEL_MAX = 80;

/**
 * 请求上下文（sidecar trace.ts 的 renderRequest 渲染）→ 本次 run 的用户输入。
 * 取最后一个 `[user]` 段的首行：上下文里的历史 user 消息都排在前面，最后
 * 一段才是触发这次请求的那条（steer/续跑注入的文本也走 user 段，照常展示）。
 * 按空行切段再匹配，避免把工具结果/代码块正文里的 "[user] " 误认成段首。
 * 旧记录没有 detail.request 或请求正文被内存预算摘掉时返回 undefined。
 */
export function traceUserPrompt(request: string): string | undefined {
  // 渲染正文超长时 sidecar 从头截断，最新的 user 段恰好被砍掉；此时解析出的
  // 「最后一个 [user]」是条古老消息，宁可不给标题也不能让多条 run 重名
  if (request.includes("…[请求上下文已截断]")) return undefined;
  const segments = request.split("\n\n");
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (!seg.startsWith("[user] ")) continue;
    const firstLine = seg.slice("[user] ".length).split("\n", 1)[0]?.trim();
    if (!firstLine) return undefined;
    return firstLine.length > PROMPT_LABEL_MAX
      ? `${firstLine.slice(0, PROMPT_LABEL_MAX)}…`
      : firstLine;
  }
  return undefined;
}

/** 先序找第一个带用户输入信息的 llm_call：新记录用 attrs.prompt（sidecar
 *  在首个 llm_call 上写入的原始用户输入），旧记录回落到解析请求上下文 */
function promptFromSpans(spans: readonly PiTraceSpan[]): string | undefined {
  for (const span of spans) {
    if (span.kind === "llm_call") {
      const attr = str(span.attrs?.prompt);
      if (attr) return attr;
      const request = span.detail?.request;
      const prompt = request ? traceUserPrompt(request) : undefined;
      if (prompt) return prompt;
    }
    const nested = promptFromSpans(span.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}

function buildSpan(
  span: PiTraceSpan,
  traceId: string,
  running: boolean,
  seq: { n: number },
  fallbackTurnIndex = 0,
): TraceSpanNode {
  const id = span.spanId ?? `${traceId}:${seq.n++}`;
  const endMs = span.endMs > 0 ? span.endMs : null;
  return {
    id,
    kind: span.kind,
    category: categoryOf(span.kind),
    name: spanName(span, fallbackTurnIndex),
    startMs: span.startMs,
    endMs,
    status: endMs == null ? (running ? "running" : "aborted") : statusOf(span.status),
    attrs: span.attrs ?? {},
    detail: span.detail,
    usage: usageOfAttrs(span.attrs),
    children: (span.children ?? []).map((child, i) =>
      buildSpan(child, traceId, running, seq, child.kind === "turn" ? i + 1 : 0),
    ),
  };
}

/** 汇总 span 树里的 token（run 记录缺 usage 时的兜底；在飞记录只有轮行）。
 *  与 recorder 口径一致：error/aborted 的 LLM 调用不计入。 */
function usageFromSpans(span: TraceSpanNode, acc: TraceUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }): TraceUsage {
  if (span.usage && span.status !== "error" && span.status !== "aborted") {
    acc.input += span.usage.input;
    acc.output += span.usage.output;
    acc.cacheRead += span.usage.cacheRead;
    acc.cacheWrite += span.usage.cacheWrite;
  }
  for (const child of span.children) usageFromSpans(child, acc);
  return acc;
}

/** 从 span 树里取最后一个带 model 的 LLM 调用；live/旧记录没有 run.model 时兜底 */
function modelFromSpans(span: TraceSpanNode): string | undefined {
  let model: string | undefined;
  const walk = (node: TraceSpanNode) => {
    if (node.kind === "llm_call") {
      const m = node.attrs.model;
      if (typeof m === "string" && m) model = m;
    }
    for (const child of node.children) walk(child);
  };
  walk(span);
  return model;
}

function maxEnd(span: TraceSpanNode): number {
  let end = span.endMs ?? span.startMs;
  for (const child of span.children) end = Math.max(end, maxEnd(child));
  return end;
}

function findSpan(root: TraceSpanNode, spanId: string | undefined): TraceSpanNode | null {
  if (!spanId) return null;
  if (root.id === spanId) return root;
  for (const child of root.children) {
    const hit = findSpan(child, spanId);
    if (hit) return hit;
  }
  return null;
}

function countSpans(root: TraceSpanNode): number {
  return 1 + root.children.reduce((n, child) => n + countSpans(child), 0);
}

function addUsage(target: TraceUsage, extra: TraceUsage): void {
  target.input += extra.input;
  target.output += extra.output;
  target.cacheRead += extra.cacheRead;
  target.cacheWrite += extra.cacheWrite;
}

/**
 * 扁平 trace 记录 → 瀑布视图 run 列表（子 run 挂回父 span）。
 *
 * 返回按开始时间倒序（最新在前），与面板的运行下拉/列表顺序一致。父记录不在
 * 结果集里时子 run 当根处理——limit 截断只可能砍掉更早的父，不能因此丢记录。
 */
export function toTraceViewRuns(records: PiTraceRun[]): TraceViewRun[] {
  // 同一 traceId 多行时以后到的为准（live 覆盖历史）
  const byTraceId = new Map<string, PiTraceRun>();
  for (const rec of records) byTraceId.set(rec.traceId ?? rec.runId, rec);

  const recordsById = new Map<string, PiTraceRun>();
  for (const rec of byTraceId.values()) recordsById.set(rec.traceId ?? rec.runId, rec);

  const childrenOf = new Map<string, PiTraceRun[]>();
  const roots: PiTraceRun[] = [];
  for (const rec of recordsById.values()) {
    const id = rec.traceId ?? rec.runId;
    const parent = rec.parentRunId ? recordsById.get(rec.parentRunId) : undefined;
    if (parent && parent !== rec) {
      const list = childrenOf.get(rec.parentRunId!);
      if (list) list.push(rec);
      else childrenOf.set(rec.parentRunId!, [rec]);
    } else {
      roots.push(rec);
    }
  }

  const building = new Set<string>();
  const build = (rec: PiTraceRun): TraceViewRun => {
    const traceId = rec.traceId ?? rec.runId;
    // 父子边成环（坏记录）时退化成根，避免无限递归
    if (building.has(traceId)) throw new Error(`trace cycle at ${traceId}`);
    building.add(traceId);
    try {
      const running = rec.partial === true && !rec.outcome;
      const seq = { n: 0 };
      const turns = rec.spans.map((span, i) =>
        buildSpan(span, traceId, running, seq, span.kind === "turn" ? i + 1 : 0),
      );
      const root: TraceSpanNode = {
        id: `run:${traceId}`,
        kind: "run",
        category: "agent",
        name: `${rec.agent ?? "agent"}.run`,
        startMs: rec.startMs,
        endMs: rec.endMs > 0 ? rec.endMs : null,
        status: running ? "running" : statusOf(rec.status),
        attrs: {
          runId: rec.runId,
          sessionId: rec.sessionId,
          source: rec.source,
          ...(rec.outcome?.reason ? { outcome: rec.outcome.reason } : {}),
          ...(rec.outcome?.detail ? { outcomeDetail: rec.outcome.detail } : {}),
          ...(rec.partial ? { partial: true } : {}),
        },
        children: turns,
      };

      // live 头写在 model 已知之前；记录缺 model/usage 时从已闭合的 LLM span 补
      const model = rec.model ?? modelFromSpans(root);
      if (model) root.attrs = { ...root.attrs, model };
      // 本次发送的用户输入：运行记录列表的标题（不同 run 的区分依据）
      const prompt = promptFromSpans(rec.spans);
      const ownUsage = rec.usage ? { ...rec.usage } : usageFromSpans(root);
      root.usage = ownUsage;
      const usage = { ...ownUsage };
      let endMs = root.endMs ?? maxEnd(root);
      const kids = (childrenOf.get(traceId) ?? []).sort((a, b) => a.startMs - b.startMs);
      for (const child of kids) {
        let childRun: TraceViewRun;
        try {
          childRun = build(child);
        } catch {
          // 环/坏记录：跳过这条子 run，父 run 照常出
          continue;
        }
        const attached = findSpan(root, child.parentSpanId);
        const node: TraceSpanNode = {
          ...childRun.root,
          // 子 run 根行显示委派目标名，而不是又一个 agent.run
          name: child.agent ?? childRun.agentName ?? "子代理",
          childRunTraceId: childRun.traceId,
        };
        (attached ?? root).children.push(node);
        endMs = Math.max(endMs, childRun.endMs);
        addUsage(usage, childRun.usage);
      }
      if (root.endMs == null) root.endMs = endMs;

      return {
        traceId,
        runId: rec.runId,
        sessionId: rec.sessionId,
        source: rec.source,
        ...(rec.agent ? { agentName: rec.agent } : {}),
        ...(model ? { model } : {}),
        ...(prompt ? { prompt } : {}),
        startMs: rec.startMs,
        endMs,
        durationMs: Math.max(0, endMs - rec.startMs),
        running,
        status: root.status,
        outcome: rec.outcome,
        usage,
        spanCount: countSpans(root),
        root,
      };
    } finally {
      building.delete(traceId);
    }
  };

  const out: TraceViewRun[] = [];
  for (const rec of roots) {
    try {
      out.push(build(rec));
    } catch {
      // 单个坏记录不影响整张列表
    }
  }
  return out.sort((a, b) => b.startMs - a.startMs);
}

/** 按折叠集合展平 span 树（父行仍在，子行跳过） */
export function flattenTraceSpans(
  root: TraceSpanNode,
  collapsed: ReadonlySet<string>,
): TraceRow[] {
  const out: TraceRow[] = [];
  const walk = (span: TraceSpanNode, depth: number) => {
    out.push({ span, depth });
    if (collapsed.has(span.id)) return;
    for (const child of span.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** 默认折叠：子代理内部（根行保留）——瀑布里它们通常占比最大，先收起来 */
export function defaultCollapsed(root: TraceSpanNode): Set<string> {
  const out = new Set<string>();
  const walk = (span: TraceSpanNode) => {
    if (span.childRunTraceId) out.add(span.id);
    for (const child of span.children) walk(child);
  };
  walk(root);
  return out;
}

/* ------------------------------ 时间轴与读数 ------------------------------ */

/** 1/2/5 × 10^n 的刻度步长：让 9.18s 落在 0/2/4/6/8s 这种读得懂的刻度上 */
export function traceTimeTicks(durationMs: number, target = 5): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [0];
  const ideal = durationMs / target;
  const pow = 10 ** Math.floor(Math.log10(ideal));
  const n = ideal / pow;
  // 亚毫秒刻度没有意义：截断 run（刚起步时 duration 可能只有几毫秒）至少按 1ms 走
  const step = Math.max(1, Math.round((n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow));
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs + step * 1e-6; t += step) ticks.push(Math.round(t));
  return ticks;
}

export function formatTraceTick(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(2).replace(/0+$/, "")}s`;
  }
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${s}s` : `${m}m`;
}

export function formatTraceDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
  return formatTraceTick(ms);
}

export function formatTraceTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const traceUsageTotal = (u: TraceUsage): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite;

export function formatTraceClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 运行时间标签：今天 / 昨天 / 更早（跨年带年份） */
export function formatTraceDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const clock = formatTraceClock(ms);
  if (sameDay(d, today)) return `今天 ${clock}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${clock}`;
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** 失败/重试计数：状态徽章与「已完成但有重试」的告警色都用它。
 *  失败只记最具体的那层——子 run 根与被包含的失败 span 同时 error 时只算一次。 */
export function traceRunFlags(root: TraceSpanNode): { failures: number; retries: number } {
  const walk = (span: TraceSpanNode): { failures: number; retries: number } => {
    let failures = 0;
    let retries = span.kind === "retry" ? 1 : 0;
    for (const child of span.children) {
      const sub = walk(child);
      failures += sub.failures;
      retries += sub.retries;
    }
    if (span.status === "error" && failures === 0) failures = 1;
    return { failures, retries };
  };
  return walk(root);
}

/** 失败/重试等读数的手写兜底：旧记录没有 outcome 时按 status 翻译 */
export function traceStatusLabel(run: TraceViewRun): {
  label: string;
  tone: "ok" | "warn" | "error" | "live";
} {
  if (run.running) return { label: "运行中", tone: "live" };
  const reason = run.outcome?.reason;
  if (reason === "interrupted") return { label: "中断（记录不完整）", tone: "error" };
  if (reason === "context-overflow") return { label: "上下文溢出", tone: "error" };
  if (reason === "length-budget-exhausted") return { label: "长度预算耗尽", tone: "warn" };
  if (reason === "user-stop") return { label: "用户停止", tone: "warn" };
  if (run.status === "error") return { label: "失败", tone: "error" };
  if (run.status === "aborted") return { label: "已中止", tone: "warn" };
  return { label: "已完成", tone: "ok" };
}
