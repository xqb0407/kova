/**
 * 【临时验证页，验证后删除】链路追踪瀑布视图的静态录制数据。
 *
 * 形状对齐 sidecar 的 TraceRunRecord：三条 run 覆盖完整链路（含子代理挂载）、
 * 失败/重试与在飞态。时间用相对 NOW 的毫秒偏移，读起来就是「9.18s 的一次退款」。
 */

import type { PiTraceRun, PiTraceSpan } from "@/lib/pi/pi-bridge";

// 固定时间：模块级 Date.now() 会让 SSR 与客户端水合出不同的秒数，触发 hydration 警告
const NOW = Date.parse("2026-11-05T22:45:00+08:00");
const at = (ms: number) => NOW + ms;

const span = (
  over: Partial<PiTraceSpan> & Pick<PiTraceSpan, "kind">,
): PiTraceSpan => ({
  startMs: at(0),
  endMs: at(100),
  status: "ok",
  ...over,
});

/* --------------------- #1 完整链路：退款请求 + 子代理 --------------------- */

const TASK_SPAN_ID = "a1b2c3d4e5f60718";
const CHILD_TRACE_ID = "b1e2c3d4f5a60728";

const refundRun: PiTraceRun = {
  traceId: "7f3a91c2b4d84e9f8a1c2d3e4f5a6b7c",
  runId: "7f3a91c2b4d84e9f8a1c2d3e4f5a6b7c",
  sessionId: "s-demo",
  source: "ui",
  agent: "support-agent",
  model: "anthropic/claude-sonnet-4.5",
  startMs: at(0),
  endMs: at(9_180),
  status: "ok",
  outcome: { reason: "completed" },
  usage: { input: 8_200, output: 1_600, cacheRead: 5_000, cacheWrite: 0 },
  spans: [
    span({
      spanId: "t1",
      kind: "turn",
      startMs: at(0),
      endMs: at(2_760),
      attrs: { index: 1 },
      children: [
        span({
          spanId: "l1",
          parentSpanId: "t1",
          kind: "llm_call",
          startMs: at(40),
          endMs: at(1_090),
          attrs: {
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            inputTokens: 1_200,
            outputTokens: 180,
            cacheRead: 800,
            stopReason: "toolUse",
          },
          detail: {
            request:
              "[system] 你是客服退款代理，先核对订单与政策，再决定是否退款。\n[user] 订单 T-48213 申请退款",
            response: "先核对订单状态和退款政策，再决定怎么处理。",
          },
        }),
        span({
          spanId: "k1",
          parentSpanId: "t1",
          kind: "tool_call",
          name: "kb.search",
          startMs: at(1_140),
          endMs: at(1_710),
          attrs: { args: '{"query":"refund policy","top_k":3}' },
          detail: {
            response:
              "命中 3 条退款政策：\n1. 未发货订单 7 天内可全额退款\n2. 已发货订单需质检后处理\n3. 虚拟商品不支持退款",
          },
        }),
        span({
          spanId: "o1",
          parentSpanId: "t1",
          kind: "tool_call",
          name: "orders.lookup",
          startMs: at(1_760),
          endMs: at(2_710),
          status: "error",
          attrs: {
            args: '{"ticket":"T-48213"}',
            errorMessage: "orders service 504 Gateway Timeout after 950ms",
            exitCode: 1,
          },
          detail: {
            response:
              "fetch failed: 504 Gateway Timeout\n  at orders.fetch (/app/services/orders.ts:88:11)",
          },
        }),
      ],
    }),
    span({
      spanId: "t2",
      kind: "turn",
      startMs: at(2_760),
      endMs: at(5_980),
      attrs: { index: 2 },
      children: [
        span({
          spanId: "r1",
          parentSpanId: "t2",
          kind: "retry",
          name: "timeout",
          startMs: at(2_790),
          endMs: at(2_860),
          attrs: {
            attempt: 1,
            delayMs: 950,
            code: "timeout",
            message: "orders service timed out",
          },
        }),
        span({
          spanId: "o2",
          parentSpanId: "t2",
          kind: "tool_call",
          name: "orders.lookup",
          startMs: at(2_860),
          endMs: at(3_520),
          attrs: { args: '{"ticket":"T-48213","retry":true}' },
          detail: { response: '{"order":"T-48213","status":"paid","refundable":true}' },
        }),
        span({
          spanId: "l2",
          parentSpanId: "t2",
          kind: "llm_call",
          startMs: at(3_560),
          endMs: at(5_950),
          attrs: {
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            inputTokens: 5_200,
            outputTokens: 320,
            cacheRead: 4_100,
            stopReason: "toolUse",
          },
          detail: {
            request: "[system] …\n[assistant] 先核对订单状态…\n[tool] orders.lookup …",
            response: "订单已支付且未发货，符合退款条件。接着让 billing 子代理发起退款。",
          },
        }),
      ],
    }),
    span({
      spanId: "t3",
      kind: "turn",
      startMs: at(5_980),
      endMs: at(9_180),
      attrs: { index: 3 },
      children: [
        span({
          spanId: TASK_SPAN_ID,
          parentSpanId: "t3",
          kind: "tool_call",
          name: "Task",
          startMs: at(6_010),
          endMs: at(8_230),
          attrs: { args: '{"agent":"billing-subagent","task":"为 T-48213 发起退款"}' },
          detail: { response: "refund_issued: re_9f2c" },
        }),
        span({
          spanId: "l3",
          parentSpanId: "t3",
          kind: "llm_call",
          startMs: at(8_280),
          endMs: at(8_880),
          attrs: {
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            inputTokens: 6_000,
            outputTokens: 480,
            cacheRead: 4_800,
            stopReason: "stop",
          },
          detail: {
            request: "[system] …\n[tool] Task(billing-subagent) → refund_issued",
            response: "已为你发起退款，预计 3–5 个工作日到账。",
          },
        }),
      ],
    }),
  ],
};

