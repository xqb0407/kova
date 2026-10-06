import { describe, expect, test } from "bun:test";
import {
  deriveArgsFromSteps,
  playbookSteps,
  validatePlaybookArgs,
} from "../../src/workflow/library";
import { validatePlan, type WorkflowStep } from "../../src/workflow/plan-state";
import type { Playbook } from "pi-protocol";

function stepsFrom(raw: unknown[]): WorkflowStep[] {
  const checked = validatePlan(raw);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.steps;
}

describe("剧本参数:提取与校验", () => {
  test("deriveArgsFromSteps:扫 {{args.NAME}} 去重保序,非参数占位符不误收", () => {
    const steps = stepsFrom([
      {
        key: "a",
        kind: "delegate",
        title: "A",
        prompt: "回溯 {{args.months}} 个月,输出到 {{args.outDir}};上游 {{a}} 与 {{item}} 不算参数",
        agent: "x",
      },
      {
        key: "s",
        kind: "synthesize",
        title: "S",
        prompt: "再提一次 {{args.months}} 与 {{ args.extra }}",
        dependsOn: ["a"],
      },
    ]);
    expect(deriveArgsFromSteps(steps).map((a) => a.name)).toEqual(["months", "outDir", "extra"]);
  });

  test("validatePlaybookArgs:必填缺失报错、默认值填充、类型转换", () => {
    const decls = [
      { name: "months", type: "number" as const, required: true },
      { name: "outDir", type: "string" as const, default: "out/report" },
      { name: "verbose", type: "boolean" as const },
    ];
    const missing = validatePlaybookArgs(decls, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]).toContain("months");

    const ok = validatePlaybookArgs(decls, { months: "24", verbose: "1" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.values).toEqual({ months: 24, outDir: "out/report", verbose: true });
    }

    const bad = validatePlaybookArgs(decls, { months: "很多" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain("数字");
  });

  test("playbookSteps:库里的步骤要过同一个提案校验", () => {
    const playbook: Playbook = {
      id: "pb-1",
      name: "审查",
      description: "审一遍",
      steps: [
        { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "x", dependsOn: [] },
        { key: "s", kind: "synthesize", title: "S", prompt: "汇总 {{a}}", dependsOn: ["a"] },
      ],
      args: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(playbookSteps(playbook)).toHaveLength(2);

    const broken: Playbook = { ...playbook, steps: [{ key: "a", kind: "synthesize", title: "S", prompt: "无依赖", dependsOn: [] }] };
    expect(() => playbookSteps(broken)).toThrow(/invalid/);
  });
});
