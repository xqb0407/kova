import { describe, expect, test } from "bun:test";
import {
  acceptProposal,
  addTokens,
  confirmProposal,
  createWorkflowRun,
  formatWorkflowStatus,
  hasOpenSteps,
  interpolatePrompt,
  isWorkflowRun,
  readyStepKeys,
  rejectProposal,
  resumeRun,
  settleStep,
  stepFingerprint,
  transitionRun,
  validatePlan,
  MAX_INTERPOLATED_PROMPT_CHARS,
} from "../../src/workflow/plan-state";

function runWithPlan() {
  const run = createWorkflowRun("t1", "审查改动文件");
  const checked = validatePlan([
    { key: "a", kind: "delegate", title: "审查 A", prompt: "A 的任务", agent: "explorer", dependsOn: [] },
    { key: "b", kind: "delegate", title: "审查 B", prompt: "B 的任务", agent: "explorer" },
    { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总 {{a}} 与 {{b}}", dependsOn: ["a", "b"] },
  ]);
  if (!checked.ok) throw new Error(checked.reason);
  return { run: acceptProposal(run, checked.steps, "审查"), steps: checked.steps };
}

describe("validatePlan", () => {
  test("合法剧本通过:key/依赖/synthesize 收束", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "explorer" },
      { key: "s", kind: "synthesize", title: "汇总", prompt: "结论 {{a}}", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.steps[0]!.dependsOn).toEqual([]);
      expect(checked.steps[0]!.phase).toBe("执行"); // phase 缺省
    }
  });

  test("重复 key 被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "a", kind: "delegate", title: "A2", prompt: "任务2", agent: "x" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("duplicated");
  });

  test("delegate 缺 agent 被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务" },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('"agent"');
  });

  test("synthesize 不止一个被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "s1", kind: "synthesize", title: "S1", prompt: "1", dependsOn: ["a"] },
      { key: "s2", kind: "synthesize", title: "S2", prompt: "2", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("exactly one synthesize");
  });

  test("未知依赖被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", dependsOn: ["ghost"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('unknown step "ghost"');
  });

  test("依赖环被拒(A→B→A)", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", dependsOn: ["b"] },
      { key: "b", kind: "delegate", title: "B", prompt: "任务", agent: "x", dependsOn: ["a"] },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("cycle");
  });

  test("synthesize 够不着的 delegate 被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "b", kind: "delegate", title: "B", prompt: "任务", agent: "x" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("cannot reach");
  });

  test("自依赖被拒", () => {
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", dependsOn: ["a"] },
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("itself");
  });
});

describe("提案状态机", () => {
  test("proposing → proposed → running,驳回回到 proposing 带意见", () => {
    const base = createWorkflowRun("t1", "目标");
    expect(base.status).toBe("proposing");
    const checked2 = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总 {{a}}", dependsOn: ["a"] },
    ]);
    if (!checked2.ok) throw new Error(checked2.reason);
    const proposed = acceptProposal(base, checked2.steps, "标题");
    expect(proposed.status).toBe("proposed");
    expect(proposed.steps["a"]!.status).toBe("pending");
    expect(confirmedProposalStatus(proposed)).toBe("running");

    const rejected = rejectProposal(proposed, "步骤太多");
    expect(rejected?.status).toBe("proposing");
    expect(rejected?.proposalFeedback).toBe("步骤太多");
    expect(rejected?.plan).toBeUndefined();
    // 终态不可恢复
    const done = transitionRun(confirmedProposal(proposed), "complete", { summary: "x" });
    expect(done?.status).toBe("complete");
    expect(resumeRun(done!)).toBeUndefined();
  });

  test("过期护栏:expectedRunId 不匹配的迁移被拒", () => {
    const { run } = runWithPlan();
    const started = confirmProposal(run)!;
    expect(transitionRun(started, "paused", { expectedRunId: "wf-other" })).toBeUndefined();
    const paused = transitionRun(started, "paused", { expectedRunId: started.id, reason: "test" });
    expect(paused?.status).toBe("paused");
    expect(paused?.pauseReason).toBe("test");
  });
});

