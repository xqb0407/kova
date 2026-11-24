/**
 * 收件箱事项引用（「交给 Agent」）：把外部 issue/任务变成一条**原子芯片** +
 * 发送时展开的隐藏上下文块。与资料库引用（lib/composer/library-reference）
 * 同一套机制：
 *
 * - **芯片文本**（输入框/消息里显示）：`:inbox[标题]{name=inbox:<encItemId>}`
 *   —— cm-directive 的 Decoration.replace 原子芯片；上下文不再是整段文字，
 *   composer 里只有一枚芯片 + 一行指令；
 * - **发送展开**（buildPiSendInput 调用本模块）：芯片原样保留（用户气泡渲染成
 *   芯片、编辑重发拿回芯片）；标题/链接/正文/最近评论放进正文末尾的隐藏块
 *   `[[inbox-ctx:boundary]]`，展示层剥离（splitPromptNotices / messageProjection）。
 * - **上下文在「交给 Agent」点击时快照**进 localStorage（inbox.agentContext.v1）：
 *   重启后重发芯片仍能展开出标题/链接；正文超出或读取失败时该条降级为
 *   「上下文已失效」，只带 key/链接，绝不静默丢失。
 *
 * 本模块保持纯函数（只依赖 localStorage 与 directive 文本格式），发送链路与
 * 测试可直接引用。
 */

export const INBOX_DIRECTIVE_TYPE = "inbox";
const STORAGE_KEY = "inbox.agentContext.v1";
/** 上下文条目上限（条数 + 单条体积）：正文截断 + 淘汰最旧，防 localStorage 撑爆 */
const MAX_ENTRIES = 24;
const MAX_BODY_CHARS = 8_000;
const MAX_COMMENT_CHARS = 800;
const MAX_COMMENTS = 3;
const MAX_ENTRY_BYTES = 48_000;

/** 「交给 Agent」点击时固化的事项快照 */
export type InboxAgentContext = {
  itemId: string;
  /** 展示用：来源名 / 类型名（"GitHub" / "Issue"） */
  providerLabel: string;
  typeLabel: string;
  /** 编号（HER-5 / owner/repo#1），拿不到时退 sourceId */
  key: string;
  title: string;
  url?: string;
  status?: string;
  assignee?: string;
  body?: string;
  comments?: Array<{ author: string; body: string }>;
};

/* ------------------------------ 指令 id 构造与解析 ------------------------------ */

export function buildInboxDirectiveId(itemId: string): string {
  return `inbox:${encodeURIComponent(itemId)}`;
}

export function parseInboxDirectiveId(
  id: string,
): { itemId: string } | null {
  if (!id.startsWith("inbox:")) return null;
  const itemId = decodeURIComponent(id.slice("inbox:".length));
  return itemId ? { itemId } : null;
}

/** 芯片文本：`:inbox[标题]{name=inbox:<encItemId>}`（label 截到 60 字） */
export function buildInboxChip(ctx: InboxAgentContext): string {
  const label = ctx.title.length > 60 ? `${ctx.title.slice(0, 60)}…` : ctx.title;
  return `:inbox[${label}]{name=${buildInboxDirectiveId(ctx.itemId)}}`;
}

const INBOX_CHIP_RE =
  /:inbox\[([^\]\n]{1,1024})\]\{name=inbox:([^}\n]{1,1024})\}/gu;

/* ------------------------------ 上下文快照存取 ------------------------------ */

/** localStorage 引用：SSR/隐私模式下可能没有或访问即抛，统一收敛到这里 */
function localStorageRef(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readStore(): Record<string, InboxAgentContext> {
  const storage = localStorageRef();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, InboxAgentContext> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const ctx = value as Partial<InboxAgentContext>;
      if (typeof ctx?.itemId === "string" && typeof ctx?.title === "string") {
        out[key] = ctx as InboxAgentContext;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 点击「交给 Agent」时固化上下文；超限淘汰最旧条目 */
export function saveInboxAgentContext(context: InboxAgentContext): void {
  const storage = localStorageRef();
  if (!storage) return;
  const store = readStore();
  store[context.itemId] = context;
  // 淘汰最旧：按插入顺序近似（对象键序）；超体积条目只留标题/链接
  const entries = Object.entries(store);
  while (entries.length > MAX_ENTRIES) {
    const oldest = entries.shift();
    if (!oldest) break;
    delete store[oldest[0]];
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式/超配额：芯片仍在，展开降级为 key+链接 */
  }
}

export function loadInboxAgentContext(
  itemId: string,
): InboxAgentContext | undefined {
  return readStore()[itemId];
}

/** 从收件箱条目 + 已加载详情组装快照（与旧 buildAgentPrompt 的截断口径一致） */
export function buildInboxAgentContext(input: {
  itemId: string;
  providerLabel: string;
  typeLabel: string;
  key: string;
  title: string;
  url?: string;
  status?: string;
  assignee?: string;
  body?: string;
  comments?: Array<{ author?: string; body: string }>;
}): InboxAgentContext {
  return {
    itemId: input.itemId,
    providerLabel: input.providerLabel,
    typeLabel: input.typeLabel,
    key: input.key,
    title: input.title,
    ...(input.url ? { url: input.url } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.assignee ? { assignee: input.assignee } : {}),
    ...(input.body
      ? { body: input.body.slice(0, MAX_BODY_CHARS) }
      : {}),
    ...(input.comments && input.comments.length > 0
      ? {
          comments: input.comments
            .slice(0, MAX_COMMENTS)
            .map((comment) => ({
              author: comment.author ?? "",
              body: comment.body.slice(0, MAX_COMMENT_CHARS),
            })),
        }
      : {}),
  };
}

/* ------------------------------ 发送展开 ------------------------------ */

/**
 * 扫描 userText 里的收件箱芯片 → 汇总成一个隐藏上下文块（随机边界防正文撞界）。
 * 没有芯片时返回 null。上下文缺失的条目仍写一节「key + 已失效」，让模型知道
 * 有这么个事项而不是静默消失。
 */
export function buildInboxContextBlock(
  userText: string,
  boundary: string,
): string | null {
  const ids = new Set<string>();
  for (const match of userText.matchAll(INBOX_CHIP_RE)) {
    // match[2] 是 `name=inbox:` 之后的编码段；parse 收的是完整 id，补回前缀
    const parsed = parseInboxDirectiveId(`inbox:${match[2]}`);
    if (parsed) ids.add(parsed.itemId);
  }
  if (ids.size === 0) return null;
  const lines: string[] = [];
  for (const itemId of ids) {
    const ctx = loadInboxAgentContext(itemId);
    if (!ctx) {
      lines.push(`### （上下文已失效：${itemId}）`);
      continue;
    }
    lines.push(
      `### ${ctx.providerLabel} ${ctx.typeLabel}${ctx.key ? ` ${ctx.key}` : ""}`,
      `标题：${ctx.title}`,
    );
    if (ctx.url) lines.push(`链接：${ctx.url}`);
    if (ctx.status) lines.push(`状态：${ctx.status}`);
    if (ctx.assignee) lines.push(`负责人：${ctx.assignee}`);
    const body = ctx.body || "";
    if (body) {
      lines.push("", "正文：", body);
    }
    if (ctx.comments && ctx.comments.length > 0) {
      lines.push("", "最近评论：");
      for (const comment of ctx.comments) {
        lines.push(`- ${comment.author || "（未知作者）"}: ${comment.body}`);
      }
    }
    lines.push("");
  }
  return `[[inbox-ctx:${boundary}]]\n${lines.join("\n").trimEnd()}\n[[/inbox-ctx:${boundary}]]`;
}