const billingRun: PiTraceRun = {
  traceId: CHILD_TRACE_ID,
  runId: CHILD_TRACE_ID,
  parentRunId: refundRun.traceId,
  parentSpanId: TASK_SPAN_ID,
  sessionId: "s-demo",
  source: "subagent",
  agent: "billing-subagent",
  model: "anthropic/claude-haiku-4.5",
  startMs: at(6_030),
  endMs: at(8_220),
  status: "ok",
  outcome: { reason: "completed" },
  usage: { input: 1_600, output: 240, cacheRead: 900, cacheWrite: 0 },
  spans: [
    span({
      spanId: "ct1",
      kind: "turn",
      startMs: at(6_030),
      endMs: at(8_220),
      attrs: { index: 1 },
      children: [
        span({
          spanId: "cl1",
          parentSpanId: "ct1",
          kind: "llm_call",
          startMs: at(6_060),
          endMs: at(6_980),
          attrs: {
            provider: "anthropic",
            model: "claude-haiku-4.5",
            inputTokens: 1_600,
            outputTokens: 90,
            cacheRead: 900,
            stopReason: "toolUse",
          },
          detail: { response: "订单符合条件，调用退款接口。" },
        }),
        span({
          spanId: "ctool1",
          parentSpanId: "ct1",
          kind: "tool_call",
          name: "refund.issue",
          startMs: at(7_020),
          endMs: at(8_180),
          attrs: { args: '{"order":"T-48213","amount":12900,"currency":"CNY"}' },
          detail: { response: '{"refund_id":"re_9f2c","status":"processing"}' },
        }),
      ],
    }),
  ],
};

/* --------------------------- #2 失败链路 --------------------------- */

