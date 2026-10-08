import { describe, test, expect } from "bun:test";
import { extractIntent, toLoopRuns } from "@/lib/pi/loop-adapter";
import type { PiTraceRun, PiTraceSpan } from "@/lib/pi/pi-bridge";

/**
 * 适配层测试：trace（span 树 + 扁平 run 列表）→ loop 视图模型（迭代结构）。
 * 这里最容易静默出错的是子 run 还原与 atMs 换算，所以重点压这两处。
 */

const span = (over: Partial<PiTraceSpan> & Pick<PiTraceSpan, "kind">): PiTraceSpan => ({
  startMs: 1_000,
  endMs: 1_200,
  status: "ok",
  ...over,
});

/** 一个两轮 turn 的 run：第 1 轮 llm + 工具，第 2 轮只 llm 收尾 */
function makeRun(over: Partial<PiTraceRun> = {}): PiTraceRun {
  return {
    traceId: "parent-trace",
    runId: "parent-trace",
    sessionId: "s1",
    source: "ui",
    startMs: 1_000,
    endMs: 5_000,
    status: "ok",
    model: "test/model",
    usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 },
    spans: [
      span({
        kind: "turn",
        spanId: "turn-1",
        children: [
          span({
            kind: "llm_call",
            spanId: "llm-1",
            startMs: 1_000,
            endMs: 2_000,
            attrs: {
              model: "test/model",
              inputTokens: 100,
              outputTokens: 30,
              cacheRead: 80,
              stopReason: "toolUse",
            },
            detail: { response: "先读一下配置。然后再决定。" },
          }),
          span({
            kind: "tool_call",
            spanId: "tool-1",
            name: "read",
            startMs: 2_000,
            endMs: 2_300,
            attrs: { args: '{"file_path":"/a.ts"}' },
            detail: { response: "42 lines" },
          }),
        ],
      }),
      span({
        kind: "turn",
        spanId: "turn-2",
        startMs: 2_300,
        endMs: 4_000,
        children: [
          span({
            kind: "llm_call",
            spanId: "llm-2",
            startMs: 2_300,
            endMs: 4_000,
            attrs: { inputTokens: 180, outputTokens: 12 },
            detail: { response: "改完了。" },
          }),
        ],
      }),
    ],
    ...over,
  };
}

describe("extractIntent", () => {
  test("取首句，中英文句读都认", () => {
    expect(extractIntent("先读配置。后面还有一堆话")).toBe("先读配置。");
    expect(extractIntent("Read the config first. Then decide")).toBe("Read the config first.");
    expect(extractIntent("第一行\n第二行")).toBe("第一行");
  });

  test("剥掉 [role] 渲染前缀", () => {
    expect(extractIntent("[assistant] 先确认版本。")).toBe("先确认版本。");
  });

  test("超长无句读时截断，空输入返回 undefined", () => {
    const long = "啊".repeat(200);
    expect(extractIntent(long)!.length).toBeLessThanOrEqual(80);
    expect(extractIntent("")).toBeUndefined();
    expect(extractIntent(undefined)).toBeUndefined();
  });
});

