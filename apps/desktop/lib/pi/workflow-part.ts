/**
 * 工作流工具行在消息投影里的归属判定（纯函数，便于单测）。
 *
 * 背景：工作流的 `workflow_propose_plan` / `workflow_run_playbook` 工具行有两种形态——
 * - **卡片**：成功提案/按名跑剧本，结果回执带 `Run ID: wf-…`，渲染成剧本卡/运行卡；
 * - **尝试**：被驳回的提案（结果只回 `rejected: …`），渲染成一行「工作流剧本」。
 *
 * 投影层（assistant-message）据此决定：卡片独立成行并归「回答面」（它是这一轮的
 * 交付面，折叠轮里也必须可见），尝试归「过程面」（是过程噪音，折进大折叠）。
 * 一起提上去的话，一次被驳回多次的提案会在对话里堆出七八行「工作流剧本」。
 */

/** 工作流工具名（sidecar workflow/plan-state.ts 的 WORKFLOW_TOOL_NAMES 镜像） */
export const WORKFLOW_TOOL_NAMES = new Set(["workflow_propose_plan", "workflow_run_playbook"]);

/** 工具结果的纯文本（字符串原样；`{error}` 取 error；其余 JSON 化） */
export function toolResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "error" in (result as Record<string, unknown>)) {
    return String((result as { error?: unknown }).error ?? "");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/** 这条工具行是否**变成了剧本卡/运行卡**（判据：结果里的 `Run ID:`） */
export function isWorkflowCardPart(part: unknown): boolean {
  const p = part as { type?: string; toolName?: string; result?: unknown };
  if (p?.type !== "tool-call" || !WORKFLOW_TOOL_NAMES.has(p.toolName ?? "")) return false;
  return /\bRun ID:\s*\S+/.test(toolResultText(p.result));
}