const failedRun: PiTraceRun = {
  traceId: "2b9c8d7e6f5a40312233445566778899",
  runId: "2b9c8d7e6f5a40312233445566778899",
  sessionId: "s-demo",
  source: "automation",
  model: "openai/gpt-5.1",
  startMs: at(-3_600_000),
  endMs: at(-3_600_000 + 3_100),
  status: "error",
  outcome: { reason: "error", detail: "模型连续重试后仍 429，重试预算耗尽" },
  usage: { input: 4_000, output: 120, cacheRead: 2_800, cacheWrite: 0 },
  spans: [
    span({
      spanId: "ft1",
      kind: "turn",
      startMs: at(-3_600_000),
      endMs: at(-3_600_000 + 3_100),
      attrs: { index: 1 },
      children: [
        span({
          spanId: "fl1",
          parentSpanId: "ft1",
          kind: "llm_call",
          startMs: at(-3_600_000 + 20),
          endMs: at(-3_600_000 + 2_050),
          status: "error",
          attrs: {
            provider: "openai",
            model: "gpt-5.1",
            inputTokens: 4_000,
            outputTokens: 0,
            errorMessage: "429 Too Many Requests",
            stopReason: "error",
          },
          detail: {
            request: "[system] …\n[user] 汇总今天的退款工单",
            response: "429 Too Many Requests（retry-after: 30s）",
          },
        }),
        span({
          spanId: "fr1",
          parentSpanId: "ft1",
          kind: "retry",
          name: "rate_limit",
          startMs: at(-3_600_000 + 2_060),
          endMs: at(-3_600_000 + 2_580),
          attrs: {
            attempt: 3,
            delayMs: 4_000,
            code: "rate_limit",
            message: "429 rate limit exceeded",
          },
        }),
        span({
          spanId: "fa1",
          parentSpanId: "ft1",
          kind: "tool_call",
          name: "billing.refund",
          startMs: at(-3_600_000 + 2_620),
          endMs: at(-3_600_000 + 3_080),
          status: "aborted",
          attrs: { args: '{"order":"T-50021"}' },
          detail: { response: "用户停止，退款调用未完成" },
        }),
      ],
    }),
  ],
};

/* --------------------------- #3 在飞（partial） --------------------------- */

const liveRun: PiTraceRun = {
  traceId: "9e8d7c6b5a4938271605f4e3d2c1b0a9",
  runId: "9e8d7c6b5a4938271605f4e3d2c1b0a9",
  sessionId: "s-demo",
  source: "ui",
  model: "anthropic/claude-sonnet-4.5",
  startMs: at(-120_000),
  endMs: at(-120_000 + 4_200),
  status: "ok",
  partial: true,
  spans: [
    span({
      spanId: "vt1",
      kind: "turn",
      startMs: at(-120_000),
      endMs: at(-120_000 + 1_800),
      attrs: { index: 1 },
      children: [
        span({
          spanId: "vl1",
          parentSpanId: "vt1",
          kind: "llm_call",
          startMs: at(-120_000 + 20),
          endMs: at(-120_000 + 1_500),
          attrs: {
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            inputTokens: 900,
            outputTokens: 120,
            stopReason: "toolUse",
          },
          detail: { response: "先看一下当前的 git 状态。" },
        }),
        span({
          spanId: "vtool1",
          parentSpanId: "vt1",
          kind: "tool_call",
          name: "bash",
          startMs: at(-120_000 + 1_520),
          endMs: at(-120_000 + 1_790),
          attrs: { args: '{"command":"git status --short"}' },
          detail: { response: " M src/app.ts\n?? notes.md" },
        }),
      ],
    }),
    span({
      spanId: "vt2",
      kind: "turn",
      startMs: at(-120_000 + 1_800),
      endMs: at(-120_000 + 4_200),
      attrs: { index: 2 },
      children: [
        span({
          spanId: "vl2",
          parentSpanId: "vt2",
          kind: "llm_call",
          startMs: at(-120_000 + 1_820),
          endMs: at(-120_000 + 4_200),
          attrs: {
            provider: "anthropic",
            model: "claude-sonnet-4.5",
            inputTokens: 1_500,
            outputTokens: 260,
            cacheRead: 700,
            stopReason: "toolUse",
          },
          detail: {
            request: "[system] …\n[tool] bash → M src/app.ts",
            response: "有一个未提交的改动，我来看看改了什么。",
          },
        }),
      ],
    }),
  ],
};

export const TRACE_RUNS: PiTraceRun[] = [refundRun, billingRun, failedRun, liveRun];
