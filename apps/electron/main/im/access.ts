/**
 * IM 入站访问控制（顺序固定，宁拒不漏）：
 * ① 去重：eventId LRU（1000 条 / 5min TTL，命中静默丢弃——平台会重推）
 * ② 消息状态/回环门由适配器前置过滤（只投 FINISH、滤 BOT 自身），
 *    这里不重复；群聊走独立的「通道开关 + @机器人 + 群内权限」门，**绝不经过
 *    owner 门**——群成员不能因为先发了一条群消息就被 bootstrap 成私聊 owner。
 * ③ 私聊 owner 门：每通道首个私聊 senderId bootstrap 为 owner，此后其余发送者
 *    一律拒绝。owner 台账落 SQLite（im_owner 表），防重启后旁落。
 */
import { getDb } from "../store";
import {
  groupAccessAllowed,
  type GroupAccessPolicy,
  type ImGroupAccess,
} from "./group";
import type { ImInboundMessage } from "./types";

const DEDUP_LIMIT = 1000;
const DEDUP_TTL_MS = 5 * 60_000;

const seen = new Map<string, number>();

function dedupKey(msg: ImInboundMessage): string {
  return `${msg.platform}:${msg.channelId}:${msg.eventId ?? msg.messageId ?? ""}`;
}

/** ① 去重：true = 重复消息（丢弃） */
export function isDuplicateInbound(msg: ImInboundMessage): boolean {
  const key = dedupKey(msg);
  if (!key.endsWith(":")) {
    const now = Date.now();
    for (const [k, ts] of seen) {
      if (now - ts > DEDUP_TTL_MS) seen.delete(k);
    }
    const hit = seen.get(key);
    if (hit !== undefined) return true;
    seen.set(key, now);
    while (seen.size > DEDUP_LIMIT) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }
  return false;
}

/* ------------------------------ owner 台账 ------------------------------ */

function ensureOwnerTable(): void {
  getDb()
    .exec(
      "CREATE TABLE IF NOT EXISTS im_owner (channel_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
}

export function getImOwner(channelId: string): string | null {
  ensureOwnerTable();
  const row = getDb()
    .prepare("SELECT sender_id FROM im_owner WHERE channel_id = ?1")
    .get(channelId) as { sender_id: string } | undefined;
  return row?.sender_id ?? null;
}

export function resetImOwner(channelId: string): void {
  ensureOwnerTable();
  getDb().prepare("DELETE FROM im_owner WHERE channel_id = ?1").run(channelId);
}

/** ③ 私聊 owner 门：首个私聊发送者 bootstrap；命中 owner 放行，陌生人拒绝。
 *  群聊不会进入这里（见 checkInboundAccess 的 group 分支）。 */
export function passesOwnerGate(msg: ImInboundMessage): boolean {
  const owner = getImOwner(msg.channelId);
  if (owner === null) {
    getDb()
      .prepare(
        "INSERT INTO im_owner(channel_id, sender_id, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(channel_id) DO NOTHING",
      )
      .run(msg.channelId, msg.senderId, Date.now());
    return true;
  }
  return owner === msg.senderId;
}

/** 入站综合判定（三态，调用方据此决定静默/提示/放行）：
 *  - "dedup"：平台重推，静默丢弃
 *  - "deny"：群聊未开启/未 @，或非 owner 的陌生私聊
 *  - "allow"：放行进入路由
 */
export type ImAccessDecision = "allow" | "dedup" | "deny";

export function checkInboundAccess(
  msg: ImInboundMessage,
  opts: {
    groupEnabled?: boolean;
    groupAccess?: ImGroupAccess;
    ownerId?: string | null;
  } = {},
): ImAccessDecision {
  if (isDuplicateInbound(msg)) return "dedup";
  if (msg.chatType === "group") {
    // 群聊只认通道开关 + @ + 群内权限；绝不调用 passesOwnerGate
    const policy: GroupAccessPolicy = {
      groupEnabled: opts.groupEnabled === true,
      groupAccess: opts.groupAccess,
      ownerId: opts.ownerId,
    };
    return groupAccessAllowed(msg, policy) ? "allow" : "deny";
  }
  return passesOwnerGate(msg) ? "allow" : "deny";
}
