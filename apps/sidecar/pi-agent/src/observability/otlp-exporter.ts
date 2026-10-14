/**
 * 最小 OTLP/HTTP(JSON) 导出器：把 trace.ts 的 run 记录推送到外部 OTLP 后端
 * （Langfuse 走其 OTel 端点 /api/public/otel/v1/traces，任意 OTLP/HTTP 后端通用）。
 * 不引 OpenTelemetry SDK / protobuf 运行时——手写 ExportTraceServiceRequest JSON。
 *
 * 通道纪律（与 trace.ts 一致）：exportTraceRun 只做内存入队（同步、零 IO），
 * 后台定时 flush（5s 或满 20 个 run 提前）；任何失败静默丢弃 + 节流日志，
 * 绝不反压 agent 主流程。进程退出时在途批次直接丢弃（观测数据不值得为它
 * 加收尾复杂度——traces 本地文件才是事实源）。
 *
 * 属性映射（OTel GenAI 语义约定，Langfuse 据此把 llm_call 显示为 generation）：
 *   llm_call  → gen_ai.system / gen_ai.request.model / gen_ai.usage.* /
 *               gen_ai.response.finish_reasons
 *   tool_call → gen_ai.tool.name + 参数（redactContent=false 才带）
 *   retry     → attempt / delayMs / code
 */
import { createHash } from "node:crypto";
import { getObservabilityConfig } from "./observability";
import type { TraceRunRecord, TraceSpan } from "../protocol/trace";
import { logErr } from "../log";

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 20;
const LOG_THROTTLE_MS = 60_000;
/** OTLP span status code：1 = OK，2 = ERROR */
const STATUS_OK = 1;
const STATUS_ERROR = 2;
/** OTLP span kind：1 = INTERNAL，3 = CLIENT */
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;

type OtlpAttr = { key: string; value: Record<string, string | number | boolean> };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttr[];
  status: { code: number; message?: string };
};

const toNs = (ms: number): string => (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();

const hex = (input: string, len: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, len);

const attr = (key: string, value: string | number | boolean): OtlpAttr => ({
  key,
  value:
    typeof value === "number"
      ? { doubleValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: value },
});

/** 拆 "provider/model"（无斜杠时 whole 当 model） */
const splitModel = (model: string): { provider?: string; model: string } => {
  const at = model.indexOf("/");
  return at > 0
    ? { provider: model.slice(0, at), model: model.slice(at + 1) }
    : { model };
};

type FlatSpan = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: TraceSpan["kind"];
  startMs: number;
  endMs: number;
  status: TraceSpan["status"];
  attrs: Record<string, string | number | boolean>;
  detail?: TraceSpan["detail"];
};

/** TraceSpan 树 → 扁平 span 列表。id 直接用持久化的 spanId（面板与 OTLP 同源），
 *  树靠 parentSpanId 表达。run 根是合成 span，spanId 取 traceId 前 16hex
 *  （面板侧同约定，两侧可用同一套 id 对齐）。v2 之前的旧记录缺 spanId，
 *  回退到按遍历序派生的 16hex（仅本次导出内部一致，不落盘）。 */
function flattenSpans(record: TraceRunRecord): FlatSpan[] {
  const traceId = record.traceId ?? record.runId;
  const rootSpanId = traceId.slice(0, 16);
  const out: FlatSpan[] = [];
  const root: FlatSpan = {
    spanId: rootSpanId,
    parentSpanId: null,
    name: record.model ?? "agent run",
    kind: "turn",
    startMs: record.startMs,
    endMs: record.endMs,
    status: record.status,
    attrs: {
      "pi.session_id": record.sessionId,
      "pi.source": record.source,
      ...(record.model ? { "gen_ai.request.model": record.model } : {}),
      ...(record.usage
        ? {
            "gen_ai.usage.input_tokens": record.usage.input,
            "gen_ai.usage.output_tokens": record.usage.output,
            "gen_ai.usage.cache_read.input_tokens": record.usage.cacheRead,
            "gen_ai.usage.cache_creation.input_tokens": record.usage.cacheWrite,
          }
        : {}),
    },
  };
  out.push(root);
  let fallbackSeq = 0;
  const walk = (span: TraceSpan, parentSpanId: string): void => {
    const spanId = span.spanId ?? hex(`${record.runId}:${fallbackSeq++}`, 16);
    out.push({
      spanId,
      parentSpanId,
      name: span.name ?? span.kind,
      kind: span.kind,
      startMs: span.startMs,
      endMs: span.endMs,
      status: span.status,
      attrs: span.attrs ?? {},
      ...(span.detail ? { detail: span.detail } : {}),
    });
    for (const child of span.children ?? []) walk(child, spanId);
  };
  for (const turn of record.spans) walk(turn, rootSpanId);
  return out;
}

