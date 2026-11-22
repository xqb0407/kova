/**
 * Agent Inbox 的投影存储（docs/agent-inbox.md §5）。
 *
 * 事实源不在本模块：审批/提问在 transcript，目标在 goal_state 行，自动化在
 * tasks.json，子代理在活动文件，后台任务在宿主台账。这里只维护一份
 * append-only 投影日志 + 用户状态（已读/归档/稍后），供跨会话/跨端快速列表。
 *
 * 失败纪律：日志/状态写失败只记日志，绝不回滚或阻塞源流程；日志损坏时跳过
 * 非法行，源仍然权威，启动对账可修复。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  inboxItemSchema,
  type InboxChangedFrame,
  type InboxCounts,
  type InboxFilter,
  type InboxItem,
  type InboxOutcome,
} from "pi-protocol";
import { logErr } from "../log";
import { sessionsDirRoot } from "../storage/storage";
import { safePreview } from "./summary";

const MAX_ITEMS = 5000;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const COMPACT_EVERY_APPENDS = 500;
const TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 一次性迁移标记：只把旧日志的“用户已处理”条目置读，不能覆盖用户后来手动标未读 */
const HANDLED_READ_MIGRATION = "handled-read-v1";

export type InboxItemUserState = {
  readAt?: string;
  archivedAt?: string;
  snoozedUntil?: string;
  pinnedAt?: string;
  /** 用户墓碑删除：列表/计数永久隐藏，源再次 upsert 也不复活。
   *  只允许删除已结束（非 open）条目，避免把仍在等你的阻塞项一键清掉 */
  deletedAt?: string;
  /** 归档来自「会话归档」而不是用户逐条归档：取消会话归档时自动恢复，
   *  用户手动归档的条目不会被会话恢复误翻出来 */
  archivedBySession?: boolean;
};

export type InboxUpdatePatch = {
  read?: boolean;
  archived?: boolean;
  deleted?: boolean;
  snoozedUntil?: string | null;
};

export type InboxListResult = {
  items: InboxItem[];
  counts: InboxCounts;
  nextCursor?: string;
  /** 全量来源 facets，筛选菜单用；不受分页/当前筛选影响 */
  sources: string[];
};

/** 与桌面 inbox-filters.sourceOf 同口径：外部项用 provider，其余本地来源分类 */
function sourceOf(item: InboxItem): string {
  if (item.kind === "external") {
    return (
      item.external?.provider ||
      (typeof item.meta?.provider === "string" ? item.meta.provider : "external")
    );
  }
  if (item.kind === "automation") return "automation";
  if (item.kind === "subagent") return "subagent";
  if (item.kind === "background_task") return "background";
  return "task";
}

const SOURCE_ORDER = [
  "task",
  "automation",
  "subagent",
  "background",
  "github",
  "jira",
  "linear",
  "gitlab",
  "azure_devops",
];

function sortedSources(sources: Set<string>): string[] {
  const known = SOURCE_ORDER.filter((source) => sources.has(source));
  const unknown = [...sources]
    .filter((source) => !SOURCE_ORDER.includes(source))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...unknown];
}

type JournalRow =
  | { v: 1; op: "upsert"; at: string; item: InboxItem }
  | {
      v: 1;
      op: "resolve";
      at: string;
      id: string;
      outcome?: InboxOutcome;
      summary?: string;
    }
  /** 源记录被删除：投影物理移除，不留 expired 幽灵 */
  | { v: 1; op: "remove"; at: string; id: string };

/** 可被协议层翻译成结构化错误码；store 自身不认识线协议 */
export class InboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

let enabled = false;
let loaded = false;
/** 测试缝：直接指定 inbox 目录，避免测试改全局 sessionsDirRoot 影响同进程其它文件 */
let dirOverride: string | null = null;
let items = new Map<string, InboxItem>();
let userState = new Map<string, InboxItemUserState>();
let appendCount = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReason: InboxChangedFrame["reason"] = "upsert";
let pendingItemId: string | undefined;
let broadcaster: ((frame: InboxChangedFrame) => void) | null = null;
/** 启动后只做一次跨重启源对账；之后靠源侧 hook 维护 */
let reconcileDone = false;

const nowIso = () => new Date().toISOString();

function inboxDir(): string | null {
  if (dirOverride) return dirOverride;
  const root = sessionsDirRoot();
  return root ? join(root, "inbox") : null;
}

function journalPath(): string | null {
  const dir = inboxDir();
  return dir ? join(dir, "events.jsonl") : null;
}

function statePath(): string | null {
  const dir = inboxDir();
  return dir ? join(dir, "state.json") : null;
}

function ensureDir(): string | null {
  const dir = inboxDir();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (error) {
    logErr("inbox: create dir failed:", error);
    return null;
  }
}

