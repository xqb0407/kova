/**
 * 历史窗口（§6 分页）：get_history 的窗口式拉取 + 游标簿记 + 每轮耗时播种。
 *
 * sidecar 侧协议已就绪：`tail` 取尾部 N 行、`beforeSeq` 取严格早于游标的行，
 * 应答带 firstSeq/lastSeq/hasMore。首屏只取尾部窗口（HISTORY_TAIL_ROWS），
 * 用户往上滚到顶时用 beforeSeq=firstSeq 再取一窗，prepend 进消息流。
 *
 * 时间戳播种：转录行带逐条 timestamp（ms）经 metadata.createdAt 下发，这里
 * 按轮次折算两端（用户行≈轮初、assistant 行≈轮末）写进轮次耗时台账，供
 * 折叠摘要头显示历史轮耗时。
 */
import { piRequest } from "@/lib/pi/pi-bridge";
import { scopedTurnKey, seedTurnTiming } from "@/lib/panels/turn-collapse";

/** 首屏历史窗的消息行上限（§6）：2000+ 行转录只取尾部这么多条 */
export const HISTORY_TAIL_ROWS = 800;
/** 往上翻页每窗行数：一屏左右，够快又不至于一次塞太多 */
export const HISTORY_PAGE_ROWS = 200;

export type HistoryWindowMeta = {
  firstSeq: number | null;
  hasMore: boolean;
};

const windowMeta = new Map<string, HistoryWindowMeta>();

/** 窗口元数据（滚动到顶判断是否还有更早历史用） */
export function getHistoryWindowMeta(remoteId: string): HistoryWindowMeta | undefined {
  return windowMeta.get(remoteId);
}

export function setHistoryWindowMeta(remoteId: string, meta: HistoryWindowMeta): void {
  windowMeta.set(remoteId, meta);
}

export function clearHistoryWindowMeta(remoteId: string): void {
  windowMeta.delete(remoteId);
}

export type HistoryWindow = {
  messages: unknown[];
  pending?: unknown[];
  meta: HistoryWindowMeta;
};

/**
 * 拉一窗历史（tail 取尾部 / beforeSeq 取游标之前，二选一）。
 * 分页元数据在应答里，同时记账到窗口表供滚动翻页判断。
 */
export async function fetchHistoryWindow(
  remoteId: string,
  opts: { tail?: number; beforeSeq?: number },
): Promise<HistoryWindow> {
  const res = await piRequest<{
    type: "history";
    messages: unknown[];
    pending?: unknown[];
    firstSeq?: number | null;
    lastSeq?: number | null;
    hasMore?: boolean;
  }>({
    type: "get_history",
    sessionId: remoteId,
    ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
    ...(opts.beforeSeq !== undefined ? { beforeSeq: opts.beforeSeq } : {}),
  });
  const meta: HistoryWindowMeta = {
    firstSeq: typeof res.firstSeq === "number" ? res.firstSeq : null,
    hasMore: res.hasMore === true,
  };
  setHistoryWindowMeta(remoteId, meta);
  return { messages: res.messages, pending: res.pending, meta };
}

type UiMessageLike = {
  id?: unknown;
  role?: unknown;
  metadata?: unknown;
};

/** UIMessage.metadata.createdAt → ms（sidecar 下发的是 Unix ms；容忍秒级） */
function messageCreatedAt(message: UiMessageLike): number | undefined {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const createdAt = (metadata as { createdAt?: unknown }).createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
    return undefined;
  }
  // 秒级时间戳（< 1e12）换算成毫秒，兼容上游差异
  return createdAt < 1e12 ? createdAt * 1000 : createdAt;
}

/**
 * 按轮次把历史时间戳播种进耗时台账：一轮 = 一条 user 消息 + 其后连续的
 * assistant 消息（与 message-turns 的 buildTurnIndex 同规则，这里只需 role）。
 * 两端取该轮首条与末条消息的时间戳——转录里用户行在轮初写下、assistant 行
 * 在轮末（agent_end）写下，差值即本轮耗时。
 *
 * startsAtBeginning=false（往上翻的一页）时，窗口首条可能是上一页某轮的
 * 中途（assistant 行），该残段不播种——它的轮次键（首条 user 消息）不在
 * 本窗内，播种出去也对不上。
 */
export function seedHistoryTurnTimings(
  threadId: string | undefined,
  messages: readonly unknown[],
  opts: { startsAtBeginning?: boolean } = {},
): void {
  if (!threadId) return;
  const { startsAtBeginning = true } = opts;
  let turnStart: { key: string; at: number } | null = null;
  let lastAt: number | null = null;
  let seenUser = startsAtBeginning;

  const flush = () => {
    if (turnStart) {
      const timing =
        lastAt !== null && lastAt > turnStart.at
          ? { start: turnStart.at, end: lastAt }
          : { start: turnStart.at };
      seedTurnTiming(scopedTurnKey(threadId, turnStart.key), timing);
    }
    turnStart = null;
    lastAt = null;
  };

  for (const item of messages) {
    const message = item as UiMessageLike;
    const id = typeof message.id === "string" ? message.id : undefined;
    const at = messageCreatedAt(message);
    if (!id || at === undefined) continue;
    if (message.role === "user") {
      if (turnStart) flush();
      seenUser = true;
    } else if (!seenUser) {
      // 窗口从会话中途开始：上游残段不播种
      continue;
    }
    if (!turnStart) turnStart = { key: id, at };
    lastAt = at;
  }
  flush();
}
