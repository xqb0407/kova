/**
 * Agent Inbox 协议契约（docs/agent-inbox.md）。
 *
 * Inbox 是 sidecar 对异步工作的事件投影：审批/提问、目标暂停、自动化终态、
 * 子代理终态、后台任务终态统一成可排序、可执行、可已读/归档的条目。
 * 全部 schema 保持 loose：未知字段透传，旧端忽略新字段（协议只增不改）。
 */
import { z } from "zod";
import type { PendingInteraction } from "./interactions";
import type { GoalState } from "./payloads";
import type { SubagentRunStatus } from "./notifications";

/** 条目类型（v1） */
export const inboxItemKindSchema = z.enum([
  "approval",
  "question",
  "goal",
  "automation",
  "subagent",
  "background_task",
  /** 预留：GitHub Issue / Jira / Linear 等外部工作项；不混入本地会话事件 */
  "external",
]);
export type InboxItemKind = z.infer<typeof inboxItemKindSchema>;

/** 源侧生命周期：open = 未结算；done = 已结算；expired = 源已消失 */
export const inboxStateSchema = z.enum(["open", "done", "expired"]);
export type InboxState = z.infer<typeof inboxStateSchema>;

/** 结算结果/当前态 */
export const inboxOutcomeSchema = z.enum([
  "needs_action",
  "approved",
  "denied",
  "answered",
  "cancelled",
  "completed",
  "success",
  "failed",
  "stopped",
  "interrupted",
  "resolved",
]);
export type InboxOutcome = z.infer<typeof inboxOutcomeSchema>;

/** P0 阻塞 / P1 需关注 / P2 待查看 / P3 FYI */
export const inboxPrioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type InboxPriority = z.infer<typeof inboxPrioritySchema>;

/** item.actions 的允许动作；服务端按 kind 白名单二次校验 */
export const inboxActionSchema = z.enum([
  "open",
  "approve",
  "deny",
  "answer",
  "cancel",
  "resume",
  "retry",
  "archive",
  "unarchive",
  /** 墓碑删除：仅已结束（非 open）条目；记录从所有列表/计数消失，源再次 upsert 也不复活 */
  "delete",
  "mark_read",
  "mark_unread",
  "snooze",
]);
export type InboxAction = z.infer<typeof inboxActionSchema>;

export const inboxDeepLinkSchema = z.looseObject({
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  /** 转录 seq：打开会话后定位/高亮 */
  seq: z.number().int().nonnegative().optional(),
  /** 审批/提问锚定的工具调用 id */
  anchorToolCallId: z.string().optional(),
  /** 面板 tab：subagents / artifacts / git ... */
  panel: z.string().optional(),
  /** 外部工作项 URL（github/jira/...）；open 动作优先打开它 */
  url: z.string().optional(),
});

/** 外部工作项的最小预留载荷：GitHub Issue/PR、Jira issue、Linear issue 等共用。
 *  provider 不锁枚举：新增渠道只需约定 provider 与 key，不改协议主形状。 */
export const inboxExternalSchema = z.looseObject({
  provider: z.string(),
  /** issue / pull_request / ticket ... */
  type: z.string().optional(),
  /** provider 内稳定键：repo#123、JIRA-123、LIN-123 ... */
  key: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  /** 展示用来源名（repo/项目/团队） */
  sourceName: z.string().optional(),
  /** 触发原因机器键：assigned / review_requested / mention ... */
  reason: z.string().optional(),
  /** provider 内部稳定 id（Linear issue UUID 等），详情接口用 */
  externalId: z.string().optional(),
});
export type InboxExternal = z.infer<typeof inboxExternalSchema>;
export type InboxDeepLink = z.infer<typeof inboxDeepLinkSchema>;