/** 测试/启动时关闭（ACP）；关闭后所有写入与广播 no-op */
export function initInbox(options: { enabled: boolean }): void {
  const wasEnabled = enabled;
  enabled = options.enabled;
  if (!enabled) {
    loaded = true;
    items.clear();
    userState.clear();
    return;
  }
  // 从 ACP/关闭态重新启用时必须允许重新加载日志；已在运行中重复调用不重读。
  if (!wasEnabled) loaded = false;
}

export function isInboxEnabled(): boolean {
  return enabled;
}

export function setInboxBroadcaster(fn: ((frame: InboxChangedFrame) => void) | null): void {
  broadcaster = fn;
}

/* ------------------------------- 加载与落盘 ------------------------------- */

function applyRow(row: unknown): void {
  if (!row || typeof row !== "object") return;
  const r = row as Record<string, unknown>;
  if (r.v !== 1) return;
  if (r.op === "upsert") {
    const parsed = inboxItemSchema.safeParse(r.item);
    if (!parsed.success) return;
    items.set(parsed.data.id, parsed.data as InboxItem);
    return;
  }
  if (r.op === "remove") {
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) return;
    items.delete(id);
    userState.delete(id);
    return;
  }
  if (r.op === "resolve") {
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) return;
    const prev = items.get(id);
    if (!prev) return;
    const at = typeof r.at === "string" ? r.at : nowIso();
    const outcome =
      typeof r.outcome === "string" ? (r.outcome as InboxOutcome) : prev.outcome;
    items.set(id, {
      ...prev,
      state: "done",
      ...(outcome ? { outcome } : {}),
      requiresAction: false,
      // 旧 journal 的 resolve 行可能没带动作归一；读回时补上，保证详情/动作一致
      actions: ["open", "mark_read", "archive"],
      ...(typeof r.summary === "string" && r.summary ? { summary: safePreview(r.summary) } : {}),
      updatedAt: at,
    });
  }
}

function loadState(): void {
  const path = statePath();
  if (!path || !existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      v?: unknown;
      items?: Record<string, unknown>;
    };
    if (!raw || raw.v !== 1 || !raw.items || typeof raw.items !== "object") return;
    for (const [id, value] of Object.entries(raw.items)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const state: InboxItemUserState = {};
      if (typeof v.readAt === "string") state.readAt = v.readAt;
      if (typeof v.archivedAt === "string") state.archivedAt = v.archivedAt;
      if (typeof v.snoozedUntil === "string") state.snoozedUntil = v.snoozedUntil;
      if (typeof v.pinnedAt === "string") state.pinnedAt = v.pinnedAt;
      // 墓碑：漏掉这一行 = 重启后已删除条目全部复活
      if (typeof v.deletedAt === "string") state.deletedAt = v.deletedAt;
      if (v.archivedBySession === true) state.archivedBySession = true;
      if (Object.keys(state).length > 0) userState.set(id, state);
    }
  } catch (error) {
    logErr("inbox: load state failed:", error);
  }
}

function pruneToCap(): void {
  if (items.size <= MAX_ITEMS) return;
  const sorted = [...items.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  const keep = new Set<string>();
  for (const item of sorted) {
    if (keep.size < MAX_ITEMS || item.state === "open") keep.add(item.id);
  }
  for (const id of [...items.keys()]) {
    if (!keep.has(id)) {
      items.delete(id);
      // 墓碑不随投影淘汰：源以后若用同一 ID 再次上报，用户删过的条目不能复活；
      // 非删除条目在被淘汰后丢掉用户态即可（重新上报按新条目处理）
      if (!userState.get(id)?.deletedAt) userState.delete(id);
    }
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!enabled) return;
  const path = journalPath();
  if (path && existsSync(path)) {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          applyRow(JSON.parse(trimmed));
        } catch {
          // 撕裂行/未知行：跳过，源仍权威
        }
      }
    } catch (error) {
      logErr("inbox: load journal failed:", error);
    }
  }
  loadState();
  pruneToCap();
  const migrationPath = inboxDir() ? join(inboxDir()!, HANDLED_READ_MIGRATION) : null;
  if (!migrationPath || !existsSync(migrationPath)) {
    migrateUserHandledState();
    if (migrationPath) {
      try {
        const dir = ensureDir();
        if (dir) writeFileSync(migrationPath, nowIso(), { mode: 0o600 });
      } catch (error) {
        logErr("inbox: write migration marker failed:", error);
      }
    }
  }
  // 用户状态只保留还有条目的键，避免日志压缩后无限增长；墓碑例外——
  // 它是“永久删除”的唯一凭证，条目被淘汰后也必须留着防源复活
  for (const id of [...userState.keys()]) {
    if (items.has(id)) continue;
    if (userState.get(id)?.deletedAt) continue;
    userState.delete(id);
  }
}

