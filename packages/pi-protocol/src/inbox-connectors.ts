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
  /** 正文/评论被截断（长度上限或分页） */
  truncated?: boolean;
};

export type InboxExternalDetailResult =
  | { ok: true; detail: InboxExternalDetail }
  | { ok: false; message: string };