function spanToOtlp(span: FlatSpan, redactContent: boolean, traceId: string): OtlpSpan {
  const attrs: OtlpAttr[] = [];
  const pushText = (key: string, value: unknown): void => {
    if (typeof value === "string" && value) attrs.push(attr(key, value));
    else if (typeof value === "number" && Number.isFinite(value)) attrs.push(attr(key, value));
  };

  if (span.parentSpanId === null) {
    // run 根：记账属性整包透传（pi.session_id / pi.source / run 级 gen_ai.usage.*）
    for (const [key, value] of Object.entries(span.attrs)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        attrs.push(attr(key, value));
    }
  } else if (span.kind === "llm_call") {
    // model 形如 "provider/model"（trace.ts 记账时拼接）
    const model = String(span.attrs.model ?? "");
    const { provider, model: modelId } = splitModel(model);
    if (provider) attrs.push(attr("gen_ai.system", provider));
    if (modelId) attrs.push(attr("gen_ai.request.model", modelId));
    for (const key of ["inputTokens", "outputTokens", "cacheRead", "cacheWrite"]) {
      const v = span.attrs[key];
      if (typeof v === "number") {
        const genAiKey =
          key === "inputTokens"
            ? "gen_ai.usage.input_tokens"
            : key === "outputTokens"
              ? "gen_ai.usage.output_tokens"
              : key === "cacheRead"
                ? "gen_ai.usage.cache_read.input_tokens"
                : "gen_ai.usage.cache_creation.input_tokens";
        attrs.push(attr(genAiKey, v));
      }
    }
    pushText("gen_ai.response.finish_reasons", String(span.attrs.stopReason ?? ""));
    if (typeof span.attrs.errorMessage === "string")
      attrs.push(attr("error.type", span.attrs.errorMessage));
    // 关闭脱敏时随行请求/回复正文（OpenInference 惯例键，Langfuse 映射为
    // generation 的输入/输出展示）；redactContent=true（默认）不带
    if (!redactContent && span.detail?.request)
      attrs.push(attr("input.value", span.detail.request));
    if (!redactContent && span.detail?.response)
      attrs.push(attr("output.value", span.detail.response));
  } else if (span.kind === "tool_call") {
    attrs.push(attr("gen_ai.tool.name", span.name ?? "tool"));
    // redactContent=true（默认）不上传工具入参正文，只传元数据
    if (!redactContent && typeof span.attrs.args === "string" && span.attrs.args)
      attrs.push(attr("gen_ai.tool.call.arguments", span.attrs.args));
  } else if (span.kind === "retry") {
    for (const key of ["attempt", "delayMs"] as const) {
      const v = span.attrs[key];
      if (typeof v === "number") attrs.push(attr(`pi.retry.${key}`, v));
    }
    pushText("pi.retry.code", span.name);
    pushText("error.type", span.attrs.message);
  } else if (span.kind === "turn") {
    const index = span.attrs.index;
    if (typeof index === "number") attrs.push(attr("pi.turn.index", index));
  }

  const failed = span.status === "error" || span.status === "aborted";
  const name =
    // LLM 调用的 OTLP span 名取模型（Langfuse 据此显示 generation 名）
    span.kind === "llm_call" && typeof span.attrs.model === "string" && span.attrs.model
      ? span.attrs.model
      : span.name;
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name,
    kind: span.kind === "llm_call" ? KIND_CLIENT : KIND_INTERNAL,
    startTimeUnixNano: toNs(span.startMs),
    endTimeUnixNano: toNs(span.endMs || span.startMs),
    ...(attrs.length ? { attributes: attrs } : {}),
    status: failed
      ? { code: STATUS_ERROR, message: String(span.attrs.errorMessage ?? span.status) }
      : { code: STATUS_OK },
  };
}

