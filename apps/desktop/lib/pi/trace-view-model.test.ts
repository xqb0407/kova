import { describe, expect, test } from "bun:test";
import type { PiTraceRun, PiTraceSpan } from "@/lib/pi/pi-bridge";
import {
  defaultCollapsed,
  flattenTraceSpans,
  formatTraceDate,
  formatTraceDuration,
  formatTraceTick,
  toTraceViewRuns,
  traceRunFlags,
  traceStatusLabel,
  traceTimeTicks,
  traceUsageTotal,
  traceUserPrompt,
} from "./trace-view-model";

/**
 * 瀑布视图模型的测试重点：
 * 1. 子代理记录必须挂回父 run 的那次 Task span，而不是变成一条并列 run；
 * 2. 父 run 的 token/跨度统计要递归包含子 run；
 * 3. 回放依赖的时间刻度与折叠展平不能改变节点顺序。
 */

const span = (over: Partial<PiTraceSpan> & Pick<PiTraceSpan, "kind">): PiTraceSpan => ({
  startMs: 1_000,
  endMs: 1_200,
  status: "ok",
  ...over,
});

const run = (over: Partial<PiTraceRun> = {}): PiTraceRun => ({
  traceId: "p".repeat(32),
  runId: "p".repeat(32),
  sessionId: "s1",
  source: "ui",
  startMs: 1_000,
  endMs: 5_000,
  status: "ok",
  model: "test/model",
  usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 },
  ...over,
  spans: over.spans ?? [],
});

function parentRun(): PiTraceRun {
  return run({
    agent: "support-agent",
    spans: [
      span({
        spanId: "turn1",
        kind: "turn",
        startMs: 1_000,
        endMs: 3_000,
        attrs: { index: 1 },
        children: [
          span({
            spanId: "llm1",
            parentSpanId: "turn1",
            kind: "llm_call",
            startMs: 1_100,
            endMs: 2_000,
            attrs: { model: "p/m", inputTokens: 100, outputTokens: 30, cacheRead: 80 },
            detail: { response: "先读配置。再决定。" },
          }),
          span({
            spanId: "task1",
            parentSpanId: "turn1",
            kind: "tool_call",
            name: "Task",
            startMs: 2_000,
            endMs: 3_000,
            attrs: { args: '{"agent":"child-agent"}' },
          }),
        ],
      }),
    ],
  });
}

function childRun(): PiTraceRun {
  return run({
    traceId: "c".repeat(32),
    runId: "c".repeat(32),
    parentRunId: "p".repeat(32),
    parentSpanId: "task1",
    source: "subagent",
    agent: "child-agent",
    model: "test/child",
    startMs: 2_100,
    endMs: 2_900,
    status: "ok",
    usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
    spans: [
      span({
        spanId: "cturn1",
        kind: "turn",
        startMs: 2_100,
        endMs: 2_900,
        attrs: { index: 1 },
        children: [
          span({
            spanId: "cllm1",
            parentSpanId: "cturn1",
            kind: "llm_call",
            startMs: 2_150,
            endMs: 2_800,
            attrs: { model: "test/child", inputTokens: 50, outputTokens: 10 },
          }),
        ],
      }),
    ],
  });
}

