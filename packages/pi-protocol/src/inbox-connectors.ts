/**
 * 收件箱外部来源的连接器契约（主进程 / 渲染层共用）。
 *
 * 连接器只做「读取 + 规范化 + 推送」：不写外部系统，不在协议里携带 Token。
 * Token 只存在主进程 state.db（AES-256-GCM），渲染层拿到的永远是 hasToken
 * 与末四位提示。
 */

export const INBOX_CONNECTOR_PROVIDERS = [
  "github",
  "gitlab",
  "jira",
  "linear",
] as const;

export type InboxConnectorProvider =
  (typeof INBOX_CONNECTOR_PROVIDERS)[number];

/** Jira：Cloud 用邮箱 + API Token（Basic）；Server/DC 用 PAT（Bearer）。 */
export type InboxConnectorAuthMode = "cloud" | "server";

/**
 * 事件过滤。缺省由各 adapter 使用自己的默认集：
 * - GitHub：assigned / reviewRequested / mention
 * - GitLab：assigned / reviewRequested / mention / unmergeable
 * - Jira / Linear：只按「指派给我」拉取，没有事件开关
 */
export type InboxConnectorEvents = {
  assigned?: boolean;
  reviewRequested?: boolean;
  mention?: boolean;
  unmergeable?: boolean;
  buildFailed?: boolean;
};