/** 单个 run 记录 → OTLP spans（导出给测试断言形状） */
export function buildOtlpSpans(record: TraceRunRecord, redactContent: boolean): OtlpSpan[] {
  const traceId = record.traceId ?? record.runId;
  return flattenSpans(record).map((span) => spanToOtlp(span, redactContent, traceId));
}

/* ------------------------------- 队列与发送 ------------------------------- */

let queue: OtlpSpan[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFailLogAt = 0;

// 测试注入点：生产走全局 fetch（sidecar 是 Bun 运行时）。
// Bun 的 typeof fetch 带 preconnect 等平台扩展成员，这里只约束调用形状
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setFetchImplForTest(impl: FetchLike | null): void {
  fetchImpl = impl ?? ((url, init) => fetch(url, init));
}

function throttledLog(message: string, err: unknown): void {
  const now = Date.now();
  if (now - lastFailLogAt < LOG_THROTTLE_MS) return;
  lastFailLogAt = now;
  logErr("otlp-exporter:", message, err);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOtlp();
  }, FLUSH_INTERVAL_MS);
  // 定时器不阻进程退出
  (flushTimer as { unref?: () => void }).unref?.();
}

/** trace.ts settle 后调用：enabled 门控 + run 粒度采样，入队零 IO，永不抛出 */
export function exportTraceRun(record: TraceRunRecord): void {
  try {
    const cfg = getObservabilityConfig();
    if (!cfg.enabled || !cfg.endpoint) return;
    if (cfg.sampleRate < 1 && Math.random() > cfg.sampleRate) return;
    queue.push(...buildOtlpSpans(record, cfg.redactContent));
    if (queue.length >= FLUSH_THRESHOLD) void flushOtlp();
    else scheduleFlush();
  } catch (err) {
    throttledLog("enqueue failed", err);
  }
}

/** 立即冲刷队列（测试与阈值路径共用）；失败丢弃已出队内容并节流记日志 */
export async function flushOtlp(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!queue.length) return;
  const spans = queue;
  queue = [];
  const cfg = getObservabilityConfig();
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [attr("service.name", "pi-agent")],
        },
        scopeSpans: [
          {
            scope: { name: "pi-agent-trace" },
            spans,
          },
        ],
      },
    ],
  };
  try {
    const res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cfg.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OTLP endpoint responded ${res.status}`);
  } catch (err) {
    throttledLog("flush failed (batch dropped)", err);
  }
}

/** 测试辅助：清空在途队列与定时器 */
export function resetOtlpForTest(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue = [];
  lastFailLogAt = 0;
}

/** 设置页「测试连接」：向 endpoint 发一条探针 span（不落队列、不影响采样）。
 * 走 sidecar 的网络通道（渲染进程 fetch 会被 CORS 拦）；10s 超时，结果折进返回值 */
export async function probeOtlpEndpoint(
  endpoint: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status?: number; errorText?: string }> {
  if (!endpoint) return { ok: false, errorText: "endpoint 未配置" };
  const nowNs = toNs(Date.now());
  const probe: OtlpSpan = {
    traceId: hex("pi-agent-probe", 32),
    spanId: hex("pi-agent-probe:span", 16),
    name: "pi-agent probe",
    kind: KIND_INTERNAL,
    startTimeUnixNano: nowNs,
    endTimeUnixNano: nowNs,
    attributes: [attr("pi.probe", true)],
    status: { code: STATUS_OK },
  };
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "pi-agent")] },
        scopeSpans: [{ scope: { name: "pi-agent-trace" }, spans: [probe] }],
      },
    ],
  };
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, errorText: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, errorText: err instanceof Error ? err.message : String(err) };
  }
}
