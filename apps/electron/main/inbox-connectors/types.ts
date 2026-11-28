/**
 * 收件箱外部来源的内部类型（只在主进程使用）。
 *
 * 对外公开的配置/状态形状在 pi-protocol/inbox-connectors；这里多出
 * tokenCipher 等只在主进程流转的字段。
 */
import type {
  InboxConnectorAuthMode,
  InboxConnectorEvents,
  InboxConnectorProvider,
  InboxPriority,
} from "pi-protocol";

export type StoredConnector = {
  id: string;
  provider: InboxConnectorProvider;
  enabled: boolean;
  baseUrl?: string;
  account?: string;
  authMode?: InboxConnectorAuthMode;
  events?: InboxConnectorEvents;
  jql?: string;
  pollIntervalSec?: number;
  desktopNotifications?: boolean;
  /** 静音到此刻（ISO）；到期前不弹系统通知 */
  mutedUntil?: string;
  /** 静音的来源名（repo/项目） */
  mutedSources?: string[];
  /** 通知分类开关，缺省 true */
  notifyIssues?: boolean;
  notifyPullRequests?: boolean;
  /** AES-256-GCM 密文；永不返回渲染层 */
  tokenCipher?: string;
  tokenHint?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** adapter 规范化后的外部事项（sidecar 负责再包成 InboxItem）。 */
export type ExternalNotification = {
  /** 全局唯一键（含 host 前缀）；缺省由 key/url/title 推导 */
  idKey?: string;
  /** 展示编号：repo#123 / JIRA-123 / LIN-123 */
  key?: string;
  type?: string;
  title: string;
  summary?: string;
  url?: string;
  status?: string;
  sourceName?: string;
  createdAt?: string;
  requiresAction?: boolean;
  priority?: InboxPriority;
  /** 机器键：assigned / review_requested / mention / unmergeable / build_failed */
  reason?: string;
  /** provider 内部稳定 id（Linear issue UUID 等），详情接口用 */
  externalId?: string;
};

export type HttpJsonRequest = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 单次响应体上限；默认 4MB。大 diff 等明确需要时单独放宽。 */
  maxBytes?: number;
};

export type HttpJsonResponse = {
  status: number;
  /** header 名统一小写 */
  headers: Record<string, string>;
  text: string;
};

export type HttpJson = (req: HttpJsonRequest) => Promise<HttpJsonResponse>;

export type ConnectorFetchContext = {
  config: StoredConnector;
  token: string;
  http: HttpJson;
};

export type ConnectorFetchResult = {
  items: ExternalNotification[];
  /** false = 分页未拉全，sidecar 不得结算缺失项 */
  complete: boolean;
  accountName?: string;
  rateLimit?: { remaining?: number; resetAt?: number };
};

export type ConnectorTestResult = {
  accountName?: string;
  itemCount?: number;
};

/**
 * 可订阅来源（repo / 项目 / team）：触发器表单「选代替填」的下拉数据。
 * id 必须与该平台 fetch() 产物 ExternalNotification.sourceName 同口径，
 * 否则触发器按 sourceName 过滤时永远匹配不上。
 */
export type ConnectorSource = {
  id: string;
  /** 展示名；缺省用 id */
  label?: string;
};

export type ConnectorAdapter = {
  provider: InboxConnectorProvider;
  /** 通知文案里的来源名 */
  label: string;
  fetch(ctx: ConnectorFetchContext): Promise<ConnectorFetchResult>;
  test(ctx: ConnectorFetchContext): Promise<ConnectorTestResult>;
  /** 列出可订阅来源；不支持/失败时 UI 回落手动输入。 */
  listSources?(ctx: ConnectorFetchContext): Promise<ConnectorSource[]>;
  /** 按需拉取 issue 正文/评论；渲染层选中条目时调用 */
  detail?(
    ctx: ConnectorFetchContext,
    input: {
      key: string;
      type?: string;
      externalId?: string;
    },
  ): Promise<import("pi-protocol").InboxExternalDetail>;
  /** PR/MR 只读 diff；不支持的平台缺省即可（UI 隐藏 Code tab） */
  pullRequestDiff?(
    ctx: ConnectorFetchContext,
    input: {
      key: string;
      type?: string;
      externalId?: string;
      headSha?: string;
    },
  ): Promise<import("pi-protocol").InboxExternalDiff>;
  /** PR/MR 只读 checks；不支持的平台缺省即可（UI 隐藏 Checks tab） */
  pullRequestChecks?(
    ctx: ConnectorFetchContext,
    input: {
      key: string;
      type?: string;
      externalId?: string;
      headSha?: string;
    },
  ): Promise<import("pi-protocol").InboxExternalChecks>;
  /** 发表评论/回复；不支持的平台缺省（UI 隐藏输入框） */
  postComment?(
    ctx: ConnectorFetchContext,
    input: {
      key: string;
      type?: string;
      externalId?: string;
      body: string;
      replyToId?: string;
    },
  ): Promise<void>;
  /** PR/MR 写操作；不支持的平台/动作返回错误 */
  pullRequestAction?(
    ctx: ConnectorFetchContext,
    input: {
      key: string;
      type?: string;
      externalId?: string;
      action: import("pi-protocol").InboxPullRequestAction;
      /** merge 时锁定 head */
      headSha?: string;
    },
  ): Promise<void>;
};

export type ConnectorRuntime = {
  config: StoredConnector;
  token: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  failCount: number;
  /** 首次成功同步只标记已见，不补弹历史通知 */
  primed: boolean;
  seenKeys: Set<string>;
  lastItems: ExternalNotification[];
  lastComplete: boolean;
  lastSyncAt?: string;
  accountName?: string;
  rateLimitUntil?: number;
};
