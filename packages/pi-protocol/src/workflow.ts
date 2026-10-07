/**
 * 工作流模式的对外快照（data-workflow-state chunk 与 get_workflow_state 响应共用）。
 * 设计文档见 plans/workflow-mode-design.md；与 goalStateSchema 同款：
 * 全量快照、整字段替换（禁增量深合并），只投影 UI 要用的字段——步骤 prompt 模板、
 * 指纹、并发调度等内部判据不进协议（完整形态在 sidecar src/workflow/plan-state.ts）。
 */
import { z } from "zod";

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
  /** 单步超时（delegate/verify/synthesize）；缺省用执行器默认值。UI 据此画超时兜底标记 */
  timeoutMs: z.number().optional(),
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
  /** verify 步骤:N 个评审各一条委派（顺序 = 评审 1..N），抽屉里逐个可开 */
  delegationIds: z.array(z.string()).optional(),
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
      /** 剧本参数声明（从步骤 prompt 的 {{args.NAME}} 提取）：提案卡据此渲染参数槽表单 */
      args: z.array(playbookArgSchema).optional(),
      /** 参数当前值：手拟剧本通常为空（确认时由 UI 填）；库路径运行带保存时的值 */
      argValues: z.record(z.string(), z.unknown()).optional(),
      /** 由哪个剧本发起（库路径运行） */
      playbookName: z.string().optional(),
      playbookId: z.string().optional(),
      /** 重启恢复时全量 run 文件缺失、退回瘦身行：状态可读但步骤结果不可用（UI 据此提示将重跑） */
      resultsUnavailable: z.boolean().optional(),
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

/**
 * 消息形状判定（与 isAutoContinueMessage / isGoalInternalMessage 同款）：
 * 直播投影与转录回放两条路径都用它把交付注入从用户气泡里滤掉。少了它，
 * `[[workflow-continue]] …<workflow_report>…` 整段内部指令会以用户气泡直出
 * （实机反馈：跑完之后对话里冒出一条自带英文指令与原始报告的用户消息）。
 */
export function isWorkflowContinueMessage(msg: unknown): boolean {
  const m = msg as { role?: string; content?: unknown } | undefined;
  if (!m || m.role !== "user") return false;
  const text =
    typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? (m.content as { type?: string; text?: string }[])
            .filter((c) => c?.type === "text")
            .map((c) => c.text ?? "")
            .join("")
        : "";
  return isWorkflowContinueText(text);
}

/* ------------------------------- 剧本库 ------------------------------- */

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
  /** 存下它的那次运行 id(source=from-run 时),卡片上作「来自运行」溯源徽标 */
  sourceRunId: z.string().optional(),
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
  /** 该运行所在会话(历史行「查看」跳回对话现场);草稿期线程键不发此字段 */
  threadId: z.string().optional(),
});

export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;

/* ------------------------------- 步骤详情 ------------------------------- */

/**
 * 单步详情（运行卡/常驻条的步骤抽屉按需拉取，`workflow_step_detail`）。
 * 常规快照刻意不带 prompt 与步骤结果（百步 run 的推进推送会被撑到几百 KB），
 * 详情走按需 RPC：一次一块，只有真正点开的那一步过网。
 */
export const workflowStepDetailSchema = z.looseObject({
  key: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.enum(["pending", "running", "done", "failed", "skipped", "interrupted"]),
  phase: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  /** 插值后的最终 prompt（{{item}}/{{args.x}}/{{上游}} 已替换；24k 上限由执行器施加） */
  prompt: z.string().optional(),
  /** gate 命令（逐字，与提案卡同源） */
  gate: z.looseObject({ command: z.string(), args: z.array(z.string()).optional() }).optional(),
  verify: z.looseObject({ reviewers: z.number().optional(), threshold: z.number().optional() }).optional(),
  foreach: z.looseObject({ from: z.string() }).optional(),
  retries: z.number().optional(),
  onFail: z.string().optional(),
  timeoutMs: z.number().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  tokens: z.number().optional(),
  /** delegate：对应的委派 id（抽屉据此打开「子智能体」面板 tab） */
  delegationId: z.string().optional(),
  /** 步骤结果（gate 退出码摘要 / verify 投票列表 / delegate 报告；已按 12k 上限截断） */
  result: z.string().optional(),
  error: z.string().optional(),
});

export type WorkflowStepDetail = z.infer<typeof workflowStepDetailSchema>;
