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
      /** 由哪个剧本发起（库路径运行） */
      playbookName: z.string().optional(),
      playbookId: z.string().optional(),
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

/* ------------------------------- 剧本库 ------------------------------- */

/**
 * 剧本参数声明:name 是 `{{args.name}}` 占位符的键。保存时从步骤 prompt 里
 * 自动提取(见 sidecar workflow/library.ts 的 deriveArgsFromSteps),也可由调用方
 * 显式给出;运行时按声明校验填充。type 只支持三种原始值——剧本参数是给 prompt
 * 插值用的,不是数据管道。
 */
export const playbookArgSchema = z.looseObject({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export type PlaybookArg = z.infer<typeof playbookArgSchema>;

/**
 * 已保存的剧本(库条目)。steps 用与提案卡同一份 UI 投影(workflowStepViewSchema)
 * ——设置页的剧本详情与运行卡渲染同一形状,不为库再造一套。
 */
export const playbookSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** 给模型/用户看的选择时机(对齐 ZCode 的「使用时机」字段) */
  whenToUse: z.string().optional(),
  steps: z.array(workflowStepViewSchema),
  args: z.array(playbookArgSchema),
  /** 来源:from-run(从运行存下)/ manual */
  source: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Playbook = z.infer<typeof playbookSchema>;

/** 运行历史的一条摘要(设置页「运行历史」tab;从 .kova/workflows 目录投影) */
export const workflowRunSummarySchema = z.looseObject({
  runId: z.string(),
  title: z.string().optional(),
  objective: z.string(),
  status: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  tokensUsed: z.number(),
  stepCount: z.number(),
  doneCount: z.number(),
  /** 由哪个剧本发起(库路径运行时记录) */
  playbookName: z.string().optional(),
  playbookId: z.string().optional(),
});

export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;
