/**
 * 定时任务投递文本的回归护栏：agent 收到的必须是用户创建任务时写的 prompt
 * 原文，不携带任何系统包裹。
 *
 * 曾有一版在头部注入「无人值守定时任务运行」+ 三条行为指引（勿反问/输出即
 * 交付物等），用户看到的历史里全是这段与任务无关的话；约束本就在结构性层
 * （审批即时裁决、Question 即答即回、plan 不可达），提示词包裹是纯噪音。
 * 这个测试钉住"原样投递"的语义，防止回潮。
 */
import { describe, test, expect } from "bun:test";
import { automationPromptText } from "../../src/automation/runner";

describe("automationPromptText", () => {
  test("原样返回用户 prompt（多行 Markdown 不加工）", () => {
    const prompt = [
      "汇总今天需要我关注的事项：",
      "- 未完成的待办",
      "- 今天到期的日程",
      "",
      "输出一份不超过 10 条的晨报清单。",
    ].join("\n");
    expect(automationPromptText({ prompt })).toBe(prompt);
  });

  test("不注入任何角色/无人值守/交付指引包裹", () => {
    const text = automationPromptText({ prompt: "写一份晨报" });
    expect(text).toBe("写一份晨报");
    for (const forbidden of ["无人值守", "执行体", "输出即交付物", "不要向用户提问"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("首尾空白裁掉（全空白由调用方判空拒绝，不投递空消息）", () => {
    expect(automationPromptText({ prompt: "  hi \n" })).toBe("hi");
    expect(automationPromptText({ prompt: "   \n\t " })).toBe("");
  });
});
