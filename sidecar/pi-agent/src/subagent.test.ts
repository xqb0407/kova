import { describe, expect, test } from "bun:test";
import {
  MAX_SUBAGENT_REPORT_CHARS,
  boundedReport,
  delegationHeartbeat,
  delegationResumeText,
  normalizeSubagentName,
  parseModelKey,
  runningDelegations,
  settleDelegation,
  waitForDelegations,
} from "./subagent";
import type { DelegationRecord, Running, SubagentRunResult } from "./types";

/** 构造最小可用的委派登记项（不触碰 Agent / 模型目录） */
function makeRecord(
  delegationId: string,
  overrides: Partial<DelegationRecord> = {},
): DelegationRecord {
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    delegationId,
    agentName: "explorer",
    modelId: "test/model",
    status: "running",
    stopRequested: false,
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    reportedToParent: false,
    completion,
    resolveCompletion,
    abort: () => {},
    ...overrides,
  };
}

function makeRun(records: DelegationRecord[] = []): Running {
  return {
    agent: {} as Running["agent"],
    sessionId: "s",
    cwd: ".",
    persistedSeq: 0,
    delegations: new Map(records.map((r) => [r.delegationId, r])),
    stopRequested: false,
    mode: "agent",
    approvalLevel: "ask",
    planning: "inactive",
    proposal: null,
    baseTools: [],
    subagentTools: [],
    pendingToolApprovals: new Map(),
  };
}

function settledResult(status: SubagentRunResult["status"] = "completed"): SubagentRunResult {
  return {
    agentName: "explorer",
    modelId: "test/model",
    status,
    report: `report-${status}`,
    turns: 1,
    toolCalls: 2,
  };
}

describe("normalizeSubagentName", () => {
  test("去空白并小写", () => {
    expect(normalizeSubagentName("  Explorer ")).toBe("explorer");
  });
});

