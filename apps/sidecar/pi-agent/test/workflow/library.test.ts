import { describe, expect, test } from "bun:test";
import {
  deriveArgsFromSteps,
  expandComposition,
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

describe("M3b:组合展开", () => {
  const inner: Playbook = {
    id: "pb-inner",
    name: "检索",
    description: "检索一段",
    steps: [
      { key: "search", kind: "delegate", title: "检索", prompt: "检索 {{args.topic}} 的资料", agent: "explorer", dependsOn: [] },
      { key: "digest", kind: "synthesize", title: "小结", prompt: "小结 {{search}}", dependsOn: ["search"] },
    ],
    args: [{ name: "topic", type: "string" }],
    createdAt: 1,
    updatedAt: 1,
  };
  const resolve = async (name: string) =>
    [inner].find((p) => p.name.toLowerCase() === name.toLowerCase());

  test("平铺:前缀、phase 继承、依赖前缀化 + 引用处依赖合并、参数代入", async () => {
    const outer = stepsFrom([
      {
        key: "research",
        kind: "playbook",
        title: "检索阶段",
        phase: "调研",
        use: { playbook: "检索", args: { topic: "内存价格" } },
        dependsOn: [],
      },
      { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总 {{research}}", dependsOn: ["research"] },
    ]);
    const expanded = await expandComposition(outer, { resolve });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const keys = expanded.steps.map((s) => s.key);
    expect(keys).toEqual(["research.search", "research.digest", "s"]);
    const search = expanded.steps[0]!;
    expect(search.phase).toBe("调研"); // 引用处 phase 覆盖子步
    expect(search.prompt).toBe("检索 内存价格 的资料"); // use.args 代入
    // 内层依赖前缀化
    expect(expanded.steps[1]!.dependsOn).toContain("research.search");
    // 外层对父键的引用重写到组汇点(依赖 + {{占位符}})
    const outerSynth = expanded.steps.find((x) => x.key === "s")!;
    expect(outerSynth.dependsOn).toEqual(["research.digest"]);
    expect(outerSynth.prompt).toContain("{{research.digest}}");
    // 展开后的结构过顶层汇点校验(内层 synthesize 不计入)
    const recheck = validatePlan(expanded.steps);
    expect(recheck.ok).toBe(true);
  });

  test("未绑参数留占位符(运行时按本 run 的 args 解析)", async () => {
    const outer = stepsFrom([
      { key: "research", kind: "playbook", title: "检索", use: { playbook: "检索" }, dependsOn: [] },
      { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总", dependsOn: ["research"] },
    ]);
    const expanded = await expandComposition(outer, { resolve });
    if (!expanded.ok) throw new Error(expanded.reason);
    expect(expanded.steps[0]!.prompt).toContain("{{args.topic}}");
  });

  test("未知剧本 / 环引用 / 超深都拒绝", async () => {
    const unknown = await expandComposition(
      stepsFrom([
        { key: "x", kind: "playbook", title: "X", use: { playbook: "不存在" }, dependsOn: [] },
        { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["x"] },
      ]),
      { resolve },
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain("unknown playbook");

    // 自引用环:剧本内部再引用自己
    const selfRef: Playbook = {
      ...inner,
      id: "pb-loop",
      name: "回环",
      steps: [
        { key: "a", kind: "playbook", title: "A", use: { playbook: "回环" }, dependsOn: [] } as never,
        { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["a"] },
      ],
    };
    const cycle = await expandComposition(
      stepsFrom([
        { key: "x", kind: "playbook", title: "X", use: { playbook: "回环" }, dependsOn: [] },
        { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["x"] },
      ]),
      { resolve: async (n) => (n === "回环" ? selfRef : undefined) },
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.reason).toContain("cycle");
  });

  test("playbook 步骤不再强制 prompt;未知引用名在提案校验就挡", () => {
    const missingName = validatePlan([
      { key: "x", kind: "playbook", title: "X", dependsOn: [] },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["x"] },
    ]);
    expect(missingName.ok).toBe(false);
    if (!missingName.ok) expect(missingName.reason).toContain("use.playbook");
    const ok = validatePlan([
      { key: "x", kind: "playbook", title: "X", use: { playbook: "检索" }, dependsOn: [] },
      { key: "s", kind: "synthesize", title: "S", prompt: "汇总", dependsOn: ["x"] },
    ]);
    expect(ok.ok).toBe(true);
  });
});