/** 旧日志迁移：用户主动 Stop/resolve 的 done 条目在当时没有置已读，会误留在待关注 */
function migrateUserHandledState(): void {
  const now = nowIso();
  const userHandled = new Set<InboxOutcome>([
    "approved",
    "denied",
    "answered",
    "cancelled",
    "resolved",
    "stopped",
  ]);
  const normalized: InboxItem[] = [];
  let stateChanged = false;
  for (const item of items.values()) {
    let next = item;
    // 旧版把「用户 Stop」记成普通失败；迁移成 stopped + 历史
    if (
      item.kind === "automation" &&
      item.state === "done" &&
      item.outcome !== "stopped" &&
      /aborted by stop request|aborted by user|stopped by user/i.test(item.summary ?? "")
    ) {
      next = {
        ...item,
        title: item.title.replace(/^自动化失败：/u, "自动化已停止："),
        summary: "运行被手动停止",
        state: "done",
        outcome: "stopped",
        priority: 2,
        requiresAction: false,
        actions: ["open", "mark_read", "archive"],
        meta: { ...(item.meta ?? {}), stopped: true },
        updatedAt: now,
      };
      items.set(next.id, next);
      normalized.push(next);
    }
    const outcome = next.outcome;
    if (!outcome || !userHandled.has(outcome)) continue;
    const state = userState.get(next.id) ?? {};
    if (state.readAt) continue;
    userState.set(next.id, { ...state, readAt: now });
    stateChanged = true;
  }
  if (normalized.length > 0) {
    for (const item of normalized) {
      appendRow({ v: 1, op: "upsert", at: item.updatedAt, item });
    }
  }
  if (normalized.length > 0 || stateChanged) saveState();
}

/** 追加一行；失败只记日志，不抛回源流程 */
function appendRow(row: JournalRow): void {
  ensureLoaded();
  const path = journalPath();
  const dir = ensureDir();
  if (!path || !dir) return;
  try {
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    appendCount += 1;
    maybeCompact();
  } catch (error) {
    logErr("inbox: journal append failed:", error);
  }
}

function maybeCompact(): void {
  if (appendCount < COMPACT_EVERY_APPENDS) {
    const path = journalPath();
    if (!path || !existsSync(path)) return;
    try {
      if (statSync(path).size < MAX_JOURNAL_BYTES) return;
    } catch {
      return;
    }
  }
  compact();
}

function compact(): void {
  const path = journalPath();
  const dir = ensureDir();
  if (!path || !dir) return;
  const cutoff = Date.now() - TERMINAL_RETENTION_MS;
  // open 条目永不丢；终态条目按上限裁剪。旧实现先 slice 会把超出上限的
  // open 项一起裁掉，和 pruneToCap 的“open 全留”语义冲突。
  const openItems = [...items.values()].filter((item) => item.state === "open");
  const terminal = [...items.values()]
    .filter((item) => item.state !== "open" && Date.parse(item.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(0, MAX_ITEMS - openItems.length));
  const keep = [...openItems, ...terminal];
  const body = keep
    .map((item) => JSON.stringify({ v: 1, op: "upsert", at: item.updatedAt, item }))
    .join("\n");
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
    renameSync(tmp, path);
    appendCount = 0;
  } catch (error) {
    logErr("inbox: compact failed:", error);
  }
}

function saveState(): void {
  const path = statePath();
  if (!path || !ensureDir()) return;
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        v: 1,
        items: Object.fromEntries(userState.entries()),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } catch (error) {
    logErr("inbox: save state failed:", error);
  }
}

/* ------------------------------- 广播 ------------------------------- */

function notify(reason: InboxChangedFrame["reason"], itemId?: string): void {
  pendingReason = reason;
  if (itemId) pendingItemId = itemId;
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const frame: InboxChangedFrame = {
      type: "inbox_changed",
      reason: pendingReason,
      ...(pendingItemId ? { itemId: pendingItemId } : {}),
      counts: getInboxCounts(),
    };
    pendingItemId = undefined;
    try {
      broadcaster?.(frame);
    } catch (error) {
      logErr("inbox: broadcast failed:", error);
    }
  }, 100);
  (notifyTimer as { unref?: () => void }).unref?.();
}

/* ------------------------------- 读模型 ------------------------------- */

function withUserState(item: InboxItem): InboxItem {
  const state = userState.get(item.id);
  if (!state) return item;
  return {
    ...item,
    ...(state.readAt ? { readAt: state.readAt } : {}),
    ...(state.archivedAt ? { archivedAt: state.archivedAt } : {}),
    ...(state.snoozedUntil ? { snoozedUntil: state.snoozedUntil } : {}),
  };
}

