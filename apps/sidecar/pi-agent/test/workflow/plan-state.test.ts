import { describe, expect, test } from "bun:test";
import {
  acceptProposal,
  addTokens,
  allStepsSettled,
  confirmProposal,
  createWorkflowRun,
  expandForeach,
  replayJournal,
  formatWorkflowStatus,
  hasOpenSteps,
  hydrateRestoredRun,
  interpolatePrompt,
  isWorkflowRun,
  readyStepKeys,
  rejectProposal,
  resolveStepPrompt,
  resumeRun,
  settleForeachParent,
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
    if (!checked.ok) expect(checked.reason).toContain("exactly one top-level synthesize");
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

describe("M2:gate / verify 校验", () => {
  test("gate 需要字面量 command", () => {
    const missing = validatePlan([
      { key: "g", kind: "gate", title: "测试", prompt: "确认测试通过" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总 {{g}}", dependsOn: ["g"] },
    ]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("gate.command");

    const ok = validatePlan([
      {
        key: "g",
        kind: "gate",
        title: "测试",
        prompt: "确认测试通过",
        gate: { command: "bun", args: ["test"], timeoutMs: 300000 },
      },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["g"] },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.steps[0]!.gate).toEqual({ command: "bun", args: ["test"], timeoutMs: 300000 });
  });

  test("gate 超时越界被拒", () => {
    const r = validatePlan([
      { key: "g", kind: "gate", title: "G", prompt: "p", gate: { command: "ls", timeoutMs: 10 } },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["g"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("timeoutMs");
  });

  test("verify 需要依赖 + 人数/阈值边界", () => {
    const noDep = validatePlan([
      { key: "v", kind: "verify", title: "V", prompt: "复核", verify: {} },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["v"] },
    ]);
    expect(noDep.ok).toBe(false);
    if (!noDep.ok) expect(noDep.reason).toContain("depend on");

    const badCount = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "v", kind: "verify", title: "V", prompt: "复核 {{a}}", dependsOn: ["a"], verify: { reviewers: 9 } },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["v"] },
    ]);
    expect(badCount.ok).toBe(false);
    if (!badCount.ok) expect(badCount.reason).toContain("reviewers");

    const badThreshold = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "v", kind: "verify", title: "V", prompt: "复核 {{a}}", dependsOn: ["a"], verify: { threshold: 0 } },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["v"] },
    ]);
    expect(badThreshold.ok).toBe(false);
    if (!badThreshold.ok) expect(badThreshold.reason).toContain("threshold");

    const ok = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "v", kind: "verify", title: "V", prompt: "复核 {{a}}", dependsOn: ["a"] },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总 {{v}}", dependsOn: ["v"] },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.steps[1]!.verify).toEqual({ reviewers: 2, threshold: 0.5 });
  });

  test("onFail:skip 只允许 delegate/verify;synthesize/gate 拒绝", () => {
    const synthSkip = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"], onFail: "skip" },
    ]);
    expect(synthSkip.ok).toBe(false);
    if (!synthSkip.ok) expect(synthSkip.reason).toContain("skip");

    const gateSkip = validatePlan([
      { key: "g", kind: "gate", title: "G", prompt: "p", gate: { command: "ls" }, onFail: "skip" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["g"] },
    ]);
    expect(gateSkip.ok).toBe(false);

    const ok = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", onFail: "skip", retries: 2 },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.steps[0]!.onFail).toBe("skip");
      expect(ok.steps[0]!.retries).toBe(2);
    }
  });

  test("retries 越界被拒", () => {
    const r = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", retries: 9 },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(r.ok).toBe(false);
  });

  test("gate/verify 够不着 synthesize 也被拒", () => {
    const r = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x" },
      { key: "g", kind: "gate", title: "G", prompt: "p", gate: { command: "ls" } },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cannot reach");
  });
});

