/**
 * 收件箱连接器事项触发器的条件匹配（L1d，纯函数，无 Electron 依赖）。
 *
 * config: `{ provider, connectorId?, sourceName?, itemType? }`
 * - provider 必填，与连接器平台精确匹配（jira/gitlab/github/linear）；
 * - connectorId 缺省 = 该 provider 任意收件箱连接器；给了就精确匹配；
 * - sourceName 缺省 = 任意 repo / 项目；给了就按不区分大小写比对事项来源
 *   （Jira 项目 key、GitLab/GitHub repo 路径）；
 * - itemType 缺省 = 任意事项；issue ↔（issue/ticket），pr ↔
 *   （pull_request/merge_request），其余类型（discussion/release…）只在
 *   不设 itemType 时命中。
 */

export type ConnectorTriggerLike = {
  id: string;
  type: string;
  taskId: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type ConnectorItemLike = {
  /** 展示编号（KI-123 / repo#123 / group!12）；缺省用标题 */
  key?: string;
  title?: string;
  /** 来源（Jira 项目 key / GitLab·GitHub repo 路径） */
  sourceName?: string;
  /** 平台原始类型（ticket/issue/merge_request/pull_request/…） */
  type?: string;
};

export type ConnectorProvider = "jira" | "gitlab" | "github" | "linear";

export type ConnectorEventKey = {
  provider: string;
  /** 本次轮询的连接器 id */
  connectorId: string;
  /** 本批次新事项（任一命中即触发） */
  items: ConnectorItemLike[];
};

const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProvider, string> = {
  jira: "Jira",
  gitlab: "GitLab",
  github: "GitHub",
  linear: "Linear",
};

/** 平台原始类型 → 过滤口径；"other" = 不属于事项/MR 的通知类型 */
export function connectorItemKind(type: string | undefined): "issue" | "pr" | "other" {
  switch (type) {
    case "issue":
    case "ticket":
      return "issue";
    case "pull_request":
    case "merge_request":
      return "pr";
    default:
      return "other";
  }
}

/** 事项是否命中 itemType 过滤（未设置 = 任意） */
function matchesItemType(
  wanted: string | undefined,
  item: ConnectorItemLike,
): boolean {
  if (wanted !== "issue" && wanted !== "pr") return true;
  const kind = connectorItemKind(item.type);
  if (kind === "other") return false;
  return kind === wanted;
}

/**
 * 单个触发器对本批次事项的匹配结果：null = 不命中；否则返回**命中该触发器
 * 过滤条件**的事项子集（摘要只应反映这些事项，不能把未命中的也列进去）。
 */
function triggerMatchedItems(
  trigger: ConnectorTriggerLike,
  event: ConnectorEventKey,
): ConnectorItemLike[] | null {
  if (!trigger.enabled || trigger.type !== "connector") return null;
  const cfg = trigger.config;
  if (cfg.provider !== event.provider) return null;
  if (
    typeof cfg.connectorId === "string" &&
    cfg.connectorId &&
    cfg.connectorId !== event.connectorId
  ) {
    return null;
  }
  const matched = event.items.filter((item) => {
    if (typeof cfg.sourceName === "string" && cfg.sourceName) {
      const wanted = cfg.sourceName.toLowerCase();
      const source = (item.sourceName ?? "").toLowerCase();
      if (!source || source !== wanted) return false;
    }
    return matchesItemType(cfg.itemType as string | undefined, item);
  });
  return matched.length > 0 ? matched : null;
}

export type ConnectorTriggerMatch = {
  trigger: ConnectorTriggerLike;
  /** 命中该触发器过滤条件的事项子集 */
  items: ConnectorItemLike[];
};

export function matchConnectorTriggersWithItems(
  triggers: readonly ConnectorTriggerLike[],
  event: ConnectorEventKey,
): ConnectorTriggerMatch[] {
  const out: ConnectorTriggerMatch[] = [];
  for (const trigger of triggers) {
    const items = triggerMatchedItems(trigger, event);
    if (items) out.push({ trigger, items });
  }
  return out;
}

export function matchConnectorTriggers(
  triggers: readonly ConnectorTriggerLike[],
  event: ConnectorEventKey,
): ConnectorTriggerLike[] {
  return matchConnectorTriggersWithItems(triggers, event).map((m) => m.trigger);
}

/** 摘要单条上限与聚合条数（对齐 file watcher 的 ≤5 + …N more） */
const ITEM_TEXT_MAX = 60;
const SUMMARY_ITEMS_MAX = 5;
/**
 * 摘要总长预算：fire 出口（run_with_trigger / automation_trigger_fire）会把
 * summary 硬切到 200 字符——按预算组装保证"…N more"尾部不被截掉，
 * 宁少列一条也不让文案拦腰断。
 */
const SUMMARY_BUDGET_CHARS = 180;

function formatItem(item: ConnectorItemLike): string {
  const title = (item.title ?? "").replace(/\s+/g, " ").trim().slice(0, ITEM_TEXT_MAX);
  const key = (item.key ?? "").trim();
  return key && title ? `${key} ${title}` : key || title || "(untitled)";
}

/** 触发摘要：平台 + 事项列表（≤5 条 + …N more，总长守预算；出口再脱敏） */
export function connectorFireSummary(
  provider: ConnectorProvider | string,
  items: readonly ConnectorItemLike[],
): string {
  const label = CONNECTOR_PROVIDER_LABELS[provider as ConnectorProvider] ?? provider;
  const header = `${label}: `;
  const budget = SUMMARY_BUDGET_CHARS - header.length;
  const parts: string[] = [];
  let used = 0;
  for (const item of items.slice(0, SUMMARY_ITEMS_MAX)) {
    const part = formatItem(item);
    if (parts.length > 0 && used + part.length > budget) break;
    parts.push(part);
    used += part.length + 2; // "; "
  }
  const more = items.length - parts.length;
  const body = more > 0 ? `${parts.join("; ")} …${more} more` : parts.join("; ");
  return `${header}${body}`;
}