/** 对渲染层公开的连接器配置（永远不含 Token 本体）。 */
export type InboxConnectorConfig = {
  id: string;
  provider: InboxConnectorProvider;
  enabled: boolean;
  /** 自托管地址；缺省用平台官方域名 */
  baseUrl?: string;
  /** Jira Cloud 邮箱；其余平台由同步结果补全为账号名 */
  account?: string;
  authMode?: InboxConnectorAuthMode;
  events?: InboxConnectorEvents;
  /** Jira 高级覆盖；空 = 使用默认 JQL */
  jql?: string;
  /** 轮询间隔（秒），默认 120 */
  pollIntervalSec?: number;
  /** 新动作事项是否弹系统通知，默认 true */
  desktopNotifications?: boolean;
  /** 静音到此刻（ISO）；到期前不弹系统通知 */
  mutedUntil?: string;
  /** 静音的来源名（repo/项目）；空 = 不按来源静音 */
  mutedSources?: string[];
  /** 是否通知 Issue / 工单类新事项，默认 true */
  notifyIssues?: boolean;
  /** 是否通知 PR / MR 类新事项，默认 true */
  notifyPullRequests?: boolean;
  /** 是否已保存 Token */
  hasToken: boolean;
  /** Token 末四位，设置页只做「已保存 ····abcd」提示 */
  tokenHint?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InboxConnectorState =
  | "disabled"
  | "idle"
  | "syncing"
  | "ok"
  | "error"
  | "needs_auth";

export type InboxConnectorStatus = {
  id: string;
  state: InboxConnectorState;
  lastSyncAt?: string;
  lastError?: string;
  itemCount?: number;
  accountName?: string;
  nextSyncAt?: string;
};

export type InboxConnectorSnapshot = {
  connectors: InboxConnectorConfig[];
  statuses: InboxConnectorStatus[];
};

export type InboxConnectorSaveInput = {
  /** 缺省 = 新建；v1 每个平台一个账号，id 用 provider */
  id?: string;
  provider: InboxConnectorProvider;
  enabled?: boolean;
  baseUrl?: string;
  account?: string;
  authMode?: InboxConnectorAuthMode;
  events?: InboxConnectorEvents;
  jql?: string;
  pollIntervalSec?: number;
  desktopNotifications?: boolean;
  /** 留空/缺省 = 沿用已保存的 Token */
  token?: string;
};

export type InboxConnectorTestInput = {
  /** 编辑已有连接器时，未填新 Token 可复用已保存 Token */
  id?: string;
  provider: InboxConnectorProvider;
  baseUrl?: string;
  account?: string;
  authMode?: InboxConnectorAuthMode;
  jql?: string;
  token?: string;
};

export type InboxConnectorTestResult = {
  ok: boolean;
  accountName?: string;
  itemCount?: number;
  message?: string;
};

/** 连接器通知偏好：只改偏好，不动 Token/地址等连接配置。 */
export type InboxConnectorPrefsInput = {
  id: string;
  desktopNotifications?: boolean;
  /** ISO 时间；null = 取消静音 */
  mutedUntil?: string | null;
  /** 静音的来源名列表；null = 清空 */
  mutedSources?: string[] | null;
  notifyIssues?: boolean;
  notifyPullRequests?: boolean;
};

export type InboxConnectorSyncResult = {
  status: InboxConnectorStatus;
  /** 本次快照里新出现的条目数（用于「新增 N 项」提示） */
  added: number;
  /** 本次快照总条数 */
  items: number;
};

/* --------------------------- 外部事项详情 --------------------------- */

/** 详情请求：provider + 展示 key；Linear 等需要 provider 内部 id。 */
export type InboxExternalDetailInput = {
  provider: InboxConnectorProvider;
  /** 展示编号：repo#12 / PAY-142 / LIN-123 */
  key: string;
  /** issue / pull_request / merge_request / ticket ... */
  type?: string;
  /** provider 内部稳定 id（Linear UUID 等） */
  externalId?: string;
};

export type InboxExternalComment = {
  id: string;
  author?: string;
  /** 作者头像 URL（provider 可选提供） */
  avatarUrl?: string;
  /** Markdown / 纯文本，渲染前由前端消毒 */
  body: string;
  createdAt?: string;
  url?: string;
  /** 平台原生父评论 id；有值时回复走线程 API，否则前端用引用行 */
  replyToId?: string;
};

/** PR/MR 只读概要；Issue 类型不返回该字段。 */
export type InboxExternalPullRequest = {
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  draft?: boolean;
  merged?: boolean;
  /** GitHub mergeable：true/false/null（null = 平台仍在计算） */
  mergeable?: boolean | null;
  mergeableState?: string;
  /** approved / changes_requested / review_required；按平台可得性返回 */
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

/** 外部 issue 详情：正文与评论按需从 provider 拉取，不落收件箱 journal。 */
export type InboxExternalDetail = {
  title?: string;
  /** Markdown / 纯文本；Jira ADF 已在主进程转成文本 */
  body?: string;
  state?: string;
  author?: string;
  /** 作者头像 URL（provider 可选提供） */
  avatarUrl?: string;
  assignee?: string;
  labels?: string[];
  comments?: InboxExternalComment[];
  url?: string;
  updatedAt?: string;
  /** PR/MR 概要（只读展示） */
  pullRequest?: InboxExternalPullRequest;
  /** 正文/评论被截断（长度上限或分页） */
  truncated?: boolean;
};

export type InboxExternalDetailResult =
  | { ok: true; detail: InboxExternalDetail }
  | { ok: false; message: string };

/* --------------------------- PR/MR 只读评审面 --------------------------- */

/** PR/MR 的 diff 与 checks 请求：与详情同键，可带详情里拿到的 headSha 省一次请求。 */
export type InboxExternalPullRequestInput = InboxExternalDetailInput & {
  headSha?: string;
  /** 用户手动刷新：跳过主进程 60s 缓存 */
  force?: boolean;
};

export type InboxExternalDiffFile = {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  /** 二进制或无文本 patch */
  binary?: boolean;
};

export type InboxExternalDiff = {
  /** 统一 patch（含 diff --git 头）；无文本改动时为空串 */
  patch: string;
  files: InboxExternalDiffFile[];
  /** 文件列表或 patch 被截断 */
  truncated?: boolean;
};

export type InboxExternalDiffResult =
  | { ok: true; diff: InboxExternalDiff }
  | { ok: false; message: string };

/** 与 UI 状态一一对应；未知平台状态统一落 unknown。 */
export type InboxExternalCheckState =
  | "pass"
  | "fail"
  | "pending"
  | "skipping"
  | "cancel"
  | "unknown";

export type InboxExternalCheck = {
  name: string;
  /** 来源应用/工作流名，如 GitHub Actions、GitLab CI */
  workflow?: string;
  state: InboxExternalCheckState;
  description?: string;
  detailsUrl?: string;
  /** 失败输出的摘要（纯文本/markdown，前端按纯文本展示） */
  output?: string;
};

export type InboxExternalChecks = {
  headSha?: string;
  checks: InboxExternalCheck[];
  truncated?: boolean;
};

export type InboxExternalChecksResult =
  | { ok: true; checks: InboxExternalChecks }
  | { ok: false; message: string };

/* --------------------------- 外部写操作 --------------------------- */

/** 发表评论/回复：body 由主进程做长度与空校验，空串不发送。 */
export type InboxExternalCommentInput = InboxExternalDetailInput & {
  body: string;
  /** provider 原生父评论 id（Linear parentId 等）；不支持线程的平台由前端引用 */
  replyToId?: string;
};

export type InboxExternalCommentResult =
  | { ok: true }
  | { ok: false; message: string };

export const INBOX_PULL_REQUEST_ACTIONS = [
  "merge",
  "squash",
  "rebase",
  "close",
  "reopen",
  "ready_for_review",
] as const;

export type InboxPullRequestAction =
  (typeof INBOX_PULL_REQUEST_ACTIONS)[number];

export type InboxPullRequestActionInput = InboxExternalDetailInput & {
  action: InboxPullRequestAction;
};

export type InboxPullRequestActionResult =
  | { ok: true }
  | { ok: false; message: string };
