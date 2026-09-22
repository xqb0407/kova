/**
 * 转录上下文设定行契约（设计文档 §6，M4 上游对齐）。
 * 与上游 coding-agent session-format v3 同名同字段（model_change /
 * thinking_level_change / session_info / header.parentSession），但取
 * **线性子集**：不采纳树位的 id/parentId 链（§11 决策 4——字段名抄上游，
 * 未来换 AgentHarness 底盘时转录可读；链由 seq 文件序天然给出）。
 * 行事件溯源、不占 seq 号段（queue_state / pending_interaction 同款机制），
 * 读端单遍 last-wins，未识别行跳过（向前兼容）。
 */
import { z } from "zod";

/** JSONL 首行（元数据，不参与回放）。parentSession = fork 溯源（上游同名
 * 字段；本项目值为源 sessionId 而非文件路径——我们的会话身份是 id）。 */
export const transcriptHeaderSchema = z.looseObject({
  type: z.literal("header"),
  schema: z.number().int(),
  id: z.string(),
  cwd: z.string(),
  created_at: z.string().optional(),
  /** fork 系：源会话 id（§6；文件复制行为不变，这里只留溯源） */
  parentSession: z.string().optional(),
});

/** 换模型行：会话恢复的模型真值（替代 SQLite 偏好镜像；偏好退为投影）。
 * last-wins 回放的取值字段名与上游逐字一致（provider/modelId）。 */
export const modelChangeRowSchema = z.looseObject({
  type: z.literal("model_change"),
  provider: z.string(),
  modelId: z.string(),
  /** 上游条目必带 timestamp；线性子集可选（旧行没有） */
  timestamp: z.string().optional(),
});

/** 思考档位变更行："思考等级重放"用行历史回答（§6，上游同名同字段）。
 * 本项目档位集合见 sidecar THINKING_LEVELS；契约保持 string 不锁枚举，
 * 读端自行校验（未知档位跳过而非报错 = 向前兼容）。 */
export const thinkingLevelChangeRowSchema = z.looseObject({
  type: z.literal("thinking_level_change"),
  thinkingLevel: z.string(),
  timestamp: z.string().optional(),
});

/** 会话命名行：rename/智能标题都落本行，索引 title 列退为投影（§6）。
 * 上游 SessionInfoEntry 的 name 字段（"display name"）。 */
export const sessionInfoRowSchema = z.looseObject({
  type: z.literal("session_info"),
  name: z.string(),
  timestamp: z.string().optional(),
});

export type TranscriptHeader = z.infer<typeof transcriptHeaderSchema>;
export type ModelChangeRow = z.infer<typeof modelChangeRowSchema>;
export type ThinkingLevelChangeRow = z.infer<typeof thinkingLevelChangeRowSchema>;
export type SessionInfoRow = z.infer<typeof sessionInfoRowSchema>;
