/**
 * 跨端响应载荷契约（设计文档 §1/§7）：上下文读数、会话列表摘要、压缩结果。
 * sidecar 构造（resolve.ts projectContextInfo / handlers 应答）、desktop 消费
 * （pi-bridge 镜像类型改 import），单源定形。loose：加性演进。
 */
import { z } from "zod";
import { externalDirSchema } from "./transcript";

/**
 * 审批级别（「改之前问不问」）的唯一字面量清单。
 *
 * 单源在这里：协议校验、sidecar 的档位判定与持久化规整、桌面/移动端的状态镜像
 * 全部读它。这档位以前是散在六处的 `x === "a" || x === "b"` 白名单——扩容时漏
 * 一处就是「用户选的档位被静默丢弃、UI 卡在旧档」，加 "review" 时一并收敛掉
 * （见 docs/permission-modes.md）。
 */
export const APPROVAL_LEVELS = ["ask", "workspace-write", "auto-edit", "auto", "review"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

/** 外部来源（请求体、索引行、会话偏好）规整这一档位的收口 */
export function isApprovalLevel(v: unknown): v is ApprovalLevel {
  return typeof v === "string" && (APPROVAL_LEVELS as readonly string[]).includes(v);
}

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
  /** 缓存统计（旧 sidecar 无新字段时按缺省处理）。两套口径并存：
   *  misses/rebuilds 是旧口径（面板分母），missedTokens/missCount/lastMiss/recent
   *  是 pi 口径（真·重算量与归因），见 sidecar context.ts 的 CacheMissStats */
  cacheMisses: z
    .looseObject({
      requests: z.number(),
      misses: z.number(),
      rebuilds: z.number(),
      /** 真·重算 tokens：min(上一轮 prompt, 本轮 prompt) − cacheRead，地板 1024 */
      missedTokens: z.number().optional(),
      /** 触发重算的轮次数 */
      missCount: z.number().optional(),
      /** 最近一次重算的归因（idleMs ≥ TTL / 模型切换；都否 = 未归因） */
      lastMiss: z
        .looseObject({
          tokens: z.number(),
          idleMs: z.number(),
          modelChanged: z.boolean(),
        })
        .nullable()
        .optional(),
      /** 最近 N 轮命中率（累计值被冷启动与重建轮稀释，短窗看稳态） */
      recent: z
        .looseObject({
          requests: z.number(),
          hitRate: z.number().nullable(),
        })
        .optional(),
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
  /** 会话级偏好（undefined = 从未变更过；切回会话时恢复选择用）。
   *  四档必须与 sidecar 的 normalizeSessionMode / 桌面 pi-session-mode 同步——
   *  曾经漏过 "ask"，表现为切到问答档后偏好不落索引表、刷新回默认档。
   *  枚举扩容时三处一起改。 */
  mode: z.enum(["agent", "plan", "ask", "goal"]).optional(),
  /** 五档与 APPROVAL_LEVELS 同一清单；布尔语义见 isApprovalLevel 的说明 */
  approvalLevel: z.enum(APPROVAL_LEVELS).optional(),
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
  /** 会话级目标轮数上限（数字字符串。undefined = 本会话从未定过，建目标回落默认 300；
   *  "0" = 不限。为什么是字符串：列里 NULL 已经被「从未设置」占用，而「不限」也是一个
   *  要记住的选择，两者必须分得开——与 designTheme 用 "" 表达「显式不使用主题」同型） */
  goalMaxTurns: z.string().optional(),
  /** 会话级验收标准启动模式（undefined = 从未定过，新目标默认 auto） */
  goalAcceptanceMode: z.enum(["auto", "manual", "skip"]).optional(),
  /** 会话级目标时长上限（分钟字符串；"0" = 不限；undefined = 从未定过） */
  goalMaxDuration: z.string().optional(),
  /** 会话归属的虚拟项目主目录（cwd 是项目附加根目录时，这里回主目录）。
   *  侧栏分组优先用它；缺省 = 按 cwd 分组（旧端行为） */
  projectCwd: z.string().optional(),
});

/* --------------------------------- goal --------------------------------- */

/**
 * 目标模式的对外快照（data-goal-state chunk 与 get_goal_state 响应共用）。
 * 与 sidecar 的 Goal 一一对应，但只投影 UI 要用的字段——指纹、暂停原因等内部
 * 判据不进协议（桌面只需显示，拿它们做判断只会两端口径漂）。
 */
export const goalStateSchema = z.looseObject({
  /** 无目标（未设定 / 已清除 / 已完成并归档） */
  goal: z
    .looseObject({
      id: z.string(),
      objective: z.string(),
      status: z.enum(["active", "paused", "blocked", "complete"]),
      /** 常驻条一行摘要（sidecar 侧 formatGoalStatus 算好的成品，两端不各算一遍） */
      statusLine: z.string(),
      turnCount: z.number(),
      /** null = 未设上限 */
      maxAutoTurns: z.number().nullable(),
      /** 活跃时长上限（秒），null = 不限 */
      maxDurationSeconds: z.number().nullable().optional(),
      /** 已结算的活跃秒数 */
      timeUsedSeconds: z.number().optional(),
      /** 当前活跃窗口开始时间；非 active 时缺省 */
      activeRunStartedAtMs: z.number().optional(),
      /** 验收标准启动模式 */
      acceptanceMode: z.enum(["auto", "manual", "skip"]).optional(),
      /** 完成证据策略：refs 强校验 / legacy 自由文本 */
      evidencePolicy: z.enum(["legacy", "refs"]).optional(),
      tokensUsed: z.number(),
      startedAt: z.number(),
      updatedAt: z.number(),
      pauseReason: z.string().optional(),
      completionSummary: z.string().optional(),
      /** 完成时的逐条对账（含证据引用与核验标记）；只在 complete 后有值 */
      completionAudit: z
        .array(
          z.looseObject({
            id: z.string(),
            text: z.string(),
            met: z.boolean(),
            evidence: z.string(),
            refs: z.array(z.looseObject({ kind: z.string() })).optional(),
            verified: z.boolean().optional(),
            manualOnly: z.boolean().optional(),
          }),
        )
        .optional(),
      /**
       * 验收标准契约：pending 协商中 / proposed 待用户确认 / confirmed 已生效 /
       * skipped 用户跳过（含老目标回放）。UI 据它决定待确认卡片出不出来。
       * 完成对账明细（completionAudit）与工作台账（workSeen）都是内部判据，不进协议。
       */
      acceptance: z
        .looseObject({
          status: z.enum(["pending", "proposed", "confirmed", "skipped"]),
          items: z.array(z.looseObject({ id: z.string(), text: z.string() })).optional(),
          feedback: z.string().optional(),
          /** auto = 模型提议后自动确认；user = 用户确认/编辑 */
          confirmedBy: z.enum(["user", "auto"]).optional(),
        })
        .optional(),
      /** 每轮进度摘要（最多 12 条）；只用于展示，不参与判定 */
      progress: z
        .array(
          z.looseObject({
            turn: z.number(),
            at: z.number(),
            toolCalls: z.number(),
            tools: z.array(z.string()),
            files: z.array(z.string()),
            commands: z.number(),
            errors: z.number(),
            summary: z.string(),
          }),
        )
        .optional(),
    })
    .nullable(),
});

export type GoalState = z.infer<typeof goalStateSchema>;

/** list_running turns 明细项：一个确定在跑的轮次（会话 + 其 prompt requestId） */
export const runningTurnSchema = z.looseObject({
  sessionId: z.string(),
  requestId: z.string(),
});

/**
 * 项目虚拟目录应答（get/add/remove_project_dir 共用）。
 * main = 项目主目录（会话 cwd 落在这里）；roots = main + 附加根（主目录在前）；
 * dirs = 针对请求 cwd 的生效附加目录（若请求 cwd 是某个附加根，会排除它自己）。
 */
export const projectDirsSchema = z.looseObject({
  type: z.literal("project_dirs"),
  cwd: z.string(),
  main: z.string(),
  roots: z.array(externalDirSchema),
  dirs: z.array(externalDirSchema),
  /** 当前不存在的根（配置保留；提示词标注不可用、检索跳过） */
  missing: z.array(z.string()).optional(),
  projects: z
    .array(z.looseObject({ cwd: z.string(), dirs: z.array(externalDirSchema) }))
    .optional(),
});

export type ProjectDirs = z.infer<typeof projectDirsSchema>;

export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type ContextInfo = z.infer<typeof contextInfoSchema>;
export type Compacted = z.infer<typeof compactedSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type RunningTurn = z.infer<typeof runningTurnSchema>;