describe("就绪调度与指纹", () => {
  test("依赖全 done 才就绪", () => {
    const { run } = runWithPlan();
    expect(readyStepKeys(run).sort()).toEqual(["a", "b"]);
    const afterA = settleStep(run, "a", { status: "done", fingerprint: "fa" });
    expect(readyStepKeys(afterA)).toEqual(["b"]);
    const afterB = settleStep(afterA, "b", { status: "done", fingerprint: "fb" });
    expect(readyStepKeys(afterB)).toEqual(["s"]);
  });

  test("指纹:声明变了指纹变;依赖指纹链变了指纹变", () => {
    const { steps } = runWithPlan();
    const synth = steps[2]!;
    const fp1 = stepFingerprint(synth, ["fa1", "fb1"]);
    const fp2 = stepFingerprint(synth, ["fa1", "fb1"]);
    expect(fp1).toBe(fp2); // 同内容同指纹(幂等)
    expect(stepFingerprint(synth, ["fa1", "fb2"])).not.toBe(fp1); // 依赖变了
    expect(
      stepFingerprint({ ...synth, prompt: "改过的指令" }, ["fa1", "fb1"]),
    ).not.toBe(fp1); // 声明变了
  });
});

describe("插值", () => {
  test("{{key}} 换上游结果,未知 key 留标记", () => {
    const out = interpolatePrompt("汇总 {{a}} 与 {{b}} 与 {{ghost}}", (k) =>
      k === "a" ? "A 报告" : k === "b" ? "B 报告" : undefined,
    );
    expect(out).toContain("A 报告");
    expect(out).toContain("B 报告");
    expect(out).toContain("<missing step result: ghost>");
  });

  test("超长单值插值被截断并留上游标记", () => {
    const big = "x".repeat(MAX_INTERPOLATED_PROMPT_CHARS + 1000);
    const out = interpolatePrompt("报告:{{a}}", () => big);
    // 单值上限先截:整条不会超,标记是「上游结果截断」
    expect(out.length).toBeLessThanOrEqual(MAX_INTERPOLATED_PROMPT_CHARS);
    expect(out).toContain("[upstream result truncated]");
  });

  test("多个中等插值撑爆整条 prompt 时整体截断", () => {
    const chunk = "y".repeat(MAX_INTERPOLATED_PROMPT_CHARS / 2 + 100); // 单值内,整条超
    const out = interpolatePrompt("{{a}}{{b}}{{c}}", () => chunk);
    expect(out.length).toBeLessThanOrEqual(MAX_INTERPOLATED_PROMPT_CHARS);
    expect(out).toContain("[prompt truncated]");
  });
});

describe("记账与展示", () => {
  test("tokens 累加只吃正数", () => {
    const { run } = runWithPlan();
    expect(addTokens(run, 100).tokensUsed).toBe(100);
    expect(addTokens(run, -5).tokensUsed).toBe(0);
    expect(addTokens(run, Number.NaN).tokensUsed).toBe(0);
  });

  test("statusLine 覆盖各状态", () => {
    const { run } = runWithPlan();
    expect(formatWorkflowStatus(run)).toContain("待你确认");
    const started = confirmProposal(run)!;
    expect(formatWorkflowStatus(started)).toContain("运行中 0/3 步");
    const one = settleStep(started, "a", { status: "running" });
    expect(formatWorkflowStatus(one)).toContain("并发 1");
  });

  test("hasOpenSteps:running/pending 算开账", () => {
    const { run } = runWithPlan();
    expect(hasOpenSteps(run)).toBe(true);
    let settled = run;
    for (const key of ["a", "b", "s"]) settled = settleStep(settled, key, { status: "done" });
    expect(hasOpenSteps(settled)).toBe(false);
  });
});

describe("isWorkflowRun(盘上形状守卫)", () => {
  test("合法/畸形行", () => {
    const { run } = runWithPlan();
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBe(true);
    expect(isWorkflowRun({ id: "x" })).toBe(false);
    expect(isWorkflowRun(null)).toBe(false);
    expect(isWorkflowRun({ ...run, status: "bogus" })).toBe(false);
  });
});

/* 辅助:确认提案(仅测试内使用) */
function confirmedProposal(run: WorkflowRunForTest) {
  const next = confirmProposal(run);
  if (!next) throw new Error("confirm failed");
  return next;
}
type WorkflowRunForTest = ReturnType<typeof createWorkflowRun>;
function confirmedProposalStatus(run: { status: string }): string {
  return run.status === "proposed" ? "running" : run.status;
}
