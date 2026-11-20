import { describe, expect, test } from "bun:test";
import { ConsoleMessageBudget } from "../main/browser-console-budget";

describe("ConsoleMessageBudget", () => {
  test("窗口内到额即拒，并累计 dropped", () => {
    let now = 1_000;
    const budget = new ConsoleMessageBudget(3, 1_000, () => now);
    expect([budget.allow(), budget.allow(), budget.allow(), budget.allow()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(budget.takeDropped()).toBe(1);
    expect(budget.takeDropped()).toBe(0);
  });

  test("下一窗口重新放行", () => {
    let now = 1_000;
    const budget = new ConsoleMessageBudget(2, 1_000, () => now);
    budget.allow();
    budget.allow();
    expect(budget.allow()).toBe(false);
    now += 1_000;
    expect(budget.allow()).toBe(true);
    expect(budget.takeDropped()).toBe(1);
  });

  test("按最近 1s 滑动，不在固定边界整窗清零", () => {
    let now = 0;
    const budget = new ConsoleMessageBudget(2, 1_000, () => now);
    expect(budget.allow()).toBe(true); // t=0
    now = 999;
    expect(budget.allow()).toBe(true); // t=999，窗口内已有 2 条
    expect(budget.allow()).toBe(false); // 仍是 t=999，第 3 条拒绝
    now = 1_000;
    expect(budget.allow()).toBe(true); // t=0 那条滑出，放行
    expect(budget.takeDropped()).toBe(1);
  });

  test("reset 清空窗口与丢弃计数", () => {
    let now = 1_000;
    const budget = new ConsoleMessageBudget(1, 1_000, () => now);
    budget.allow();
    budget.allow();
    budget.reset();
    expect(budget.allow()).toBe(true);
    expect(budget.takeDropped()).toBe(0);
  });

  test("非法上限拒绝构造", () => {
    expect(() => new ConsoleMessageBudget(Number.NaN)).toThrow();
  });
});