function isSnoozed(item: InboxItem, now: number): boolean {
  if (!item.snoozedUntil) return false;
  const until = Date.parse(item.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

/** 用户墓碑删除：所有读模型（列表/计数/详情）统一在这里判 */
function isDeleted(id: string): boolean {
  return Boolean(userState.get(id)?.deletedAt);
}

export function getInboxCounts(): InboxCounts {
  ensureLoaded();
  const now = Date.now();
  const counts: InboxCounts = {
    needsAction: 0,
    unread: 0,
    attention: 0,
    open: 0,
    done: 0,
    archived: 0,
  };
  for (const raw of items.values()) {
    if (isDeleted(raw.id)) continue;
    const item = withUserState(raw);
    const archived = Boolean(item.archivedAt);
    if (archived) {
      counts.archived += 1;
      continue;
    }
    const snoozed = isSnoozed(item, now);
    if (item.requiresAction && !snoozed) counts.needsAction += 1;
    if (!item.readAt) counts.unread += 1;
    if ((item.requiresAction || !item.readAt) && !snoozed) counts.attention += 1;
    if (item.state === "open") counts.open += 1;
    // 失败的自动化/子代理仍是 done，但 requiresAction=true，属于「待处理」Tab；
    // 不计入「已完成」计数，否则 Tab 上的数字会和列表行数对不上。
    else if (!item.requiresAction) counts.done += 1;
  }
  return counts;
}

/** JSON 稳定序列化：meta 键序不同不应被当成变更；循环引用降级为占位符 */
function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry, seen)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    // 与 JSON.stringify 对齐：undefined 属性不参与指纹，否则重启后属性被丢弃，
    // 下一次 upsert 会被误判成“有更新”并重新标未读
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
    .join(",")}}`;
}

/**
 * 源侧指纹：包含所有源拥有的字段，排除时间戳（goal 每次 commit 都会刷新
 * createdAt/updatedAt）与用户状态。只比标题/摘要会漏掉状态、优先级、external
 * 元数据等更新。
 */
function sourceFingerprint(item: InboxItem): string {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    readAt: _readAt,
    archivedAt: _archivedAt,
    snoozedUntil: _snoozedUntil,
    ...source
  } = item;
  return stableStringify(source);
}

function matchesFilter(item: InboxItem, filter: InboxFilter, now: number): boolean {
  const archived = Boolean(item.archivedAt);
  const snoozed = isSnoozed(item, now);
  // 已归档条目不再受 snooze 影响：旧数据可能残留「归档 + snooze」，
  // 已归档 Tab 必须能看到才能恢复
  if (!filter.includeSnoozed && snoozed && filter.tab !== "archived") return false;
  switch (filter.tab ?? "action") {
    case "action":
      if (!item.requiresAction || archived) return false;
      break;
    case "done":
      if (item.state === "open" || item.requiresAction || archived) return false;
      break;
    case "archived":
      if (!archived) return false;
      break;
    case "attention":
      // 桌面「待关注」：需要处理或未读，且未归档/未 snooze
      if (archived || (!item.requiresAction && item.readAt)) return false;
      break;
    case "history":
      // 桌面「历史」：已读、已结束（不含归档——归档有独立的「已归档」Tab，
      // 否则用户归档后条目还留在历史里，看起来像没生效）
      if (archived) return false;
      if (item.requiresAction || !item.readAt) return false;
      break;
    case "all":
      break;
  }
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(item.kind)) {
    return false;
  }
  if (filter.source && sourceOf(item) !== filter.source) return false;
  if (filter.sessionId && item.sessionId !== filter.sessionId) return false;
  if (filter.projectId && item.projectId !== filter.projectId) return false;
  const query =
    typeof filter.query === "string" ? filter.query.trim().toLowerCase() : "";
  if (query) {
    const ext = item.external;
    const taskName = typeof item.meta?.taskName === "string" ? item.meta.taskName : "";
    const haystack =
      `${item.title} ${item.summary ?? ""} ${item.kind} ${item.sourceId} ` +
      `${ext?.provider ?? ""} ${ext?.sourceName ?? ""} ${ext?.key ?? ""} ${taskName}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function encodeCursor(item: InboxItem): string {
  return Buffer.from(
    JSON.stringify({ p: item.priority, c: item.createdAt, i: item.id }),
    "utf8",
  ).toString("base64url");
}

type InboxCursor = { priority: number; createdAt: string; id: string };

