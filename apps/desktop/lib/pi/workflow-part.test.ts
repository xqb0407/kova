import { describe, expect, test } from "bun:test";
import { isWorkflowCardPart } from "@/lib/pi/workflow-part";

describe("工作流工具行的归属判定(实机:被驳回的尝试也堆到回答面)", () => {
  const call = (toolName: string, result: unknown) => ({ type: "tool-call", toolName, result });

  test("成功提案(回执带 Run ID)→ 卡片", () => {
    const result = 'Plan "仓库调研" submitted with 6 step(s):\n- [delegate] scan …\n\nRun ID: wf-muxy511m-d0c9b0c3\nStop here.';
    expect(isWorkflowCardPart(call("workflow_propose_plan", result))).toBe(true);
  });

  test("按名跑剧本(同样回 Run ID)→ 卡片", () => {
    expect(isWorkflowCardPart(call("workflow_run_playbook", { output: "Run ID: wf-abc" }))).toBe(true);
  });

  test("被驳回的提案尝试(只有 rejected 文案)→ 不是卡片", () => {
    const rejected =
      "workflow_propose_plan rejected: steps[5] (gate-materials) is a gate step and needs gate.command …";
    expect(isWorkflowCardPart(call("workflow_propose_plan", rejected))).toBe(false);
  });

  test("错误信封({error})里的 rejected 文案同样判非卡片", () => {
    expect(
      isWorkflowCardPart(call("workflow_propose_plan", { error: "workflow_propose_plan rejected: …" })),
    ).toBe(false);
  });

  test("别的工具行不参与判定(含 Task)", () => {
    expect(isWorkflowCardPart(call("Task", "Run ID: wf-abc"))).toBe(false);
    expect(isWorkflowCardPart({ type: "text", text: "Run ID: x" })).toBe(false);
    expect(isWorkflowCardPart(null)).toBe(false);
  });
});