describe("M2:foreach 展开与父条目结算", () => {
  function foreachRun() {
    const run = createWorkflowRun("t1", "批量翻译");
    const checked = validatePlan([
      { key: "list", kind: "delegate", title: "列清单", prompt: "列出文件", agent: "explorer" },
      {
        key: "each",
        kind: "delegate",
        title: "逐个处理",
        prompt: "处理这一项:{{item}}",
        agent: "fixer",
        foreach: { from: "list" },
      },
      { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总 {{each}}", dependsOn: ["each"] },
    ]);
    if (!checked.ok) throw new Error(checked.reason);
    let wf = acceptProposal(run, checked.steps, "批量");
    // list 结算:结果三行(含空行与空白,应被过滤)
    wf = settleStep(wf, "list", { status: "done", result: "a.ts\n\n  b.ts  \nc.ts\n", fingerprint: "fl" });
    return wf;
  }

  test("foreach.from 自动进依赖", () => {
    const wf = foreachRun();
    const step = wf.plan!.steps.find((s) => s.key === "each")!;
    expect(step.dependsOn).toContain("list");
    expect(step.foreach).toEqual({ from: "list" });
  });

  test("展开:逐行成子项,父挂 children 转 running,子项指纹/调度就绪", () => {
    const wf = foreachRun();
    const expanded = expandForeach(wf, "each");
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.expanded).toBe(3);
    expect(expanded.run.steps["each#0"]!.item).toBe("a.ts");
    expect(expanded.run.steps["each#2"]!.item).toBe("c.ts");
    expect(expanded.run.steps["each"]!.children).toEqual(["each#0", "each#1", "each#2"]);
    expect(expanded.run.steps["each"]!.status).toBe("running");
    // 父不再被调度;子项就绪;依赖父的 synthesize 尚未就绪
    expect(readyStepKeys(expanded.run)).toEqual(["each#0", "each#1", "each#2"]);
  });

  test("展开幂等:已展开的父不再展开", () => {
    const wf = foreachRun();
    const first = expandForeach(wf, "each");
    if (!first.ok) throw new Error(first.reason);
    const second = expandForeach(first.run, "each");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.expanded).toBe(0);
  });

  test("上游无项 → 展开失败(空产出不静默成空批次)", () => {
    let wf = foreachRun();
    wf = settleStep(wf, "list", { status: "done", result: "   \n\n", fingerprint: "fl" });
    const r = expandForeach(wf, "each");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no listable items");
  });

  test("子项全 done → 父 done,结果按序拼合含项标题", () => {
    const wf = foreachRun();
    const expanded = expandForeach(wf, "each");
    if (!expanded.ok) throw new Error(expanded.reason);
    let wf2 = expanded.run;
    wf2 = settleStep(wf2, "each#0", { status: "done", result: "A 结果" });
    wf2 = settleStep(wf2, "each#1", { status: "skipped", error: "provider down" });
    wf2 = settleForeachParent(wf2, "each#1");
    expect(wf2.steps["each"]!.status).toBe("running"); // 还差一个
    wf2 = settleStep(wf2, "each#2", { status: "done", result: "C 结果" });
    wf2 = settleForeachParent(wf2, "each#2");
    expect(wf2.steps["each"]!.status).toBe("done");
    expect(wf2.steps["each"]!.result).toContain("A 结果");
    expect(wf2.steps["each"]!.result).toContain("skipped: provider down");
    expect(wf2.steps["each"]!.error).toContain("1/3 items skipped");
    // 依赖已满足,汇总结算就绪
    expect(readyStepKeys(wf2)).toEqual(["s"]);
  });

  test("子项失败(非 skip)→ 父 failed", () => {
    const wf = foreachRun();
    const expanded = expandForeach(wf, "each");
    if (!expanded.ok) throw new Error(expanded.reason);
    let wf2 = expanded.run;
    wf2 = settleStep(wf2, "each#0", { status: "failed", error: "崩溃" });
    wf2 = settleForeachParent(wf2, "each#0");
    expect(wf2.steps["each"]!.status).toBe("failed");
    expect(wf2.steps["each"]!.error).toContain("each#0");
  });

  test("prompt 解析:{{item}} 与上游 {{key}},skip 依赖出显式缺口", () => {
    const wf = foreachRun();
    const expanded = expandForeach(wf, "each");
    if (!expanded.ok) throw new Error(expanded.reason);
    const step = expanded.run.plan!.steps.find((s) => s.key === "each")!;
    expect(resolveStepPrompt(expanded.run, step, "each#1")).toBe("处理这一项:b.ts");
    // synthesize 的 {{each}} 在父 done 后取拼合结果
    let wf2 = settleStep(expanded.run, "each#1", { status: "done", result: "B 结果" });
    wf2 = settleStep(wf2, "each#0", { status: "done", result: "A" });
    wf2 = settleStep(wf2, "each#2", { status: "done", result: "C" });
    wf2 = settleForeachParent(wf2, "each#2");
    const synth = wf2.plan!.steps.find((s) => s.key === "s")!;
    expect(resolveStepPrompt(wf2, synth, "s")).toContain("B 结果");
    // skip 的依赖在插值处出显式标记
    const wf3 = settleStep(wf2, "each", { status: "skipped", error: "手动跳过" });
    expect(resolveStepPrompt(wf3, synth, "s")).toContain('was skipped');
  });

  test("allStepsSettled:skipped 计入终态;父未结算不算", () => {
    const wf = foreachRun();
    expect(allStepsSettled(wf)).toBe(false);
    const expanded = expandForeach(wf, "each");
    if (!expanded.ok) throw new Error(expanded.reason);
    let wf2 = expanded.run;
    for (const k of ["each#0", "each#1", "each#2"]) wf2 = settleStep(wf2, k, { status: "skipped" });
    wf2 = settleForeachParent(wf2, "each#2");
    wf2 = settleStep(wf2, "list", { status: "done", result: "x" });
    expect(allStepsSettled(wf2)).toBe(false); // synthesize 还没跑
    wf2 = settleStep(wf2, "s", { status: "done", result: "报告" });
    expect(allStepsSettled(wf2)).toBe(true);
  });
});

