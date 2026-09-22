/**
 * 挂起交互契约（设计文档 §4，M2 接线；先行定版类型）。
 * 一个对象统一逐工具审批与用户提问：发起即落盘（pending_interaction 行），
 * 结算落 interaction_resolved 行，get_history 回放未结算项重建挂起卡。
 * 语义对齐上游 pi tool-durability 的 outcome_ready 前态（命名留升级通道）。
 */
import { z } from "zod";

export const interactionKindSchema = z.enum(["permission", "question"]);

/** 审批载荷：逐工具审批（toolName=plan_exit 时 input 携带计划审批卡数据） */
export const permissionPayloadSchema = z.looseObject({
  approvalId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});

/** 提问载荷：Question 工具的挂起提问（answers 结算见 question_answer 命令）。
 *  questions 与 data-question chunk 的 data.questions 同形（sidecar
 *  QuestionDef[]），回放重建卡片必需；契约保持宽松，渲染端按视图类型收窄。 */
export const questionPayloadSchema = z.looseObject({
  questionId: z.string(),
  anchorToolCallId: z.string(),
  questions: z.array(z.unknown()).optional(),
});

export const pendingInteractionSchema = z.looseObject({
  interactionId: z.string(),
  kind: interactionKindSchema,
  /** 产生该交互的对话行（工具调用 id 锚定）；会话级提示允许空串 */
  anchorToolCallId: z.string(),
  payload: z.union([permissionPayloadSchema, questionPayloadSchema]),
  createdAt: z.string(),
  /** autoResolution 宽限截止（预留位，默认不出现 = 关闭） */
  expiresAt: z.string().optional(),
});

export const interactionResolutionSchema = z.enum([
  "approved",
  "denied",
  "answered",
  "cancelled",
]);

/** 结算行：与 pending_interaction 行按 interactionId 配对 */
export const interactionResolvedRowSchema = z.looseObject({
  interactionId: z.string(),
  resolution: interactionResolutionSchema,
  resolvedAt: z.string(),
});

export type InteractionKind = z.infer<typeof interactionKindSchema>;
export type PermissionPayload = z.infer<typeof permissionPayloadSchema>;
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
export type InteractionResolution = z.infer<typeof interactionResolutionSchema>;
export type InteractionResolvedRow = z.infer<typeof interactionResolvedRowSchema>;

/* ---------------- 转录行（设计文档 §4/§6；行事件溯源，queue_state 同款不占 seq 号段） ---------------- */

/** 发起即落盘行：interaction 为完整 PendingInteraction（载荷够重建卡片） */
export const pendingInteractionFileRowSchema = z.looseObject({
  type: z.literal("pending_interaction"),
  ts: z.string().optional(),
  interaction: pendingInteractionSchema,
});

/** 结算行：与发起行按 interactionId 配对；扫描时已结算者不再回放 */
export const interactionResolvedFileRowSchema = z.looseObject({
  type: z.literal("interaction_resolved"),
  ts: z.string().optional(),
  interactionId: z.string(),
  resolution: interactionResolutionSchema,
  resolvedAt: z.string(),
});

export type PendingInteractionFileRow = z.infer<typeof pendingInteractionFileRowSchema>;
export type InteractionResolvedFileRow = z.infer<typeof interactionResolvedFileRowSchema>;

/* ---------------- list_pending 拉取（§3 回拉表"交互发起/结算"的权威接口） ---------------- */

export const listPendingRequestSchema = z.looseObject({
  type: z.literal("list_pending"),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
});

export const pendingResponseFrameSchema = z.looseObject({
  id: z.string().optional(),
  type: z.literal("pending"),
  items: z.array(pendingInteractionSchema),
});

export type ListPendingRequest = z.infer<typeof listPendingRequestSchema>;
export type PendingResponseFrame = z.infer<typeof pendingResponseFrameSchema>;

/* ---------------- get_history 分页窗（§6，ZCode rowsWindow 的对应物） ---------------- */

/** 应答窗口元数据：游标即消息行 seq；firstSeq/lastSeq 在空窗时为 null */
export const historyWindowMetaSchema = z.looseObject({
  firstSeq: z.number().int().nullable(),
  lastSeq: z.number().int().nullable(),
  hasMore: z.boolean(),
});
export type HistoryWindowMeta = z.infer<typeof historyWindowMetaSchema>;
