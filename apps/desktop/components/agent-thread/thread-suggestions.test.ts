/**
 * 欢迎建议规划测试：模式筛选（组与条目）、主场组排序、时段专属、git 置顶
 * 与工作区模板。时钟/仓库状态都由参数喂进来，纯函数直接断言。
 */
import { describe, expect, test } from "bun:test";
import { planSuggestions } from "./thread-suggestions";

/** 固定一个下午的时刻（13 点后 = afternoon 时段），避免测试随跑的时间漂移 */
const at = (hour: number) => new Date(2026, 9, 8, hour, 30);

const base = {
  now: at(15),
  wsName: null,
  gitReady: false,
  gitDirty: null,
  gitAhead: null,
};

const labelsOf = (groups: ReturnType<typeof planSuggestions>) =>
  groups.map((g) => g.label);
const optionsOf = (groups: ReturnType<typeof planSuggestions>, label: string) =>
  groups.find((g) => g.label === label)?.options.map((o) => o.label) ?? [];

describe("planSuggestions", () => {
  test("编码档：含写代码，不含办公/设计，且写代码排最前", () => {
    const groups = planSuggestions({ ...base, appMode: "code" });
    const labels = labelsOf(groups);
    expect(labels[0]).toBe("写代码");
    expect(labels).not.toContain("办公");
    expect(labels).not.toContain("设计");
    expect(labels).toContain("插件");
    expect(labels).toContain("分析");
  });

  test("工作档：含办公且排最前，不含写代码/设计", () => {
    const groups = planSuggestions({ ...base, appMode: "work" });
    const labels = labelsOf(groups);
    expect(labels[0]).toBe("办公");
    expect(labels).not.toContain("写代码");
    expect(labels).not.toContain("设计");
    // 通用组仍在
    expect(labels).toEqual(expect.arrayContaining(["插件", "分析", "写作", "灵感"]));
  });

  test("设计档：含设计且排最前，不含写代码/办公", () => {
    const groups = planSuggestions({ ...base, appMode: "design" });
    const labels = labelsOf(groups);
    expect(labels[0]).toBe("设计");
    expect(labels).not.toContain("写代码");
    expect(labels).not.toContain("办公");
    expect(labels).toEqual(expect.arrayContaining(["插件", "分析", "写作", "灵感"]));
  });

  test("条目级筛选：模式专属条目只在自己那档出现", () => {
    const code = planSuggestions({ ...base, appMode: "code" });
    const work = planSuggestions({ ...base, appMode: "work" });
    const design = planSuggestions({ ...base, appMode: "design" });

    // 「算一笔数 / 两版方案对比」是工作档专属的分析
    expect(optionsOf(work, "分析")).toEqual(
      expect.arrayContaining(["算一笔数", "两版方案对比"]),
    );
    expect(optionsOf(code, "分析")).not.toContain("算一笔数");
    expect(optionsOf(code, "分析")).not.toContain("竞品在怎么做");
    expect(optionsOf(design, "分析")).toContain("竞品在怎么做");
    expect(optionsOf(design, "分析")).not.toContain("补单元测试");

    // 「写 PR 描述」只在编码档
    expect(optionsOf(work, "写作")).not.toContain("写 PR 描述");
    expect(optionsOf(code, "写作")).toContain("写 PR 描述");
  });

  test("每组都有内容、且不超过每页上限", () => {
    for (const appMode of ["code", "work", "design"] as const) {
      const groups = planSuggestions({ ...base, appMode });
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group.options.length).toBeGreaterThan(0);
        expect(group.options.length).toBeLessThanOrEqual(5);
      }
    }
  });

  test("时段专属条目只在对应时段出现", () => {
    const night = planSuggestions({ ...base, now: at(23), appMode: "code" });
    expect(optionsOf(night, "灵感")).toContain("总结今天");
    const afternoon = planSuggestions({ ...base, now: at(15), appMode: "code" });
    expect(optionsOf(afternoon, "灵感")).not.toContain("总结今天");
  });

  test("git 置顶只在编码档生效，且带上具体数字", () => {
    const dirty = { gitReady: true, gitDirty: 3, gitAhead: 2 };
    const code = planSuggestions({ ...base, ...dirty, appMode: "code" });
    const codeOptions = optionsOf(code, "写代码");
    expect(codeOptions[0]).toBe("审查未提交改动");
    expect(
      code.find((g) => g.label === "写代码")?.options[0].prompt,
    ).toContain("3 个文件");

    // 工作档：git 建议不该占据位置（连入口都不该有）
    const work = planSuggestions({ ...base, ...dirty, appMode: "work" });
    expect(labelsOf(work)).not.toContain("写代码");
  });

  test("案例卡片的数据随规划一起带出来（说明 + 示意图）", () => {
    const work = planSuggestions({ ...base, appMode: "work" });
    const cards = work[0].options;
    expect(work[0].label).toBe("办公");
    for (const card of cards) {
      expect(card.hint.length).toBeGreaterThan(0);
      expect(card.art).toBeTruthy();
    }
    // 抽查两条：说明是"点了会得到什么"，图是各自那类活
    const mail = work[0].options.find((o) => o.label === "起草一封邮件");
    expect(mail?.hint).toBe("专业但不生硬");
    expect(mail?.art).toBe("mail");
    const code = planSuggestions({ ...base, appMode: "code" });
    expect(
      code.flatMap((g) => g.options).find((o) => o.label === "设计一个接口")?.art,
    ).toBe("api");
  });

  test("工作区模板：选了目录就把 {ws} 换成目录名", () => {
    const withWs = planSuggestions({
      ...base,
      wsName: "ai-teamplte",
      appMode: "code",
    });
    const overview = withWs
      .find((g) => g.label === "分析")
      ?.options.find((o) => o.label === "项目结构总览");
    // 当日轮换可能把它挤出前 5 条，只要出现就必须已替换
    if (overview) expect(overview.prompt).toContain("「ai-teamplte」");
    expect(withWs.every((g) => g.options.every((o) => !o.prompt.includes("{ws}")))).toBe(true);
  });
});
