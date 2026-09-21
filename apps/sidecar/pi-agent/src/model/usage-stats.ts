/**
 * 全局使用统计（设置 → 使用统计）：以 SQLite 物化表为查询源——
 *   usage_daily：会话 × 本地日 的 usage 聚合行（byModel 为 JSON）
 *   usage_scan：每会话扫描水位（JSONL mtime + 首末消息时间戳）
 * 转录 JSONL 仍是事实源。usage_stats 命令时增量维护：按文件 mtime 找出脏会话，
 * 整会话重算并整包替换其聚合行（先删后插，幂等——转录历史的重复 seq 由
 * readTranscript 去重，重算不会双计），然后纯 SQL 查出全部聚合行合并成逐日序列。
 * 已删会话的残留行随查询一并清理。不计入口径与 context.ts sessionUsageTotals
 * 一致（error/aborted 轮排除）。
 */
import { statSync } from "node:fs";
import { readTranscript } from "../sessions/transcript";
import {
  sessionList,
  usageDailyCleanup,
  usageDailyQuery,
  usageDailyReplace,
  usageScanList,
  type UsageDailyRow,
  type UsageDailyRowInput,
  type UsageScanRow,
} from "../storage/hostdb";
import { sessionPath } from "../storage/storage";
import { logErr } from "../log";

/** 单日聚合桶（本地时区，跨会话合并后） */
export type UsageStatsDay = {
  /** YYYY-MM-DD（本地） */
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  /** assistant 消息轮数 */
  messages: number;
  /** "provider/model" -> tokens */
  byModel: Record<string, number>;
};

export type UsageStatsResult = {
  /** 按日期升序；只含有活动的日子 */
  days: UsageStatsDay[];
  /** 有用量数据的会话数（usage_daily 中的 distinct session） */
  sessionCount: number;
  /** 首次活动日（YYYY-MM-DD），无任何活动为 null */
  firstActivity: string | null;
  /** 最长单会话跨度（首末消息时间差，毫秒；近似"聊天时长"） */
  longestChatMs: number;
};

/** 毫秒时间戳 → 本地日期键（与前端日历同口径） */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type UsageLike = Partial<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> | null;

/** 单会话转录 → 按日聚合行 + 会话跨度（整会话重算，幂等） */
function aggregateSessionTranscript(sessionId: string): {
  rows: UsageDailyRowInput[];
  firstTs: number;
  lastTs: number;
} {
  const byDay = new Map<
    string,
    UsageDailyRowInput & { byModelMap: Record<string, number> }
  >();
  let firstTs = 0;
  let lastTs = 0;

  for (const { agent } of readTranscript(sessionId)) {
    const msg = agent as {
      role?: string;
      stopReason?: string;
      timestamp?: number;
      provider?: string;
      model?: string;
      usage?: UsageLike;
    };
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    if (ts > 0) {
      if (firstTs === 0 || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
    const u = msg.usage;
    if (!u) continue;
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    const tokens = input + output + cacheRead + cacheWrite;
    const date = localDayKey(ts > 0 ? ts : Date.now());
    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = {
        date,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        messages: 0,
        byModel: "{}",
        byModelMap: {},
      };
      byDay.set(date, bucket);
    }
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += cacheWrite;
    bucket.tokens += tokens;
    bucket.messages += 1;
    const modelKey = `${msg.provider ?? "?"}/${msg.model ?? "?"}`;
    bucket.byModelMap[modelKey] = (bucket.byModelMap[modelKey] ?? 0) + tokens;
  }

  const rows: UsageDailyRowInput[] = [...byDay.values()].map(
    ({ byModelMap, ...row }) => ({ ...row, byModel: JSON.stringify(byModelMap) }),
  );
  return { rows, firstTs, lastTs };
}

/**
 * 增量物化 + 从库聚合。脏判定 = JSONL mtime 与 usage_scan 记录不一致
 * （首扫全量、之后只重算改过的会话）；scan 表丢失/清空时自动退化为全量重扫。
 */
export async function aggregateUsageStats(): Promise<UsageStatsResult> {
  let sessions: { id: string }[] = [];
  try {
    sessions = await sessionList();
  } catch (err) {
    logErr("usage_stats: session list failed:", err);
  }
  let scan: UsageScanRow[] = [];
  try {
    scan = await usageScanList();
  } catch (err) {
    logErr("usage_stats: scan list failed:", err);
  }
  const scannedMtime = new Map(scan.map((r) => [r.sessionId, r.mtime]));

  for (const { id } of sessions) {
    let mtime = 0;
    try {
      mtime = statSync(sessionPath(id)).mtimeMs;
    } catch {
      continue; // 转录文件缺失（索引与文件短暂不一致）：跳过，不产生聚合
    }
    if (scannedMtime.get(id) === mtime) continue;
    try {
      const { rows, firstTs, lastTs } = aggregateSessionTranscript(id);
      await usageDailyReplace(id, rows, mtime, firstTs, lastTs);
    } catch (err) {
      logErr("usage_stats: session materialize failed:", id, err);
    }
  }

  // 已删会话的残留聚合行与水位
  try {
    await usageDailyCleanup();
  } catch (err) {
    logErr("usage_stats: cleanup failed:", err);
  }

  // 从库聚合出逐日序列（按 by_model JSON 逐行合并）
  // 显式标注：evolving any 在 try/catch 分支下无法确定类型（TS7034）
  let daily: UsageDailyRow[];
  try {
    daily = await usageDailyQuery();
  } catch (err) {
    logErr("usage_stats: daily query failed:", err);
    daily = [];
  }
  const byDay = new Map<string, UsageStatsDay>();
  const sessionIds = new Set<string>();
  for (const row of daily) {
    sessionIds.add(row.sessionId);
    let bucket = byDay.get(row.date);
    if (!bucket) {
      bucket = {
        date: row.date,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        messages: 0,
        byModel: {},
      };
      byDay.set(row.date, bucket);
    }
    bucket.input += row.input;
    bucket.output += row.output;
    bucket.cacheRead += row.cacheRead;
    bucket.cacheWrite += row.cacheWrite;
    bucket.tokens += row.tokens;
    bucket.messages += row.messages;
    try {
      const models = JSON.parse(row.byModel) as Record<string, number>;
      for (const [model, tokens] of Object.entries(models)) {
        bucket.byModel[model] = (bucket.byModel[model] ?? 0) + tokens;
      }
    } catch {
      // 损坏的 byModel JSON：跳过该行的模型细分（总量已计入）
    }
  }

  // 跨度取扫描水位的极值（replace 后重新读取，包含本次新物化的会话）
  let longestChatMs = 0;
  try {
    for (const r of await usageScanList()) {
      if (r.firstTs > 0 && r.lastTs > r.firstTs) {
        longestChatMs = Math.max(longestChatMs, r.lastTs - r.firstTs);
      }
    }
  } catch {
    // 水位读取失败仅损失时长指标
  }

  const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    days,
    sessionCount: sessionIds.size,
    firstActivity: days[0]?.date ?? null,
    longestChatMs,
  };
}