describe("M3:剧本参数(args)", () => {
  test("{{args.key}} 替换;未提供的参数留显式缺口", () => {
    const run = createWorkflowRun("t1", "参数化");
    const checked = validatePlan([
      { key: "a", kind: "delegate", title: "A", prompt: "回溯 {{args.months}} 个月", agent: "x" },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总 {{a}}", dependsOn: ["a"] },
    ]);
    if (!checked.ok) throw new Error(checked.reason);
    let wf = acceptProposal(run, checked.steps, "参数化");
    wf = { ...wf, args: { months: 24 } };
    const step = wf.plan!.steps[0]!;
    expect(resolveStepPrompt(wf, step, "a")).toBe("回溯 24 个月");
    // 未提供的参数 → 显式缺口(静默留空会把缺口当事实)
    const missing = { ...wf, args: {} };
    expect(resolveStepPrompt(missing, step, "a")).toContain("<missing arg: months>");
  });

  test("指纹纳入参数种子:换参数 = 不同指纹(不会错误命中旧缓存)", () => {
    const { steps } = runWithPlan();
    const step = steps[0]!;
    const fp1 = stepFingerprint(step, [], '{"months":24}');
    const fp2 = stepFingerprint(step, [], '{"months":12}');
    const fp3 = stepFingerprint(step, [], '{"months":24}');
    expect(fp1).toBe(fp3);
    expect(fp1).not.toBe(fp2);
  });
});