describe("toLoopRuns", () => {
  test("turn → 迭代，子 span → 步骤，atMs 转成相对 run 起点", () => {
    const [run] = toLoopRuns([makeRun()]);
    expect(run!.iterations).toHaveLength(2);

    const first = run!.iterations[0]!;
    expect(first.index).toBe(1);
    expect(first.steps).toHaveLength(2);
    expect(first.steps[0]!.kind).toBe("llm");
    expect(first.steps[0]!.atMs).toBe(0); // 1_000 - 1_000
    expect(first.steps[1]!.atMs).toBe(1_000); // 2_000 - 1_000
    expect(first.steps[1]!.durationMs).toBe(300);
    // 意图从 llm 的 response 派生，不新增采集字段
    expect(first.intent).toBe("先读一下配置。");
    // 有工具 → loop 继续
    expect(first.stoppedBecause).toBe("tool-call");

    const second = run!.iterations[1]!;
    expect(second.index).toBe(2);
    expect(second.stoppedBecause).toBe("final-answer");
    expect(second.intent).toBe("改完了。");
  });

  test("usage 从 attrs 还原；工具 step 没有 usage", () => {
    const [run] = toLoopRuns([makeRun()]);
    const llm = run!.iterations[0]!.steps[0]!;
    expect(llm.usage).toEqual({ input: 100, output: 30, cacheRead: 80, cacheWrite: undefined });
    expect(run!.iterations[0]!.steps[1]!.usage).toBeUndefined();
  });

  test("args 是被 clip 的 JSON 串：能解析就还原，截断的退回原文不假装是对象", () => {
    const [run] = toLoopRuns([makeRun()]);
    expect(run!.iterations[0]!.steps[1]!.args).toEqual({ file_path: "/a.ts" });

    const broken = makeRun({
      spans: [
        span({
          kind: "turn",
          spanId: "t",
          children: [
            span({
              kind: "tool_call",
              name: "bash",
              attrs: { args: '{"command":"pnpm i' }, // 截断
            }),
          ],
        }),
      ],
    });
    const [r2] = toLoopRuns([broken]);
    expect(typeof r2!.iterations[0]!.steps[0]!.args).toBe("string");
  });

  test("工具失败：errorMessage 与退出码进 error 字段", () => {
    const failed = makeRun({
      status: "error",
      spans: [
        span({
          kind: "turn",
          spanId: "t1",
          children: [
            span({
              kind: "tool_call",
              name: "bash",
              status: "error",
              attrs: { args: "{}", errorMessage: "sh: pnpm: not found", exitCode: 127 },
            }),
          ],
        }),
      ],
    });
    const [run] = toLoopRuns([failed]);
    const step = run!.iterations[0]!.steps[0]!;
    expect(step.status).toBe("error");
    expect(step.error?.message).toContain("pnpm: not found");
    expect(step.error?.exitCode).toBe(127);
  });

  test("retry span 带 attempt/delayMs", () => {
    const withRetry = makeRun({
      spans: [
        span({
          kind: "turn",
          spanId: "t1",
          children: [
            span({
              kind: "retry",
              name: "429",
              attrs: { attempt: 2, delayMs: 2_000, code: "429" },
            }),
          ],
        }),
      ],
    });
    const [run] = toLoopRuns([withRetry]);
    const step = run!.iterations[0]!.steps[0]!;
    expect(step.kind).toBe("retry");
    expect(step.status).toBe("retry");
    expect(step.retry).toEqual({ attempt: 2, delayMs: 2_000, reason: "429" });
  });

  test("子代理按 parentRunId 还原成嵌套树，并挂在父 run 下", () => {
    const child = makeRun({
      traceId: "child-trace",
      runId: "child-trace",
      source: "subagent",
      parentRunId: "parent-trace",
      parentSpanId: "task-span",
    });
    const roots = toLoopRuns([makeRun(), child]);
    // 子 run 不再平铺成第二个根
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children![0]!.traceId).toBe("child-trace");
    expect(roots[0]!.children![0]!.source).toBe("subagent");
  });

  test("父 run 被 limit 截掉时，子 run 仍作为根保留（不能因此丢数据）", () => {
    const orphan = makeRun({
      traceId: "orphan",
      runId: "orphan",
      source: "subagent",
      parentRunId: "not-in-result",
    });
    const roots = toLoopRuns([orphan]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.traceId).toBe("orphan");
  });

  test("多个子代理按时间排序", () => {
    const a = makeRun({ traceId: "c-a", runId: "c-a", source: "subagent", parentRunId: "parent-trace", startMs: 3_000 });
    const b = makeRun({ traceId: "c-b", runId: "c-b", source: "subagent", parentRunId: "parent-trace", startMs: 2_000 });
    const roots = toLoopRuns([makeRun(), a, b]);
    expect(roots[0]!.children!.map((c) => c.traceId)).toEqual(["c-b", "c-a"]);
  });

  test("终止归因：新记录用 outcome，旧记录按 status 兜底（aborted ≠ error）", () => {
    const withOutcome = makeRun({
      outcome: { reason: "length-budget-exhausted", detail: "连续 3 次续跑" },
    });
    expect(toLoopRuns([withOutcome])[0]!.outcome?.reason).toBe("length-budget-exhausted");

    // 旧 JSONL 没有 outcome 字段
    expect(toLoopRuns([makeRun({ status: "aborted" })])[0]!.outcome?.reason).toBe("user-stop");
    expect(toLoopRuns([makeRun({ status: "error" })])[0]!.outcome?.reason).toBe("error");
    expect(toLoopRuns([makeRun({ status: "ok" })])[0]!.outcome?.reason).toBe("completed");
  });

  test("在飞 run（endMs=0）：durationMs 为 null，未收口的 span 也为 null", () => {
    const live = makeRun({
      endMs: 0,
      spans: [
        span({
          kind: "turn",
          spanId: "t1",
          endMs: 0,
          children: [
            span({ kind: "llm_call", spanId: "l1", startMs: 2_000, endMs: 0 }),
            span({
              kind: "llm_call",
              spanId: "l2",
              startMs: 1_500,
              endMs: 2_800,
              attrs: { inputTokens: 50, outputTokens: 5 },
            }),
          ],
        }),
      ],
    });
    const [run] = toLoopRuns([live]);
    expect(run!.durationMs).toBeNull();
    const [open, done] = run!.iterations[0]!.steps;
    expect(open!.durationMs).toBeNull();
    expect(done!.durationMs).toBe(1_300);
  });

  test("无 traceId 的旧记录回退用 runId 作身份", () => {
    const legacy = makeRun({ traceId: undefined, runId: "legacy-run" });
    expect(toLoopRuns([legacy])[0]!.traceId).toBe("legacy-run");
  });

  test("partial 在飞（无 outcome）：durationMs=null，结束态由未收口 span 表达", () => {
    const live = makeRun({ partial: true, endMs: 4_000 });
    const [run] = toLoopRuns([live]);
    // 在飞 run 的时长必须是 null——视图靠它渲染「运行中」
    expect(run!.durationMs).toBeNull();
    // 也不该有终止归因（还没停）
    expect(run!.outcome).toBeUndefined();
    // 已闭合的轮照常映射
    expect(run!.iterations).toHaveLength(2);
  });

  test("partial 中断残留（outcome.reason=interrupted）：时长定格、归因可见", () => {
    const dead = makeRun({
      partial: true,
      status: "error",
      outcome: { reason: "interrupted", detail: "进程中断" },
    });
    const [run] = toLoopRuns([dead]);
    expect(run!.outcome?.reason).toBe("interrupted");
    expect(run!.outcome?.detail).toBe("进程中断");
    // 已定格成有限时长，不能再显示成在飞
    expect(run!.durationMs).toBe(4_000);
  });
});