function decodeCursor(cursor: string | undefined): InboxCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      p?: unknown;
      c?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.p !== "number" ||
      !Number.isInteger(parsed.p) ||
      parsed.p < 0 ||
      parsed.p > 3 ||
      typeof parsed.c !== "string" ||
      !Number.isFinite(Date.parse(parsed.c)) ||
      typeof parsed.i !== "string"
    ) {
      return null;
    }
    return { priority: parsed.p, createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

function compareItems(a: InboxItem, b: InboxItem, tab: InboxFilter["tab"]): number {
  const mode = tab ?? "action";
  // 待处理/待关注都是注意力队列：P0 阻塞最前，同优先级里阻塞越久越靠前。
  // 其余 Tab 按时间倒序。
  if (mode === "action" || mode === "attention") {
    return (
      a.priority - b.priority ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  }
  return (
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)
  );
}

export function listInbox(
  filter: InboxFilter = {},
  limit = 50,
  cursor?: string,
): InboxListResult {
  ensureLoaded();
  const now = Date.now();
  const all = [...items.values()]
    // 墓碑删除的条目不再参与任何 Tab/筛选/来源 facets
    .filter((item) => !isDeleted(item.id))
    .map(withUserState);
  const matched = all
    .filter((item) => matchesFilter(item, filter, now))
    .sort((a, b) => compareItems(a, b, filter.tab));
  const cursorValue = decodeCursor(cursor);
  // 游标按排序键（priority/createdAt/id）越过，而不是按“当前页最后一条还在不在”：
  // 用户在两页之间把最后一条标已读/归档后，按 id 找不到会从第一页重头再来。
  const cursorItem = cursorValue
    ? ({ priority: cursorValue.priority, createdAt: cursorValue.createdAt, id: cursorValue.id } as InboxItem)
    : null;
  const start = cursorItem
    ? (() => {
        const index = matched.findIndex(
          (item) => compareItems(item, cursorItem, filter.tab) > 0,
        );
        return index < 0 ? matched.length : index;
      })()
    : 0;
  const take = Math.min(100, Math.max(1, Math.floor(limit || 50)));
  const page = matched.slice(start, start + take);
  const last = page.at(-1);
  return {
    items: page,
    counts: getInboxCounts(),
    sources: sortedSources(new Set(all.map(sourceOf))),
    ...(last && start + take < matched.length
      ? { nextCursor: encodeCursor(last) }
      : {}),
  };
}

export function getInboxItem(id: string): InboxItem | undefined {
  ensureLoaded();
  if (isDeleted(id)) return undefined;
  const item = items.get(id);
  return item ? withUserState(item) : undefined;
}

/* ------------------------------- 写模型 ------------------------------- */

/**
 * 源侧 upsert。相同标题/摘要/状态的重复 upsert 直接跳过，避免目标每次进度
 * 变化都追加一行。用户状态字段不信任来源，一律剥离。
 */
export function upsertInboxItem(
  item: InboxItem,
  options: { markRead?: boolean } = {},
): void {
  if (!enabled) return;
  ensureLoaded();
  const {
    readAt: _readAt,
    archivedAt: _archivedAt,
    snoozedUntil: _snoozedUntil,
    ...source
  } = item;
  // outcome=stopped 本身就是“用户已停”，即使调用方忘了 markRead 也不该再提醒
  const markRead = options.markRead === true || source.outcome === "stopped";
  const prev = items.get(item.id);
  if (prev && sourceFingerprint(prev) === sourceFingerprint(source)) {
    if (markRead) settleUserState(item.id);
    return;
  }
  // 同一 ID 的源有了实质更新（外部 issue 新状态、目标新暂停原因、后台任务
  // 二次结算）：把已读/snooze 清掉，让它重新以「有更新」进入待关注。
  // 已归档保持归档（用户显式收起的，不因一次更新强行翻出来）。
  if (prev) {
    const state = userState.get(item.id);
    if (state?.readAt || state?.snoozedUntil) {
      const nextState = { ...state };
      delete nextState.readAt;
      delete nextState.snoozedUntil;
      if (Object.keys(nextState).length > 0) userState.set(item.id, nextState);
      else userState.delete(item.id);
      saveState();
    }
  }
  const next: InboxItem = { ...source, updatedAt: nowIso() };
  items.set(next.id, next);
  pruneToCap();
  appendRow({ v: 1, op: "upsert", at: next.updatedAt, item: next });
  // 用户主动 Stop 的终态直接算已处理：进历史，不占待关注。
  if (markRead) settleUserState(next.id);
  notify("upsert", next.id);
}

/**
 * 条目结算后的用户状态收口：结算意味着人已经处理过（审批/提问/目标恢复都
 * 是用户动作），必须同时置已读——否则 done + readAt 缺失会按「未读结果」继续
 * 留在待关注 Tab。顺便清掉 snooze，避免已结算项被稍后提醒藏起来。
 */
function settleUserState(id: string): void {
  const current = userState.get(id) ?? {};
  const next: InboxItemUserState = { ...current };
  let changed = false;
  if (!next.readAt) {
    next.readAt = nowIso();
    changed = true;
  }
  if (next.snoozedUntil) {
    delete next.snoozedUntil;
    changed = true;
  }
  if (!changed) return;
  if (Object.keys(next).length > 0) userState.set(id, next);
  else userState.delete(id);
  saveState();
}

export function resolveInboxItem(
  id: string,
  outcome: InboxOutcome,
  summary?: string,
): boolean {
  if (!enabled) return false;
  ensureLoaded();
  const prev = items.get(id);
  if (!prev) return false;
  if (prev.state === "done" && prev.outcome === outcome) {
    settleUserState(id);
    return true;
  }
  const at = nowIso();
  items.set(id, {
    ...prev,
    state: "done",
    outcome,
    requiresAction: false,
    // 结算后不再保留 approve/deny/retry 等动作，避免详情页画出会失败的按钮
    actions: ["open", "mark_read", "archive"],
    ...(summary ? { summary: safePreview(summary) } : {}),
    updatedAt: at,
  });
  // 先落 resolve 行再改用户状态：崩溃窗口里 item 至少是 done/未读，
  // 不会出现“源已结算但 Inbox 仍是 open”的假悬挂。
  appendRow({
    v: 1,
    op: "resolve",
    at,
    id,
    outcome,
    ...(summary ? { summary: safePreview(summary) } : {}),
  });
  settleUserState(id);
  notify("resolve", id);
  return true;
}

export function expireInboxItem(id: string): void {
  if (!enabled) return;
  ensureLoaded();
  const prev = items.get(id);
  if (!prev) return;
  const at = nowIso();
  const next: InboxItem = {
    ...prev,
    state: "expired",
    requiresAction: false,
    // 源已消失：只允许归档，不再提供打开/审批等会失败的动作
    actions: ["archive"],
    updatedAt: at,
  };
  items.set(id, next);
  appendRow({ v: 1, op: "upsert", at, item: next });
  settleUserState(id);
  notify("expire", id);
}

export function expireInboxItemsForSession(sessionId: string): void {
  if (!enabled || !sessionId) return;
  ensureLoaded();
  for (const item of [...items.values()]) {
    if (item.sessionId === sessionId && item.state === "open") expireInboxItem(item.id);
  }
}

/** 自动化任务停用/暂停时，把它仍待处理的失败项收口进历史 */
export function resolveInboxItemsForAutomationTask(
  taskId: string,
  outcome: InboxOutcome = "resolved",
): number {
  if (!enabled || !taskId) return 0;
  ensureLoaded();
  let resolved = 0;
  for (const item of [...items.values()]) {
    if (
      item.kind === "automation" &&
      item.meta?.taskId === taskId &&
      item.requiresAction
    ) {
      if (resolveInboxItem(item.id, outcome)) resolved += 1;
    }
  }
  return resolved;
}

/** 物理移除一个投影条目并落 remove 行（源记录被删除时用） */
export function removeInboxItem(id: string): boolean {
  if (!enabled) return false;
  ensureLoaded();
  if (!items.has(id)) return false;
  items.delete(id);
  userState.delete(id);
  appendRow({ v: 1, op: "remove", at: nowIso(), id });
  saveState();
  notify("expire", id);
  return true;
}

/** 删掉自动化运行记录时，对应 Inbox 条目物理移除，避免历史页与记录页不一致 */
export function removeInboxItemsForAutomationRuns(
  taskId: string,
  runIds?: ReadonlySet<string>,
): number {
  if (!enabled || !taskId) return 0;
  ensureLoaded();
  let removed = 0;
  for (const item of [...items.values()]) {
    if (item.kind !== "automation" || item.meta?.taskId !== taskId) continue;
    const runId = typeof item.meta?.runId === "string" ? item.meta.runId : item.sourceId;
    if (runIds && !runIds.has(runId)) continue;
    if (removeInboxItem(item.id)) removed += 1;
  }
  return removed;
}

/** 无 sessionId 的早期交互按 threadId 清理（会话删除/换绑时） */
export function expireInboxItemsForThread(threadId: string): void {
  if (!enabled || !threadId) return;
  ensureLoaded();
  for (const item of [...items.values()]) {
    if (item.threadId === threadId && item.state === "open") expireInboxItem(item.id);
  }
}

/**
 * 跨重启源对账：重启后内存台账/目标槽位为空，open 条目必须回源核对，
 * 否则审批/提问/目标暂停项会永久挂在待关注。
 *
 * - 审批/提问：转录 pending 里还有 → 保留；没有（已结算/会话没了）→ expired。
 * - 目标：goal_state 行还在且 goal id 一致 → paused/blocked/proposed 保留；
 *   active 正常推进或 complete → resolved。
 * - 自动化/子代理/后台任务是 done 终态，依赖源侧 hook 与删除清理，不在这里回扫。
 *
 * 只在真实 sessions 目录下运行（测试 dirOverride 不做），每个进程一次。
 */
export async function reconcileInboxSources(): Promise<void> {
  if (!enabled || dirOverride) return;
  ensureLoaded();
  if (reconcileDone) return;
  reconcileDone = true;
  const open = [...items.values()]
    .filter((item) => item.state === "open")
    .slice(0, 100);
  if (open.length === 0) return;
  const { readGoalState, scanTranscript } = await import("../sessions/transcript");
  for (const item of open) {
    try {
      if (item.kind === "approval" || item.kind === "question") {
        if (!item.sessionId) continue;
        const stillPending = scanTranscript(item.sessionId).pending.some(
          (interaction) => interaction.interactionId === item.sourceId,
        );
        if (!stillPending) expireInboxItem(item.id);
        continue;
      }
      if (item.kind === "goal") {
        if (!item.sessionId) continue;
        const goal = readGoalState(item.sessionId);
        if (!goal || goal.id !== item.sourceId) {
          expireInboxItem(item.id);
          continue;
        }
        if (goal.status === "complete") {
          resolveInboxItem(item.id, "completed");
          continue;
        }
        if (
          goal.status === "active" &&
          goal.acceptance?.status !== "proposed"
        ) {
          resolveInboxItem(item.id, "resolved");
        }
      }
    } catch (error) {
      logErr(`inbox: reconcile ${item.id} failed:`, error);
    }
  }
}

/**
 * 按筛选条件批量更新用户状态（「全部已读」）。与 `updateInboxState` 的差别：
 * 不依赖客户端已加载的分页 id，跨页生效。已归档/已读等已满足的条目不重复写。
 * 批量归档同样跳过未结算阻塞项，绝不把审批藏起来。
 */
export function updateInboxStateForFilter(
  filter: InboxFilter | undefined,
  patch: InboxUpdatePatch,
): { itemIds: string[]; counts: InboxCounts } {
  if (!enabled) return { itemIds: [], counts: getInboxCounts() };
  ensureLoaded();
  const now = Date.now();
  // 未带 filter 时按 all 处理：语义是“全部”，不能退化成默认的 action 子集
  const resolved: InboxFilter = { tab: "all", ...filter };
  // 「全部已读」清扫（patch 同时带 read+archived）：已结束仍挂着 requiresAction
  // 的失败报告（子代理/后台命令/自动化）只标已读不会离开待关注，而 counts.unread
  // 清零后按钮变灰——「点了不会消失」的死局。清扫把它们收进已归档（可恢复），
  // 兑现桌面端「清空整个待关注」的语义。真正等你决定的（open + requiresAction：
  // 审批/提问/目标）只标已读、绝不归档——不能把等你决定的事藏掉；snooze 中的
  // 条目同样只标已读（到点还要回来提醒，归档会杀掉提醒）。
  if (patch.read === true && patch.archived === true) {
    const readIds: string[] = [];
    const sweepIds: string[] = [];
    const sweepArchiveOnlyIds: string[] = [];
    for (const raw of items.values()) {
      // 墓碑（已删除）不参与清扫：归档会给只保留 deletedAt 的 userState 行
      // 重新写回 readAt/archivedAt，破坏「墓碑只有一个语义」的不变量
      if (isDeleted(raw.id)) continue;
      const item = withUserState(raw);
      if (!matchesFilter(item, resolved, now)) continue;
      if (item.archivedAt) continue;
      if (isSnoozed(item, now) || (item.state === "open" && item.requiresAction)) {
        if (!item.readAt) readIds.push(item.id);
        continue;
      }
      if (item.requiresAction !== true) {
        // 普通完成条目：标已读即自然离开待关注，不归档（留在历史 Tab）
        if (!item.readAt) readIds.push(item.id);
        continue;
      }
      if (!item.readAt) sweepIds.push(item.id);
      else sweepArchiveOnlyIds.push(item.id);
    }
    // 响应 itemIds 取三批的并集：inbox_updated 的回执语义是「实际生效的条目」，
    // 只返回最后一批会丢前两批的回执
    const readResult = updateInboxState(readIds, { read: true });
    const archiveResult = updateInboxState(sweepArchiveOnlyIds, { archived: true });
    const sweepResult = updateInboxState(sweepIds, { read: true, archived: true });
    return {
      itemIds: [...readResult.itemIds, ...archiveResult.itemIds, ...sweepResult.itemIds],
      counts: sweepResult.counts,
    };
  }
  const ids: string[] = [];
  for (const raw of items.values()) {
    const item = withUserState(raw);
    if (!matchesFilter(item, resolved, now)) continue;
    if (patch.archived === true && item.state === "open" && item.requiresAction) continue;
    // 已经处于目标状态的条目跳过，避免「全部已读」反复刷新 readAt 时间
    if (patch.read === true && item.readAt) continue;
    if (patch.read === false && !item.readAt) continue;
    if (patch.archived === true && item.archivedAt) continue;
    if (patch.archived === false && !item.archivedAt) continue;
    ids.push(item.id);
  }
  return updateInboxState(ids, patch);
}

/**
 * 会话归档联动：会话归档时把它的收件箱条目一并收起，取消归档时恢复。
 * - 未结算的阻塞项（审批/提问/目标）不藏：归档会话不能把仍在等你的决定藏没；
 * - 只恢复「因会话归档而收起」的条目，用户手动归档的不受影响。
 */
export function setInboxItemsArchivedForSession(
  sessionId: string,
  archived: boolean,
): number {
  if (!enabled || !sessionId) return 0;
  ensureLoaded();
  const now = nowIso();
  let changed = 0;
  for (const item of items.values()) {
    if (item.sessionId !== sessionId && item.threadId !== sessionId) continue;
    const current = userState.get(item.id) ?? {};
    if (archived) {
      if (current.archivedAt) continue;
      if (item.state === "open" && item.requiresAction) continue;
      const next: InboxItemUserState = {
        ...current,
        archivedAt: now,
        archivedBySession: true,
      };
      // 会话都归档了，稍后提醒没有意义；留着会在 snooze 到点后重新冒出来
      delete next.snoozedUntil;
      userState.set(item.id, next);
    } else {
      if (!current.archivedBySession) continue;
      const next: InboxItemUserState = { ...current };
      delete next.archivedAt;
      delete next.archivedBySession;
      if (Object.keys(next).length > 0) userState.set(item.id, next);
      else userState.delete(item.id);
    }
    changed += 1;
  }
  if (changed > 0) {
    saveState();
    notify("archive");
  }
  return changed;
}

/**
 * 用户状态更新（已读/归档/稍后）。未结算的阻塞项不允许归档——那会把审批藏起来。
 * 返回实际处理的 itemIds；不存在的 id 静默跳过（幂等）。
 */
export function updateInboxState(
  itemIds: string[],
  patch: InboxUpdatePatch,
): { itemIds: string[]; counts: InboxCounts } {
  if (!enabled) return { itemIds: [], counts: getInboxCounts() };
  ensureLoaded();
  const now = nowIso();
  // 先全量校验再落内存：批量里只要一条非法（阻塞项归档/坏 snooze），
  // 不能把前面几条已经改掉却不落盘、不广播。
  const changes: Array<{ id: string; next: InboxItemUserState | null }> = [];
  for (const id of [...new Set(itemIds)]) {
    const item = items.get(id);
    if (!item) continue;
    const current = userState.get(id) ?? {};
    if (patch.archived === true && item.state === "open" && item.requiresAction) {
      throw new InboxError(
        "INBOX_ACTION_NOT_ALLOWED",
        "inbox: cannot archive an open actionable item; resolve it or snooze it first",
      );
    }
    // 删除是墓碑（不可撤销）：只允许已结束的条目。open 条目可能仍在等审批/
    // 提问/目标决定，先结算或归档，避免一键把待处理事项抹掉
    if (patch.deleted === true && item.state === "open") {
      throw new InboxError(
        "INBOX_ACTION_NOT_ALLOWED",
        "inbox: only settled items can be deleted; resolve it first",
      );
    }
    const next: InboxItemUserState = { ...current };
    if (patch.read === true) next.readAt = now;
    if (patch.read === false) delete next.readAt;
    // 用户显式归档/取消归档后不再算“随会话归档”，避免会话恢复时把它翻出来
    if (patch.archived === true) {
      next.archivedAt = now;
      delete next.archivedBySession;
      // 已归档的条目不应该再被 snooze 挡在「已归档」Tab 之外
      delete next.snoozedUntil;
    }
    if (patch.archived === false) {
      delete next.archivedAt;
      delete next.archivedBySession;
    }
    if (patch.deleted === true) {
      // 墓碑只保留 deletedAt：列表/计数/详情统一按它隐藏，源再次 upsert 也不复活。
      // 其它用户态没有意义了，清掉让 state.json 小一点、语义只有一个“已删除”。
      next.deletedAt = now;
      delete next.readAt;
      delete next.archivedAt;
      delete next.archivedBySession;
      delete next.snoozedUntil;
      delete next.pinnedAt;
    }
    if (patch.deleted === false) delete next.deletedAt;
    if (patch.snoozedUntil === null || patch.snoozedUntil === "") {
      delete next.snoozedUntil;
    } else if (typeof patch.snoozedUntil === "string") {
      const parsed = Date.parse(patch.snoozedUntil);
      if (!Number.isFinite(parsed)) {
        throw new InboxError("INBOX_INVALID_SNOOZE", "inbox: invalid snoozedUntil");
      }
      next.snoozedUntil = new Date(parsed).toISOString();
    }
    changes.push({
      id,
      next: Object.keys(next).length > 0 ? next : null,
    });
  }
  const applied = changes.map((change) => change.id);
  for (const change of changes) {
    if (change.next) userState.set(change.id, change.next);
    else userState.delete(change.id);
  }
  if (applied.length > 0) {
    saveState();
    notify(
      // 删除后条目从所有 Tab 消失，按 expire 的语义广播（前端只关心重拉）
      patch.deleted === true
        ? "expire"
        : patch.archived !== undefined
          ? "archive"
          : "read",
      applied[applied.length - 1],
    );
  }
  return { itemIds: applied, counts: getInboxCounts() };
}

/* ------------------------------- 测试缝 ------------------------------- */

/** 测试缝：指定/清除 inbox 目录（不触碰全局 storage 初始化） */
export function setInboxDirForTest(dir: string | null): void {
  dirOverride = dir;
  loaded = false;
}

export function resetInboxForTest(): void {
  enabled = false;
  loaded = false;
  dirOverride = null;
  items = new Map();
  userState = new Map();
  appendCount = 0;
  reconcileDone = false;
  pendingItemId = undefined;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  broadcaster = null;
}

export function inboxSnapshotForTest(): InboxItem[] {
  ensureLoaded();
  return [...items.values()];
}
