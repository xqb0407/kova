"use client";

/**
 * 收件箱「交给 Agent」的回链记录。
 *
 * 发送发生在聊天视图（新线程草稿期只有 __LOCALID_ 线程 id，真实 sessionId
 * 要等 sidecar 首帧返回后才经 piSessionRegistry 绑定），所以这里只记线程
 * id；「查看会话」点击时再换成 sessionId，换不出就按线程 id 直接切。
 * localStorage 持久化：轻量回链，不值得为此给收件箱 journal 加协议字段。
 */

export type SentAgentLink = {
  itemId: string;
  threadId: string;
  at: number;
};

const STORAGE_KEY = "inbox.sentToAgent.v1";
/** 挂起记录的有效期：超过就当作过期丢弃，避免把晚到的线程 id 记错条目 */
const PENDING_TTL_MS = 5_000;

let pendingItemId: string | null = null;
let pendingAt = 0;
/** localStorage 不是响应式数据源，写完要广播，详情面板才能刷出「查看会话」 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function read(): Record<string, SentAgentLink> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SentAgentLink> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const link = value as Partial<SentAgentLink>;
      if (
        typeof link?.itemId === "string" &&
        typeof link?.threadId === "string" &&
        typeof link?.at === "number"
      ) {
        out[key] = { itemId: link.itemId, threadId: link.threadId, at: link.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: Record<string, SentAgentLink>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式下没有 localStorage：回链降级为「去会话列表找」 */
  }
  emit();
}

/** 「交给 Agent」点击时挂起条目 id；发送侧同步记线程 id，兜底交给 Base 补记 */
export function markSentAgentPending(itemId: string): void {
  pendingItemId = itemId;
  pendingAt = Date.now();
}

export function consumeSentAgentPending(): string | null {
  if (!pendingItemId) return null;
  if (Date.now() - pendingAt > PENDING_TTL_MS) {
    pendingItemId = null;
    return null;
  }
  const itemId = pendingItemId;
  pendingItemId = null;
  return itemId;
}

export function recordSentAgentThread(itemId: string, threadId: string): void {
  const map = read();
  map[itemId] = { itemId, threadId, at: Date.now() };
  write(map);
}

export function sentAgentLinkOf(itemId: string): SentAgentLink | undefined {
  return read()[itemId];
}

/** 订阅回链变化：详情面板靠它把 localStorage 的写入变成可响应的 UI 更新 */
export function subscribeSentAgent(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
