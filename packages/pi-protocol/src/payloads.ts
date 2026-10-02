/**
 * 跨端响应载荷契约（设计文档 §1/§7）：上下文读数、会话列表摘要、压缩结果。
 * sidecar 构造（resolve.ts projectContextInfo / handlers 应答）、desktop 消费
 * （pi-bridge 镜像类型改 import），单源定形。loose：加性演进。
 */
import { z } from "zod";

export const usageTotalsSchema = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

/** 上下文面板读数（context_info 响应；sidecar 现算，零新增持久化） */
export const contextInfoSchema = z.looseObject({
  type: z.literal("context_info"),
  model: z
    .looseObject({
      provider: z.string(),
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  /** 上下文容量（tokens） */
  contextWindow: z.number(),
  /** 压缩阈值 = 容量 − 请求余量（与自动压缩同一公式） */
  hardLimit: z.number(),
  messageTokens: z.number(),
  systemPromptTokens: z.number(),
  toolTokens: z.number(),
  /** 模型可见的请求总占用（usage 口径已含系统提示词/工具，等于 messageTokens；
   *  纯估算口径为三项相加）。旧 sidecar 无此字段时按三项相加兜底 */
  usedTokens: z.number().optional(),
  messageCount: z.number(),
  /** 已发生的压缩代数（0 = 从未压缩） */
  generation: z.number(),
  lastCompaction: z
    .looseObject({
      tokensBefore: z.number(),
      summarized: z.boolean(),
      createdAt: z.string(),
    })
    .nullable(),
  /** 当前占用是否已越过压缩阈值 */
  needsCompaction: z.boolean(),
  usage: usageTotalsSchema,
  /** 平均缓存命中率 0..1；无用量数据为 null */
  cacheHitRate: z.number().nullable(),
  /** 逐请求缓存 miss 计数（旧 sidecar 无此字段时按缺省处理） */
  cacheMisses: z
    .looseObject({
      requests: z.number(),
      misses: z.number(),
      rebuilds: z.number(),
    })
    .optional(),
});

/** 手动压缩结果（compact 响应） */
export const compactedSchema = z.looseObject({
  type: z.literal("compacted"),
  generation: z.number(),
  tokensBefore: z.number(),
  summarized: z.boolean(),
  /** 本次压缩的摘要文本（分隔线下方「压缩摘要」可展开查看） */
  summary: z.string(),
});

/** 会话列表摘要行（list_sessions 响应；SQLite 索引投影 + 会话级偏好镜像） */
export const sessionSummarySchema = z.looseObject({
  sessionId: z.string(),
  name: z.string().optional(),
  firstMessage: z.string(),
  messageCount: z.number(),
  modified: z.string(),
  cwd: z.string(),
  archived: z.boolean().optional(),
  /** 会话级偏好（undefined = 从未变更过；切回会话时恢复选择用） */
  mode: z.enum(["agent", "plan"]).optional(),
  approvalLevel: z.enum(["ask", "auto-edit", "auto"]).optional(),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  /** 会话级思考档位偏好（undefined = 从未定靶选过，跟随默认档位；
   *  定靶 set_thinking 落转录行并投影到偏好列，见 pi-agent handlers/models.ts） */
  thinkingLevel: z.string().optional(),
  /** 设计主题偏好（三态）：JSON {scope,id} 字符串 = 选中；"" = 显式不使用主题；
   *  null/缺失 = 从未设置（sidecar 恢复链回落最近使用，见 sessions/resolve.ts） */
  designTheme: z.string().nullable().optional(),
  /** 会话级工作模式偏好 work|code|design（undefined = 本会话从未切换过，跟随全局默认
   *  kv pi.app_mode；定靶 set_app_mode 只写被点名会话，见 pi-agent handlers/preferences.ts。
   *  与 mode（agent/plan/ask 权限模式）正交：那个切权限，这个切人群定位） */
  appMode: z.enum(["work", "code", "design"]).optional(),
});

/** list_running turns 明细项：一个确定在跑的轮次（会话 + 其 prompt requestId） */
export const runningTurnSchema = z.looseObject({
  sessionId: z.string(),
  requestId: z.string(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type ContextInfo = z.infer<typeof contextInfoSchema>;
export type Compacted = z.infer<typeof compactedSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type RunningTurn = z.infer<typeof runningTurnSchema>;
