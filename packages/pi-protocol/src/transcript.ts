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

/* -------------------- 长度截断自动续跑哨兵 -------------------- */

/**
 * 长度截断自动续跑注入消息的哨兵前缀（sidecar context.makeAutoContinueMessage
 * 构造，user 角色落转录；模型上下文里保留作续跑指令，UI 各路径按前缀隐藏）。
 * 放契约层单源：sidecar 的 toUiMessage/historyToUiMessages 与 thread_snapshot
 * 直出、桌面的投影层过滤必须同口径——快照契约「原生行直出（前端投影层消费）」
 * 不经过 sidecar 的 UI 投影，两端各写一份前缀判定就会漏（steer 前缀曾因镜像
 * 吃过亏，见桌面 messageProjection STEER_PREFIX 注释）。
 */
export const AUTO_CONTINUE_PREFIX = "[[auto-continue]] ";

/** 消息文本是否为长度截断续跑注入（按前缀识别） */
export function isAutoContinueText(text: string): boolean {
  return text.startsWith(AUTO_CONTINUE_PREFIX);
}

/** user 消息（role/content 宽松结构，content 为 string 或块数组）是否为
 *  长度截断续跑注入——sidecar 的 thread_snapshot 跳行、isTruncationStoppedRow
 *  的下一行判定与桌面投影层过滤共用，避免三处各写一遍文本拼接。 */
export function isAutoContinueMessage(msg: unknown): boolean {
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
  return isAutoContinueText(text);
}

/* ---------------------- goal 模式自动续跑哨兵 ---------------------- */

/**
 * goal 模式跨轮自动续跑注入消息的哨兵前缀（sidecar
 * goal-continuation.makeGoalContinueMessage 构造，user 角色落转录）。
 * 与 AUTO_CONTINUE_PREFIX 同款处理：模型上下文里保留作续跑指令，UI 各路径按前缀隐藏。
 * 同样放契约层单源——sidecar 的 toUiMessage/historyToUiMessages、thread_snapshot
 * 直出与桌面投影层过滤必须同口径，两端各写一份判定就会漏。
 */
export const GOAL_CONTINUE_PREFIX = "[[goal-continue]] ";

/** 消息文本是否为目标模式自动续跑注入（按前缀识别） */
export function isGoalContinueText(text: string): boolean {
  return text.startsWith(GOAL_CONTINUE_PREFIX);
}

/** 目标模式全部内部注入前缀（UI 隐藏判定共用一个入口） */
export const GOAL_INTERNAL_PREFIXES = [GOAL_CONTINUE_PREFIX] as const;

export function isGoalInternalText(text: string): boolean {
  return GOAL_INTERNAL_PREFIXES.some((p) => text.startsWith(p));
}

/** user 消息是否为 goal 模式的内部注入（续跑）——判定口径同 isAutoContinueMessage */
export function isGoalInternalMessage(msg: unknown): boolean {
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
  return isGoalInternalText(text);
}
