import { describe, expect, test } from "bun:test";
import { applyTriggerTemplate } from "../../src/automation/runner";

const trig = (summary?: string) =>
  summary === undefined ? undefined : { type: "webhook" as const, id: "trg", summary };

describe("{{trigger.summary}} 模板（L1）", () => {
  test("没写占位符 → 原文不动（不注入用户没要求的上下文）", () => {
    expect(applyTriggerTemplate("跑测试", { type: "file", summary: "a.ts" })).toBe("跑测试");
  });

  test("替换所有占位符；摘要头尾空白裁掉", () => {
    expect(applyTriggerTemplate("A {{trigger.summary}} B {{trigger.summary}}", trig("  push  "))).toBe(
      "A push B push",
    );
  });

  test("摘要缺失/空白 → 明确占位说明而不是字面模板", () => {
    expect(applyTriggerTemplate("事件：{{trigger.summary}}", trig())).toBe("事件：(no trigger detail)");
    expect(applyTriggerTemplate("事件：{{trigger.summary}}", trig("   "))).toBe(
      "事件：(no trigger detail)",
    );
  });

  test("摘要里的替换模式按字面保留（$& / $1）", () => {
    expect(applyTriggerTemplate("x {{trigger.summary}}", trig("price $& $1"))).toBe(
      "x price $& $1",
    );
  });
});