describe("gate 形状容忍(实机:弱模型把 command 写在步骤顶层,折腾六轮)", () => {
  const withGate = (gateStep: Record<string, unknown>) => [
    { key: "a", kind: "delegate", title: "调研", prompt: "做调研", agent: "Explorer" },
    gateStep,
    { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总 {{a}}", dependsOn: ["a", "g"] },
  ];

  test("顶层 command/args 被归一进 gate(能跑就不让用户等)", () => {
    const checked = validatePlan(
      withGate({
        key: "g",
        kind: "gate",
        title: "报告存在性校验",
        prompt: "确认报告已产出",
        command: "ls",
        args: ["market-research/06-report.md"],
      }),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const gate = checked.steps.find((x) => x.key === "g")!.gate;
    expect(gate?.command).toBe("ls");
    expect(gate?.args).toEqual(["market-research/06-report.md"]);
  });

  test("嵌套形态优先于顶层(两者都在时)", () => {
    const checked = validatePlan(
      withGate({
        key: "g",
        kind: "gate",
        title: "门",
        prompt: "判定",
        command: "顶层不应生效",
        gate: { command: "test", args: ["-s", "x"] },
      }),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.steps.find((x) => x.key === "g")!.gate?.command).toBe("test");
  });

  test("真缺命令时,报错给出嵌套形状(自解释的诊断)", () => {
    const checked = validatePlan(withGate({ key: "g", kind: "gate", title: "门", prompt: "判定" }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toContain('nested "gate" object');
    expect(checked.reason).toContain('{"kind":"gate"');
  });
});

describe("接线守卫(实机:漏传一处回调,「启动即写 delegationId」静默失效)", () => {
  test("runner 的重试循环必须把 onDelegationsStarted 透传下去", async () => {
    // 这处漏传过一次:delegationId 只在结算时写,运行中的节点没有委派 id,
    // 点节点开不出实时输出面板。纯接线问题,单测覆盖不到执行链,用结构断言兜住。
    const src = await Bun.file(
      new URL("../../src/workflow/runner.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain(
      "executeStepAttempt(run, step, wf, key, attempt, timeoutMs, onDelegationsStarted)",
    );
  });

  test("verify 的评审 id 必须在 await 之前报出(否则运行中的复核点不开面板)", async () => {
    const src = await Bun.file(
      new URL("../../src/workflow/runner.ts", import.meta.url).pathname,
    ).text();
    const call = src.indexOf("onDelegationsStarted?.(reviewerIds)");
    const awaitAt = src.indexOf("const results = await resultsPromise");
    expect(call).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(call).toBeLessThan(awaitAt);
  });

  test("步骤(重)启动时清掉上一次的 endedAt(否则「已 Xs」算成 0s)", async () => {
    const src = await Bun.file(
      new URL("../../src/workflow/runner.ts", import.meta.url).pathname,
    ).text();
    const start = src.indexOf('status: "running",\n        fingerprint,');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 320)).toContain("endedAt: undefined");
  });
});

describe("恢复重放(实机:wf-muxx6qbo 的 8 个 foreach 子项全 interrupted → 就绪缺口停摆)", () => {
  /** 一个 foreach 父步 + 8 个已展开子项的最小现场 */
  const foreachRun = () => {
    const checked = validatePlan([
      { key: "plan", kind: "delegate", title: "选题", prompt: "定题", agent: "Explorer" },
      {
        key: "gather",
        kind: "delegate",
        title: "并行调研",
        prompt: "调研 {{item}}",
        agent: "Explorer",
        foreach: { from: "plan" },
        dependsOn: ["plan"],
      },
      { key: "report", kind: "synthesize", title: "汇总", prompt: "汇总 {{plan}}", dependsOn: ["gather"] },
    ]);
    if (!checked.ok) throw new Error(checked.reason);
    const run = confirmProposal(acceptProposal(createWorkflowRun("t-replay", "调研"), checked.steps, "调研"))!;
    const withPlanDone = settleStep(run, "plan", { status: "done", result: "选题：半导体", fingerprint: "fp-plan" });
    const expanded = expandForeach(withPlanDone, "gather");
    if (!expanded.ok) throw new Error(expanded.reason);
    return expanded.run;
  };

  test("展开后的子项是 running 残影 → 重放回 pending(不再永远 interrupted)", () => {
    const run = foreachRun();
    const children = run.steps.gather!.children!;
    expect(children).toHaveLength(1); // 「选题：半导体」一行 = 一个子项
    const stale: typeof run = {
      ...run,
      steps: {
        ...run.steps,
        [children[0]!]: { ...run.steps[children[0]!]!, status: "interrupted" },
      },
    };
    const { run: replayed } = replayJournal(stale);
    expect(replayed.steps[children[0]!]!.status).toBe("pending");
    // 父步回到容器态 running(它不再被调度,等子项),不是 pending
    expect(replayed.steps.gather!.status).toBe("running");
  });

  /** 声明里的某一步(真指纹要用声明本身算,不能用字面量冒充) */
  const decl = (run: ReturnType<typeof foreachRun>, key: string) =>
    run.plan!.steps.find((x) => x.key === key)!;

  test("子项全部 done → 父步直接收口为 done(不靠下一次结算触发)", () => {
    const run = foreachRun();
    const child = run.steps.gather!.children![0]!;
    const childFp = stepFingerprint(decl(run, "gather"), [run.steps.plan!.fingerprint ?? ""], "{}");
    const allDone = {
      ...run,
      steps: {
        ...run.steps,
        [child]: { ...run.steps[child]!, status: "done" as const, result: "取材完成", fingerprint: childFp },
      },
    };
    const { run: replayed } = replayJournal(allDone);
    expect(replayed.steps.gather!.status).toBe("done");
  });

  test("done 且指纹一致保留(0 token 回放);指纹缺失 → 重跑", () => {
    const run = foreachRun();
    const planFp = stepFingerprint(decl(run, "plan"), [], "{}");
    const withReal = settleStep(run, "plan", { status: "done", result: "x", fingerprint: planFp });
    expect(replayJournal(withReal).run.steps.plan!.status).toBe("done");
    const noFp = { ...withReal, steps: { ...withReal.steps, plan: { ...withReal.steps.plan!, fingerprint: undefined } } };
    expect(replayJournal(noFp).run.steps.plan!.status).toBe("pending");
  });
});

describe("恢复水合(审计缺陷 1 的修复点)", () => {
  const fullRun = () => {
    const wf = runWithPlan().run;
    const started = confirmProposal(wf)!;
    return settleStep(started, "a", { status: "done", result: "A 的结果", fingerprint: "fa" });
  };

  test("行带 cwd 且 run 文件存在 → 以文件为准(结果与指纹都在)", () => {
    const file = fullRun();
    const slimRow = { ...file, cwd: "/tmp/ws", steps: { a: { key: "a", status: "done" } } };
    let cwdSeen: string | undefined;
    const hydrated = hydrateRestoredRun(slimRow, (cwd, id) => {
      cwdSeen = cwd;
      return id === file.id ? file : undefined;
    });
    expect(hydrated?.steps["a"]?.result).toBe("A 的结果");
    expect(hydrated?.steps["a"]?.fingerprint).toBe("fa");
    expect(cwdSeen).toBe("/tmp/ws");
  });

  test("文件水合成功不带不可用标记(结果与指纹都在)", () => {
    const file = fullRun();
    const slimRow = { ...file, cwd: "/tmp/ws", steps: { a: { key: "a", status: "done" } } };
    const hydrated = hydrateRestoredRun(slimRow, () => file);
    expect(hydrated?.resultsUnavailable).toBeUndefined();
  });

  test("文件缺失/runId 不一致 → 退回瘦身行(状态可读,结果不可用)", () => {
    const file = fullRun();
    const slimRow = { ...file, cwd: "/tmp/ws", steps: { a: { key: "a", status: "done" } } };
    const missing = hydrateRestoredRun(slimRow, () => undefined);
    expect(missing?.steps["a"]?.status).toBe("done");
    expect(missing?.steps["a"]?.result).toBeUndefined();
    // 显式标注结果不可用:UI 据此提示「相关步骤将重跑」,而不是把缺口显示成「还没跑到」
    expect(missing?.resultsUnavailable).toBe(true);
    const mismatch = hydrateRestoredRun(slimRow, () => ({ ...file, id: "wf-other" }));
    expect(mismatch?.steps["a"]?.result).toBeUndefined();
    expect(mismatch?.resultsUnavailable).toBe(true);
  });

  test("无 cwd 的旧行 → 退回瘦身行(同样标注不可用);畸形行 → undefined", () => {
    const file = fullRun();
    const noCwd = hydrateRestoredRun({ ...file, steps: {} }, () => file);
    expect(noCwd).toBeDefined();
    expect(noCwd?.steps["a"]).toBeUndefined();
    expect(noCwd?.resultsUnavailable).toBe(true);
    expect(hydrateRestoredRun({ id: "x" }, () => undefined)).toBeUndefined();
    expect(hydrateRestoredRun(null, () => undefined)).toBeUndefined();
  });
});