describe("toTraceViewRuns", () => {
  test("子代理记录挂回父 run 的 Task span，并递归累加统计", () => {
    const runs = toTraceViewRuns([parentRun(), childRun()]);
    // 子 run 不是并列根
    expect(runs).toHaveLength(1);
    const parent = runs[0]!;
    expect(parent.traceId).toBe("p".repeat(32));
    expect(parent.agentName).toBe("support-agent");
    expect(parent.root.name).toBe("support-agent.run");
    // 1 root + 1 turn + 1 llm + 1 task + 1 child root + 1 child turn + 1 child llm
    expect(parent.spanCount).toBe(7);
    expect(parent.usage.input).toBe(150);
    expect(parent.usage.output).toBe(30);
    expect(parent.usage.cacheRead).toBe(80);
    expect(traceUsageTotal(parent.usage)).toBe(260);

    const turn = parent.root.children[0]!;
    expect(turn.kind).toBe("turn");
    expect(turn.name).toBe("第 1 轮");
    expect(turn.category).toBe("agent");
    const task = turn.children[1]!;
    expect(task.name).toBe("Task");
    expect(task.children).toHaveLength(1);
    const child = task.children[0]!;
    expect(child.name).toBe("child-agent");
    expect(child.childRunTraceId).toBe("c".repeat(32));
    expect(child.kind).toBe("run");
    // 子 run 内部结构完整
    expect(child.children[0]!.children[0]!.kind).toBe("llm_call");
  });

  test("父记录缺失时子 run 当根处理", () => {
    const runs = toTraceViewRuns([childRun()]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.traceId).toBe("c".repeat(32));
    expect(runs[0]!.source).toBe("subagent");
  });

  test("按开始时间倒序；在飞 run 标记 running 且时长取已录到的末点", () => {
    const live = run({
      traceId: "l".repeat(32),
      runId: "l".repeat(32),
      startMs: 10_000,
      endMs: 12_400,
      partial: true,
      outcome: undefined,
      spans: [
        span({
          spanId: "lt1",
          kind: "turn",
          startMs: 10_000,
          endMs: 12_400,
          attrs: { index: 1 },
          children: [],
        }),
      ],
    });
    const runs = toTraceViewRuns([parentRun(), live]);
    expect(runs.map((r) => r.traceId)).toEqual(["l".repeat(32), "p".repeat(32)]);
    expect(runs[0]!.running).toBe(true);
    expect(runs[0]!.status).toBe("running");
    expect(runs[0]!.durationMs).toBe(2_400);
  });

  test("aborted span 保留状态，且不计入失败数", () => {
    const rec = run({
      spans: [
        span({
          spanId: "at1",
          kind: "turn",
          startMs: 1_000,
          endMs: 2_000,
          attrs: { index: 1 },
          children: [
            span({
              spanId: "a1",
              parentSpanId: "at1",
              kind: "tool_call",
              name: "billing.refund",
              startMs: 1_200,
              endMs: 1_800,
              status: "aborted",
              attrs: { args: "{}" },
            }),
          ],
        }),
      ],
    });
    const view = toTraceViewRuns([rec])[0]!;
    const node = view.root.children[0]!.children[0]!;
    expect(node.status).toBe("aborted");
    // 用户 Stop 不是错误：状态徽章不应把它算成失败
    expect(traceRunFlags(view.root)).toEqual({ failures: 0, retries: 0 });
  });

  test("live/旧记录缺 model/usage 时从 LLM span 派生（不含失败调用）", () => {
    const rec = run({
      model: undefined,
      usage: undefined,
      spans: [
        span({
          spanId: "lt1",
          kind: "turn",
          startMs: 1_000,
          endMs: 3_000,
          attrs: { index: 1 },
          children: [
            span({
              spanId: "llm-ok",
              parentSpanId: "lt1",
              kind: "llm_call",
              startMs: 1_100,
              endMs: 1_500,
              attrs: {
                model: "p/live",
                inputTokens: 7,
                outputTokens: 3,
                cacheRead: 2,
                cacheWrite: 1,
              },
            }),
            span({
              spanId: "llm-err",
              parentSpanId: "lt1",
              kind: "llm_call",
              startMs: 1_600,
              endMs: 1_800,
              status: "error",
              attrs: { model: "p/live", inputTokens: 100, outputTokens: 5 },
            }),
          ],
        }),
      ],
    });
    const view = toTraceViewRuns([rec])[0]!;
    expect(view.model).toBe("p/live");
    expect(view.root.attrs.model).toBe("p/live");
    // 与 recorder 同口径：error 调用的 token 不计入
    expect(view.usage).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 1 });
    expect(view.root.usage).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 1 });
  });

  test("单个坏记录不影响其它 run", () => {
    const a = run({
      traceId: "a".repeat(32),
      runId: "a".repeat(32),
      parentRunId: "b".repeat(32),
    });
    const b = run({
      traceId: "b".repeat(32),
      runId: "b".repeat(32),
      parentRunId: "a".repeat(32),
    });
    // 互相指向的坏记录没有根，不会挂到正常 run 上，也不能把构建拖死
    const runs = toTraceViewRuns([parentRun(), a, b]);
    expect(runs.map((r) => r.traceId)).toEqual(["p".repeat(32)]);
  });

  test("运行记录标题取本次发送的用户输入（上下文里最后一个 [user] 段）", () => {
    const rec = run({
      spans: [
        span({
          spanId: "t1",
          kind: "turn",
          children: [
            span({
              spanId: "l1",
              parentSpanId: "t1",
              kind: "llm_call",
              detail: {
                request:
                  "[system] 你是助手\n\n[user] 第一问\n\n[assistant] 回答\n\n[user] 继续优化",
              },
            }),
          ],
        }),
      ],
    });
    const view = toTraceViewRuns([rec])[0]!;
    expect(view.prompt).toBe("继续优化");
  });

  test("优先读 attrs.prompt（sidecar 写入的原始输入），旧记录回落到请求上下文", () => {
    const rec = run({
      spans: [
        span({
          spanId: "t1",
          kind: "turn",
          children: [
            span({
              spanId: "l1",
              parentSpanId: "t1",
              kind: "llm_call",
              attrs: { prompt: "来自 attrs" },
              detail: { request: "[user] 来自 request" },
            }),
          ],
        }),
      ],
    });
    expect(toTraceViewRuns([rec])[0]!.prompt).toBe("来自 attrs");
  });

  test("请求上下文缺失/超长时：标题缺失或截断", () => {
    expect(traceUserPrompt("[system] 只有系统消息")).toBeUndefined();
    expect(traceUserPrompt("[user] ")).toBeUndefined();
    // 段首匹配，不把正文里的 "[user] " 误认成新段
    expect(traceUserPrompt("[user] a\n\n[toolResult] 输出里有 [user] 字样")).toBe(
      "a",
    );
    const long = "长".repeat(120);
    expect(traceUserPrompt(`[user] ${long}`)).toBe(`${"长".repeat(80)}…`);
    // 请求正文被总闸截断：最后一条 user 段可能已被砍掉，不猜
    expect(
      traceUserPrompt("[user] 旧消息\n\n…[请求上下文已截断]"),
    ).toBeUndefined();

    const noDetail = run({
      spans: [span({ spanId: "t1", kind: "turn", children: [] })],
    });
    expect(toTraceViewRuns([noDetail])[0]!.prompt).toBeUndefined();
  });
});

