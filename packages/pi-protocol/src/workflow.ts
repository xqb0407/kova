/**
 * 工作流模式的对外快照（data-workflow-state chunk 与 get_workflow_state 响应共用）。
 * 设计文档见 plans/workflow-mode-design.md；与 goalStateSchema 同款：
 * 全量快照、整字段替换（禁增量深合并），只投影 UI 要用的字段——步骤 prompt 模板、
 * 指纹、并发调度等内部判据不进协议（完整形态在 sidecar src/workflow/plan-state.ts）。
 */
import { z } from "zod";

/** 单个剧本步骤的 UI 投影（声明侧；运行状态在 stepStates 里按 key 对齐） */
export const workflowStepViewSchema = z.looseObject({
  key: z.string(),
  /** "delegate" | "synthesize" | "gate" | "verify" */
  kind: z.string(),
  phase: z.string().optional(),
  title: z.string(),
  /** 子智能体定义名（delegate）；synthesize/verify/gate 缺省 */
  agent: z.string().optional(),
  /** 模型覆盖（"provider/modelId"）；缺省继承会话模型 */
  model: z.string().optional(),
  dependsOn: z.array(z.string()),
  /** gate 步骤的确定性命令：确认卡要逐字展示——用户确认的就是这个命令集 */
  gate: z
    .looseObject({
      command: z.string(),
      args: z.array(z.string()).optional(),
    })
    .optional(),
  /** foreach 扇出（仅 delegate）：按 from 步骤结果逐行展开 */
  foreach: z.looseObject({ from: z.string() }).optional(),
  /** verify：N 个对抗式评审投票 */
  verify: z
    .looseObject({ reviewers: z.number().optional(), threshold: z.number().optional() })
    .optional(),
  /** 可恢复失败的额外重试次数 */
  retries: z.number().optional(),
  /** 失败传播："abort"（默认）| "skip" */
  onFail: z.string().optional(),
});

/** 单个步骤的运行状态投影（key 对齐 steps） */
export const workflowStepStateSchema = z.looseObject({
  key: z.string(),
  status: z.enum(["pending", "running", "done", "failed", "skipped", "interrupted"]),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  tokens: z.number().optional(),
  /** delegate 步骤对应的委派 id（前端据此在委派面板开 tab） */
  delegationId: z.string().optional(),
});

export const workflowRunStateSchema = z.looseObject({
  /** 无运行（未提案 / 已清除 / 已完成并归档） */
  run: z
    .looseObject({
      id: z.string(),
      objective: z.string(),
      /** proposing 编排中 → proposed 待确认 → running → paused/blocked → complete/failed */
      status: z.enum(["proposing", "proposed", "running", "paused", "blocked", "complete", "failed"]),
      /** 常驻条一行摘要（sidecar 侧 formatWorkflowStatus 算好的成品） */
      statusLine: z.string(),
      title: z.string().optional(),
      steps: z.array(workflowStepViewSchema).optional(),
      stepStates: z.array(workflowStepStateSchema).optional(),
      /** 提案被驳回时用户的意见，重提轮据此修改剧本 */
      proposalFeedback: z.string().optional(),
      completionSummary: z.string().optional(),
      tokensUsed: z.number(),
      startedAt: z.number(),
      updatedAt: z.number(),
    })
    .nullable(),
});

export type WorkflowStepView = z.infer<typeof workflowStepViewSchema>;
export type WorkflowStepState = z.infer<typeof workflowStepStateSchema>;
export type WorkflowState = z.infer<typeof workflowRunStateSchema>;

/* ------------------- 工作流交付注入的哨兵前缀 ------------------- */

/**
 * 运行完成后把合成报告投回对话的注入消息前缀（sidecar workflow/runner 构造，
 * user 角色落转录）。与 GOAL_CONTINUE_PREFIX 同款处理：模型上下文里保留作交付
 * 指令，UI 各路径按前缀隐藏；契约层单源，两端各写一份判定就会漏。
 */
export const WORKFLOW_CONTINUE_PREFIX = "[[workflow-continue]] ";

/** 消息文本是否为工作流交付注入（按前缀识别） */
export function isWorkflowContinueText(text: string): boolean {
  return text.startsWith(WORKFLOW_CONTINUE_PREFIX);
}