describe("parseModelKey", () => {
  test("标准 provider/modelId", () => {
    expect(parseModelKey("anthropic/claude-sonnet-4")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  test("modelId 本身可以含斜杠（首个 / 分隔）", () => {
    expect(parseModelKey("custom-x/deepseek/r1")).toEqual({
      provider: "custom-x",
      modelId: "deepseek/r1",
    });
  });

  test("非法输入返回 undefined", () => {
    expect(parseModelKey("no-slash")).toBeUndefined();
    expect(parseModelKey("/leading")).toBeUndefined();
    expect(parseModelKey("trailing/")).toBeUndefined();
  });
});

describe("boundedReport", () => {
  test("短报告原样返回（trim）", () => {
    expect(boundedReport("  hello  ")).toBe("hello");
  });

  test("超长报告保留头尾并受上限约束", () => {
    const long = `${"a".repeat(9000)}${"b".repeat(9000)}`;
    const out = boundedReport(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SUBAGENT_REPORT_CHARS);
    expect(out).toContain("[subagent report truncated]");
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("b")).toBe(true);
  });
});

describe("delegationHeartbeat", () => {
  test("running 记录显示已运行秒数", () => {
    const line = delegationHeartbeat(
      makeRecord("abcdef123456", { status: "running", startedAt: Date.now() - 5000 }),
    );
    expect(line).toContain("explorer (abcdef12)");
    expect(line).toContain("running");
  });

  test("已结算记录显示状态与耗时", () => {
    const startedAt = Date.now() - 10_000;
    const line = delegationHeartbeat(
      makeRecord("abcdef123456", {
        status: "completed",
        startedAt,
        completedAt: startedAt + 2000,
      }),
    );
    expect(line).toContain("completed after 2s");
  });
});

describe("settleDelegation", () => {
  test("结算写入结果并唤醒 completion", async () => {
    const record = makeRecord("r1");
    const run = makeRun([record]);
    settleDelegation(run, record, settledResult("completed"));
    expect(record.status).toBe("completed");
    expect(record.result?.report).toBe("report-completed");
    await record.completion; // 不挂起即通过
  });

  test("stopRequested + aborted 归类为 stopped", () => {
    const record = makeRecord("r2", { stopRequested: true });
    const run = makeRun([record]);
    settleDelegation(run, record, settledResult("aborted"));
    expect(record.status).toBe("stopped");
  });

  test("重复结算被忽略", () => {
    const record = makeRecord("r3");
    const run = makeRun([record]);
    settleDelegation(run, record, settledResult("completed"));
    settleDelegation(run, record, settledResult("failed"));
    expect(record.status).toBe("completed");
  });

  test("已完成记录超过保留上限时丢弃最旧的", () => {
    const records = Array.from({ length: 55 }, (_, i) =>
      makeRecord(`cap-${String(i).padStart(2, "0")}`, { completedAt: i }),
    );
    const run = makeRun(records);
    for (const r of records) settleDelegation(run, r, settledResult());
    // 上限 50：最旧的 5 条被丢弃，running 永不丢弃
    expect(runningDelegations(run)).toEqual([]);
    expect(run.delegations.size).toBe(50);
    expect(run.delegations.has("cap-00")).toBe(false);
    expect(run.delegations.has("cap-54")).toBe(true);
  });
});

describe("runningDelegations", () => {
  test("只返回 running 状态的记录", () => {
    const run = makeRun([
      makeRecord("a"),
      makeRecord("b", { status: "completed" }),
      makeRecord("c"),
    ]);
    expect(runningDelegations(run).map((r) => r.delegationId)).toEqual(["a", "c"]);
  });
});

describe("delegationResumeText", () => {
  test("未投递的已结算报告进入恢复 prompt 并被标记", () => {
    const record = makeRecord("11111111aaaa", { status: "completed" });
    const run = makeRun([record]);
    record.result = settledResult();
    const text = delegationResumeText(run);
    expect(text).toContain("explorer");
    expect(text).toContain("report-completed");
    expect(text).toContain("delegation 11111111, completed");
    expect(record.reportedToParent).toBe(true);
    // 第二次没有可投递内容
    expect(delegationResumeText(run)).toBe("");
  });

  test("TaskWait 已投递的报告不重复投递", () => {
    const record = makeRecord("22222222bbbb", { status: "completed", reportedToParent: true });
    const run = makeRun([record]);
    record.result = settledResult();
    expect(delegationResumeText(run)).toBe("");
  });

  test("仍有运行中的委派时附上心跳行", () => {
    const done = makeRecord("33333333cccc", { status: "completed" });
    done.result = settledResult();
    const running = makeRecord("44444444dddd", { agentName: "fixer" });
    const text = delegationResumeText(makeRun([done, running]));
    expect(text).toContain("Still running:");
    expect(text).toContain("fixer (44444444)");
  });
});

describe("waitForDelegations", () => {
  test("已全部结算时立即返回 false", async () => {
    const record = makeRecord("w1", { status: "completed" });
    const timedOut = await waitForDelegations([record], 1, Date.now() + 1000);
    expect(timedOut).toBe(false);
  });

  test("结算发生在截止前返回 false", async () => {
    const record = makeRecord("w2");
    const run = makeRun([record]);
    setTimeout(() => settleDelegation(run, record, settledResult()), 20);
    const timedOut = await waitForDelegations([record], 1, Date.now() + 5000);
    expect(timedOut).toBe(false);
  });

  test("截止时间已过返回 true", async () => {
    const record = makeRecord("w3");
    const timedOut = await waitForDelegations([record], 1, Date.now() - 1);
    expect(timedOut).toBe(true);
  });

  test("外部中止信号返回 true", async () => {
    const record = makeRecord("w4");
    const controller = new AbortController();
    const promise = waitForDelegations([record], 1, null, controller.signal);
    controller.abort();
    expect(await promise).toBe(true);
  });
});
