/**
 * 自发通知帧契约（stdout 无 id 行，宿主原样广播给所有前端）。
 * 帧格式事实源 = sidecar protocol/protocol.ts 头注释"自发通知"节。
 * 全部 loose：未知字段透传保留（协议演进只增不改，旧端忽略新字段）。
 */
import { z } from "zod";

/** 某会话一轮 turn 开跑/收尾；未带 sessionId 发起的轮次不广播 */
export const turnChangedFrameSchema = z.looseObject({
  type: z.literal("turn_changed"),
  sessionId: z.string(),
  active: z.boolean(),
});

/** 子代理运行状态（与 sidecar types.ts SubagentRunStatus 同构） */
export const subagentRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "truncated",
  "aborted",
  "stopped",
]);

/** 子代理运行活动条目（思考/正文增量、工具起止、轮次、结算终态） */
export const subagentActivityItemSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("turn"), n: z.number(), at: z.number() }),
  z.looseObject({
    kind: z.literal("thinking"),
    op: z.enum(["start", "delta", "end"]),
    id: z.string(),
    delta: z.string().optional(),
    at: z.number(),
  }),
  z.looseObject({
    kind: z.literal("text"),
    op: z.enum(["start", "delta", "end"]),
    id: z.string(),
    delta: z.string().optional(),
    at: z.number(),
  }),
  z.looseObject({
    kind: z.literal("tool"),
    op: z.enum(["start", "end"]),
    toolCallId: z.string(),
    toolName: z.string(),
    argsSummary: z.string().optional(),
    resultSummary: z.string().optional(),
    failed: z.boolean().optional(),
    at: z.number(),
  }),
  z.looseObject({
    kind: z.literal("status"),
    status: subagentRunStatusSchema,
    turns: z.number(),
    toolCalls: z.number(),
    report: z.string().optional(),
    at: z.number(),
  }),
]);

/** 子代理运行活动；父 turn 结束后后台委派继续广播 */
export const subagentActivityFrameSchema = z.looseObject({
  type: z.literal("subagent_activity"),
  delegationId: z.string(),
  item: subagentActivityItemSchema,
});

/** 定时任务触发/结算（调度器钩子发出；run_done 的 sessionId 调度错误路径可缺省） */
export const automationFiredFrameSchema = z.looseObject({
  type: z.literal("automation_fired"),
  taskId: z.string(),
  taskName: z.string(),
  taskType: z.string(),
  runId: z.string(),
  firedAt: z.string(),
});

export const automationRunDoneFrameSchema = z.looseObject({
  type: z.literal("automation_run_done"),
  taskId: z.string(),
  taskName: z.string(),
  runId: z.string(),
  ok: z.boolean(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  finishedAt: z.string(),
});

/** 上下文读数变化（设计文档 §7，拉转推）：轮次收尾点现算推送，桌面 pi-context
 *  镜像直更占用环；完整读数（模型名/分项/miss 统计）仍走 context_info 拉取。
 *  usedTokens = 消息+系统提示词+工具三项之和；threshold = 自动压缩硬阈值
 *  （hardLimit）；cacheHitRatio 与 ContextInfo.cacheHitRate 同口径可 null。
 *  盖事件水印（§3）：漏帧回拉 context_info。 */
export const contextChangedFrameSchema = z.looseObject({
  type: z.literal("context_changed"),
  sessionId: z.string(),
  usedTokens: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  contextWindow: z.number().int().nonnegative(),
  cacheHitRatio: z.number().min(0).max(1).nullable(),
  eventSeq: z.number().int().nonnegative().optional(),
});

/** 插件耗时操作结果（受理走响应帧 plugin_op_accepted，完成走本帧；
 * plugins/marketplaces 清单载荷过胖且域内自有契约，此处透传不展开） */
export const pluginOpResultFrameSchema = z.looseObject({
  type: z.literal("plugin_op_result"),
  opId: z.string(),
  op: z.enum([
    "add_marketplace",
    "refresh_marketplace",
    "install_plugin",
    "install_plugin_local",
  ]),
  ok: z.boolean(),
  errorText: z.string().optional(),
  /** 安装类操作成功时附带目标插件名（旧端可缺省） */
  name: z.string().optional(),
});

export type TurnChangedFrame = z.infer<typeof turnChangedFrameSchema>;
export type SubagentRunStatus = z.infer<typeof subagentRunStatusSchema>;
export type SubagentActivityItem = z.infer<typeof subagentActivityItemSchema>;
export type SubagentActivityFrame = z.infer<typeof subagentActivityFrameSchema>;
export type AutomationFiredFrame = z.infer<typeof automationFiredFrameSchema>;
export type AutomationRunDoneFrame = z.infer<typeof automationRunDoneFrameSchema>;
export type ContextChangedFrame = z.infer<typeof contextChangedFrameSchema>;
export type PluginOpResultFrame = z.infer<typeof pluginOpResultFrameSchema>;
