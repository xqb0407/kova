"use client";

/**
 * 事件水印守卫（设计文档 §3）：per-session lastSeq 检漂移，缺口 → 按帧型
 * 防抖回拉权威接口。seq 只负责"发现丢了状态帧"，修复一律回拉（不重放）。
 *
 * 观察入口 observeWireLine 收"已 JSON.parse 的 NDJSON 行"，由两端通道调：
 * - TauriPiChannel：模块级 pi-chunk-batch 监听（含重放行，粗筛命中才 parse）
 * - WsPiChannel：onMessage 已全 parse，直接喂
 *
 * 代际规则：
 * - 首次见号只登记不报警（页面水合期防误报）
 * - 回退/重复号 = 陈旧代际（attach 重放、换代残留）：静默忽略
 * - 换代（Tauri pi-exit / WS authed）走 resetSeqGuard() 显式清零，
 *   不经帧推断
 *
 * 本模块零应用依赖（纯 pi-protocol），修复动作经 setSeqGuardDeps 注入
 * （pi-transport 顶层接线），避免通道 ⇄ store 的循环 import。
 */
import { readSeqStamp, type SeqRepairKind } from "pi-protocol";

export type SeqGuardDeps = {
  /** data-queue-state 缺口：按线程拉 get_queue_state（幂等快照并入） */
  refreshQueue: (threadId: string) => void;
  /** data-planningState 缺口：拉 get_planning_state 水合模式快照 */
  fetchPlanning: (threadId: string) => void;
  /** data-toolApproval/data-question 缺口：拉 list_pending 补挂起卡（§4） */
  refreshPending: (threadId: string) => void;
  /** context_changed 缺口：拉 context_info 回填占用镜像（§7） */
  refreshContext: (threadId: string) => void;
  /** session_state 缺口：拉 list_running 重水合运行投影 */
  resyncRunning: () => void;
  /** planning 帧只带 sessionId，回拉按线程发起，需反查 */
  threadForSession: (sessionId: string) => string | undefined;
};

let deps: SeqGuardDeps | null = null;

export function setSeqGuardDeps(d: SeqGuardDeps | null): void {
  deps = d;
}

const lastSeq = new Map<string, number>();

type Pending = {
  kinds: Set<SeqRepairKind>;
  /** queue 缺口线程直接从快照行取；planning/pending 缺口线程在调度时反查好 */
  threads: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
};
const pending = new Map<string, Pending>();

let debounceMs = 150;
/** 测试钩子：缩短/放大防抖窗 */
export function configureSeqGuardDebounce(ms: number): void {
  debounceMs = ms;
}

function threadIdOfQueueChunk(parsed: unknown): string | undefined {
  const data = (parsed as { chunk?: { data?: { threadId?: unknown } } })?.chunk?.data;
  return typeof data?.threadId === "string" ? data.threadId : undefined;
}

function schedule(sessionId: string, kind: SeqRepairKind, parsed: unknown): void {
  let p = pending.get(sessionId);
  if (!p) {
    p = { kinds: new Set(), threads: new Set(), timer: null };
    pending.set(sessionId, p);
  }
  p.kinds.add(kind);
  if (kind === "queue") {
    const t = threadIdOfQueueChunk(parsed);
    if (t) p.threads.add(t);
  } else if (kind === "planning" || kind === "pending" || kind === "context") {
    // 这几类帧只带 sessionId，回拉按线程发起，需反查
    const t = deps?.threadForSession(sessionId);
    if (t) p.threads.add(t);
  }
  if (p.timer === null) {
    const captured = p;
    captured.timer = setTimeout(() => {
      captured.timer = null;
      flushOne(sessionId);
    }, debounceMs);
  }
}

function flushOne(sessionId: string): void {
  const p = pending.get(sessionId);
  if (!p) return;
  pending.delete(sessionId);
  if (!deps) return;
  if (p.kinds.has("queue")) {
    // 快照行没带线程 id 的极端情形退化为按会话反查
    if (p.threads.size === 0) {
      const t = deps.threadForSession(sessionId);
      if (t) deps.refreshQueue(t);
    } else {
      for (const t of p.threads) deps.refreshQueue(t);
    }
  }
  if (p.kinds.has("planning")) {
    for (const t of p.threads) deps.fetchPlanning(t);
  }
  if (p.kinds.has("pending")) {
    for (const t of p.threads) deps.refreshPending(t);
  }
  if (p.kinds.has("context")) {
    for (const t of p.threads) deps.refreshContext(t);
  }
  if (p.kinds.has("running")) deps.resyncRunning();
}

/** 观察一条已解析的 NDJSON 行；未盖章/无修复语义的行即刻返回 */
export function observeWireLine(parsed: unknown): void {
  const stamp = readSeqStamp(parsed);
  if (!stamp) return;
  const prev = lastSeq.get(stamp.sessionId);
  if (prev === undefined) {
    lastSeq.set(stamp.sessionId, stamp.eventSeq);
    return;
  }
  if (stamp.eventSeq <= prev) return; // 陈旧代际：静默忽略
  lastSeq.set(stamp.sessionId, stamp.eventSeq);
  if (stamp.eventSeq > prev + 1) {
    schedule(stamp.sessionId, stamp.kind, parsed);
  }
}

/** 事件源换代（Tauri pi-exit / WS authed）：全部已知号作废、未决修复撤销，
 *  下一个号按"首次见号"重新登记 */
export function resetSeqGuard(): void {
  lastSeq.clear();
  for (const p of pending.values()) {
    if (p.timer) clearTimeout(p.timer);
  }
  pending.clear();
}

/** 测试钩子：立即结算某会话的待修缺口（不等防抖窗） */
export function flushSeqGuardForTest(sessionId: string): void {
  flushOne(sessionId);
}