export const inboxItemSchema = z.looseObject({
  /** 稳定 ID：`${kind}:${sourceId}[...]`，见 docs/agent-inbox.md §4.4 */
  id: z.string(),
  kind: inboxItemKindSchema,
  state: inboxStateSchema,
  outcome: inboxOutcomeSchema.optional(),
  priority: inboxPrioritySchema,
  requiresAction: z.boolean(),

  title: z.string(),
  /** 单行摘要，已脱敏、压空白，≤240 字符 */
  summary: z.string().optional(),

  /** 源对象 id：approvalId / questionId / goalId / runId / delegationId / taskId */
  sourceId: z.string(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  projectId: z.string().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),

  /** 用户状态投影（跨端共享，不是源状态） */
  readAt: z.string().optional(),
  archivedAt: z.string().optional(),
  snoozedUntil: z.string().optional(),

  actions: z.array(inboxActionSchema),
  deepLink: inboxDeepLinkSchema.optional(),
  /** kind=external 时的来源载荷；本地事件缺省 */
  external: inboxExternalSchema.optional(),
  /** kind 专属最小元数据；禁止完整工具输入/报告全文/命令输出 */
  meta: z.record(z.string(), z.unknown()).optional(),
  hasDetail: z.boolean(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxCountsSchema = z.looseObject({
  needsAction: z.number().int().nonnegative(),
  /** 全部未读：!readAt && !archived（包含 snooze 未到期条目） */
  unread: z.number().int().nonnegative(),
  /** 待关注：requiresAction 或未读（不含已归档/未到期 snooze） */
  attention: z.number().int().nonnegative().default(0),
  /** 「待关注」列表里真正可见的未读：!readAt && !archived && 不在 snooze。
   *  侧栏/托盘徽标用这个口径，避免出现「有徽标但列表为空」。
   *  加性字段用 default(0)：旧 sidecar 不带它时仍能通过校验。 */
  unreadAttention: z.number().int().nonnegative().default(0),
  /** 历史 Tab 数量：已读、已结束、未归档 */
  history: z.number().int().nonnegative().default(0),
  open: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
});
export type InboxCounts = z.infer<typeof inboxCountsSchema>;

export const inboxFilterSchema = z.looseObject({
  /** action = 需要处理；done = 已结束待查看；archived = 已归档；all = 全部。
   *  attention/history 是桌面「待关注 / 历史」的服务端版本：分页只在当前
   *  Tab 的集合内推进，历史条目不再挤占待关注的第一页。 */
  tab: z
    .enum(["action", "done", "archived", "all", "attention", "history"])
    .optional(),
  kinds: z.array(inboxItemKindSchema).optional(),
  /** 来源过滤：task/automation/subagent/background 或外部 provider（github/jira/...） */
  source: z.string().optional(),
  sessionId: z.string().optional(),
  /** 项目筛选的会话集合：条目没有 projectId（审批/提问/目标）时按 sessionId 兜底 */
  sessionIds: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  /** 只看没有关联项目的条目（与 projectId 互斥，projectId 优先）。
   *  excludeSessionIds 是已知归属项目的会话：没有 projectId 的条目按会话排除 */
  noProject: z.boolean().optional(),
  excludeSessionIds: z.array(z.string()).optional(),
  /** 时间范围：按 updatedAt（最近活动）计算，服务端本地时区 */
  time: z.enum(["today", "7d", "30d"]).optional(),
  /** 开放 / 关闭状态 */
  status: z.enum(["open", "closed"]).optional(),
  /** 外部事项的团队 / 仓库名（external.sourceName） */
  team: z.string().optional(),
  /** 外部事项类型：issue/工单 或 PR/MR */
  externalKind: z.enum(["issue", "pr"]).optional(),
  /** 标题/摘要/来源名子串匹配 */
  query: z.string().optional(),
  /** 是否显示 snooze 未到期条目；默认 false */
  includeSnoozed: z.boolean().optional(),
});
export type InboxFilter = z.infer<typeof inboxFilterSchema>;

/* ------------------------------- 请求/应答 ------------------------------- */

export const listInboxRequestSchema = z.looseObject({
  type: z.literal("list_inbox"),
  filter: inboxFilterSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
export type ListInboxRequest = z.infer<typeof listInboxRequestSchema>;

export const inboxResponseSchema = z.looseObject({
  type: z.literal("inbox"),
  items: z.array(inboxItemSchema),
  counts: inboxCountsSchema,
  nextCursor: z.string().optional(),
  /** 全量来源 facets（不受分页/筛选影响），筛选菜单据此列出完整来源 */
  sources: z.array(z.string()).optional(),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export const inboxItemRequestSchema = z.looseObject({
  type: z.literal("inbox_item"),
  itemId: z.string(),
});
export type InboxItemRequest = z.infer<typeof inboxItemRequestSchema>;

export const inboxItemResponseSchema = z.looseObject({
  type: z.literal("inbox_item"),
  item: inboxItemSchema,
  /** 按 kind 变化的详情载荷（完整审批/报告/运行记录）；读不到时缺省 */
  detail: z.unknown().optional(),
  /** 源已消失（会话删除、审批已结算且原始行不可读） */
  stale: z.boolean().optional(),
});
export type InboxItemResponse = {
  type: "inbox_item";
  item: InboxItem;
  detail?: InboxDetail;
  stale?: boolean;
};

export const inboxActionRequestSchema = z.looseObject({
  type: z.literal("inbox_action"),
  itemId: z.string(),
  action: inboxActionSchema,
  /** 动作参数：approve={approved,remember?,reason?}；answer={answers?,cancelled?}；... */
  payload: z.unknown().optional(),
});
export type InboxActionRequest = z.infer<typeof inboxActionRequestSchema>;

export const inboxActionResponseSchema = z.looseObject({
  type: z.literal("inbox_action_done"),
  itemId: z.string(),
  action: inboxActionSchema,
  item: inboxItemSchema,
  counts: inboxCountsSchema,
});
export type InboxActionResponse = z.infer<typeof inboxActionResponseSchema>;

export const inboxUpdatePatchSchema = z.looseObject({
  read: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** 墓碑删除（用户态，持久化在 state.json）：列表/计数永久隐藏，
   *  源再次 upsert 不会复活。UI 走 delete 动作，不直接下发此字段 */
  deleted: z.boolean().optional(),
  /** null/缺省 = 清除 snooze；ISO 时间 = 到点重现 */
  snoozedUntil: z.string().nullable().optional(),
});
export type InboxUpdatePatch = z.infer<typeof inboxUpdatePatchSchema>;

export const inboxUpdateRequestSchema = z.looseObject({
  type: z.literal("inbox_update"),
  /** 显式 id 批量更新；all=true 时可省略（「全部已读」跨分页生效） */
  itemIds: z.array(z.string()).max(100).optional(),
  /** true = 按 filter 命中的全部条目更新，不再受 100 条 id 上限/分页限制。
   *  旧 sidecar 不认此字段时会退化为只处理随请求附带的 itemIds。 */
  all: z.boolean().optional(),
  filter: inboxFilterSchema.optional(),
  patch: inboxUpdatePatchSchema,
});
export type InboxUpdateRequest = z.infer<typeof inboxUpdateRequestSchema>;

export const inboxUpdateResponseSchema = z.looseObject({
  type: z.literal("inbox_updated"),
  itemIds: z.array(z.string()),
  counts: inboxCountsSchema,
});
export type InboxUpdateResponse = z.infer<typeof inboxUpdateResponseSchema>;

/* ---------------------------- 外部来源同步 ---------------------------- */

/**
 * 宿主轮询外部来源（GitHub/GitLab/Jira/Linear）后推送的全量快照。
 * 事实源在宿主 adapter：sidecar 只负责构建条目、去重与用户状态。
 *
 * complete=false 表示分页/筛选未拉全，此时只 upsert，不结算缺失条目，
 * 避免一次不完整的分页把仍存在的事项误判为已消失。
 */
export const inboxExternalSyncItemSchema = z.looseObject({
  /** 全局唯一键（含 host 等前缀）；缺省回落 key/url/title */
  idKey: z.string().optional(),
  /** 展示用编号：repo#123 / JIRA-123 / LIN-123 ... */
  key: z.string().optional(),
  /** issue / pull_request / merge_request / ticket ... */
  type: z.string().optional(),
  title: z.string(),
  summary: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  sourceName: z.string().optional(),
  createdAt: z.string().optional(),
  requiresAction: z.boolean().optional(),
  priority: inboxPrioritySchema.optional(),
  /** 触发原因机器键：assigned / review_requested / mention ... */
  reason: z.string().optional(),
  /** provider 内部稳定 id（Linear issue UUID 等），详情接口用 */
  externalId: z.string().optional(),
});
export type InboxExternalSyncItem = z.infer<typeof inboxExternalSyncItemSchema>;

export const inboxExternalSyncRequestSchema = z.looseObject({
  type: z.literal("inbox_external_sync"),
  provider: z.string().min(1).max(40),
  /** 连接器实例 id；v1 每个平台一个账号，缺省回落 provider */
  connectorId: z.string().min(1).max(120).optional(),
  items: z.array(inboxExternalSyncItemSchema).max(200),
  /** 缺省 true；false = 本次快照不完整，只 upsert 不结算 */
  complete: z.boolean().optional(),
  /** 本端刚写过评论/动作的条目 key：本次同步强制标记已读，避免自己操作顶回未读 */
  keepReadKeys: z.array(z.string().min(1).max(300)).max(50).optional(),
});
export type InboxExternalSyncRequest = z.infer<typeof inboxExternalSyncRequestSchema>;

export const inboxExternalSyncResponseSchema = z.looseObject({
  type: z.literal("inbox_external_sync_done"),
  provider: z.string(),
  upserted: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type InboxExternalSyncResponse = z.infer<
  typeof inboxExternalSyncResponseSchema
>;

/* -------------------------------- 自发帧 -------------------------------- */

export const inboxChangedFrameSchema = z.looseObject({
  type: z.literal("inbox_changed"),
  reason: z.enum(["upsert", "resolve", "read", "archive", "expire", "snooze"]),
  itemId: z.string().optional(),
  counts: inboxCountsSchema,
  /** upsert 外部条目时的提示元数据（来源静音/分类提示音用） */
  itemType: z.string().optional(),
  sourceName: z.string().optional(),
});
export type InboxChangedFrame = z.infer<typeof inboxChangedFrameSchema>;

/* -------------------------------- 详情 -------------------------------- */

/**
 * 详情是按 kind 变化的服务端载荷。协议层不锁死嵌套形状（各项都有既有契约），
 * 前端按 kind 收窄；这里给出类型供两端共享。
 */
export type InboxDetail =
  | { kind: "approval"; interaction: PendingInteraction }
  | { kind: "question"; interaction: PendingInteraction }
  | { kind: "goal"; goal: GoalState }
  | {
      kind: "automation";
      task: { id: string; name?: string };
      run: {
        id: string;
        status: string;
        createdAt: string;
        message?: string;
      };
      sessionId?: string;
    }
  | {
      kind: "subagent";
      record: {
        delegationId: string;
        agentName: string;
        status: SubagentRunStatus;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        canResume: boolean;
      };
      report?: string;
    }
  | {
      kind: "background_task";
      task: {
        taskId: number;
        command: string;
        source: string;
        startedAt: number;
        exitCode: number | null;
      };
    }
  | {
      kind: "external";
      external: InboxExternal;
      title: string;
      description?: string;
    };