describe("flattenTraceSpans", () => {
  test("折叠父节点时保留父行、跳过子树", () => {
    const parent = toTraceViewRuns([parentRun(), childRun()])[0]!;
    const all = flattenTraceSpans(parent.root, new Set());
    expect(all).toHaveLength(parent.spanCount);
    expect(all[0]!.depth).toBe(0);
    expect(all[1]!.depth).toBe(1);

    const collapsed = flattenTraceSpans(parent.root, new Set(["turn1"]));
    expect(collapsed).toHaveLength(2);
    expect(collapsed.some((r) => r.span.id === "llm1")).toBe(false);
  });

  test("默认折叠子代理内部，保留子代理根行", () => {
    const parent = toTraceViewRuns([parentRun(), childRun()])[0]!;
    const collapsed = new Set(defaultCollapsed(parent.root));
    const rows = flattenTraceSpans(parent.root, collapsed);
    const child = rows.find((r) => r.span.childRunTraceId);
    expect(child).toBeTruthy();
    expect(rows.some((r) => r.span.id === "cllm1")).toBe(false);
    // 主 run 的轮次默认展开
    expect(rows.some((r) => r.span.id === "llm1")).toBe(true);
  });
});

describe("读数与时间轴", () => {
  test("失败/重试计数递归到子 run", () => {
    const parent = parentRun();
    parent.spans[0]!.children!.push(
      span({
        spanId: "retry1",
        parentSpanId: "turn1",
        kind: "retry",
        attrs: { attempt: 1, delayMs: 500, code: "timeout" },
      }),
      span({
        spanId: "err1",
        parentSpanId: "turn1",
        kind: "tool_call",
        name: "orders.lookup",
        status: "error",
        attrs: { errorMessage: "504" },
      }),
    );
    const child = childRun();
    child.status = "error";
    child.spans[0]!.children![0]!.status = "error";
    const run0 = toTraceViewRuns([parent, child])[0]!;
    const flags = traceRunFlags(run0.root);
    // 父 run 的 1 个工具失败 + 子 run 的 1 个 LLM 失败
    expect(flags.failures).toBe(2);
    expect(flags.retries).toBe(1);
    // 顶层 run 状态仍是成功（工具失败被模型吸收），面板用告警色提示
    expect(traceStatusLabel(run0).tone).toBe("ok");
    expect(traceStatusLabel(toTraceViewRuns([{ ...parent, status: "error" }])[0]!).tone).toBe(
      "error",
    );
  });

  test("时间刻度落在可读的整秒/整毫秒上", () => {
    expect(traceTimeTicks(9_180, 5)).toEqual([0, 2_000, 4_000, 6_000, 8_000]);
    expect(traceTimeTicks(500, 5)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(traceTimeTicks(3, 5)).toEqual([0, 1, 2, 3]);
    expect(traceTimeTicks(0)).toEqual([0]);
    expect(formatTraceTick(2_000)).toBe("2s");
    expect(formatTraceTick(500)).toBe("500ms");
    expect(formatTraceTick(65_000)).toBe("1m5s");
    expect(formatTraceTick(3_600_000)).toBe("1h");
    expect(formatTraceTick(5_400_000)).toBe("1h30m");
  });

  test("时长与日期标签", () => {
    expect(formatTraceDuration(950)).toBe("950ms");
    expect(formatTraceDuration(9_180)).toBe("9.18s");
    expect(formatTraceDuration(125_000)).toBe("2m5s");
    const now = new Date(2026, 10, 5, 14, 0, 0).getTime();
    expect(formatTraceDate(now - 60_000, now)).toBe("今天 13:59:00");
    expect(formatTraceDate(now - 86_400_000, now)).toBe("昨天 14:00:00");
  });
});
