"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getPiChannel, type PiRunningTurn } from "@/lib/pi-channel";
import { piResumableStorage } from "@/lib/pi-resume-storage";

/**
 * 全局"会话运行中"集合（pi-agent sidecar activeTurns 的投影）。
 * - 事实源在 sidecar：turn 起止广播 turn_changed 通知行（见 sessions.ts）
 * - 通道能力 subscribeTurns + listRunning（成对可选）：Tauri 通道实现，
 *   推送型通道缺省 → 无外部信号，侧边栏降级为框架自带的仅挂载线程 isRunning
 * - 合并规则：快照 = 最近一次种子 fold 每会话已知最新增量（start/end 事件）。
 *   时序契约（见 pi-channel.ts subscribeTurns 注释）：种子必须在订阅登记
 *   完成后才发起——sidecar 对 turn_changed 与 list_running 响应按 stdout
 *   全序写出，先订阅后种子则任何事件要么在种子里、要么在订阅后到达，无空窗；
 *   增量可双向修正快照的滞后（种子算早了被 end 事件抹掉，种子漏了的被 start 补上）
 * - sidecar 重启（cb(null)）：增量与快照作废，清空后重新种子水合
 */

const runningSessions = new Set<string>();
const listeners = new Set<() => void>();

/** 最近一次种子快照；null = 尚未取得 */
let seedSnapshot: string[] | null = null;
/** 种子之后每会话已知最新增量（true = 在跑 / false = 已收尾） */
const deltas = new Map<string, boolean>();

let watchStarted = false;

function notify() {
  for (const l of listeners) l();
}

/** 快照 ⊕ 增量 → runningSessions；投影没变则不 notify（end 幂等不抖动） */
function recompute() {
  const next = new Set(seedSnapshot ?? []);
  for (const [id, active] of deltas) {
    if (active) next.add(id);
    else next.delete(id);
  }
  if (
    next.size === runningSessions.size &&
    [...next].every((id) => runningSessions.has(id))
  ) {
    return;
  }
  runningSessions.clear();
  for (const id of next) runningSessions.add(id);
  notify();
}

function reseed() {
  const channel = getPiChannel();
  if (!channel.listRunning) return;
  // 发起时刻仍标"在跑"的增量名单。种子快照晚于这些 start 行写出（stdout
  // 全序），若名单项不在快照里，唯一解释是它的 end 行没送达——清掉这条
  // 陈旧增量完成纠偏。种子之后才 start 的会话不在名单里，不受误伤；其
  // start 行必在快照之后写出，事件照常入增量。
  const trueAtSend = new Set<string>();
  for (const [id, active] of deltas) if (active) trueAtSend.add(id);
  channel
    .listRunning()
    .then((ids) => {
      seedSnapshot = ids;
      for (const id of trueAtSend) {
        if (!ids.includes(id)) deltas.delete(id);
      }
      recompute();
    })
    .catch(() => {
      // 旧 sidecar 无 list_running/拉起失败：静默，事件流照常工作
    });
}

function onTurnEvent(sessionId: string | null, active: boolean) {
  if (sessionId === null) {
    // 事件源失效（sidecar 重启）：一切已知状态作废，清空 + 重新水合
    seedSnapshot = null;
    deltas.clear();
    runningSessions.clear();
    notify();
    reseed();
    return;
  }
  deltas.set(sessionId, active);
  recompute();
}

/**
 * 幂等启动订阅 + 种子水合（首个 usePiSessionRunning 挂载时触发）。
 * 种子在 subscribeTurns 的登记 promise resolve 之后才发起——顺序颠倒会
 * 把登记窗口里广播的 turn_changed 漏掉，投影从此缺一次收尾。
 */
export function startPiRunningWatch(): void {
  if (watchStarted) return;
  const channel = getPiChannel();
  if (!channel.subscribeTurns || !channel.listRunning) return;
  watchStarted = true;
  void (async () => {
    const teardown = await channel.subscribeTurns!(onTurnEvent);
    void teardown; // 订阅与页面同生命周期，不退订
    reseed();
  })();
}

/**
 * 手动对齐一次快照（transport 在 finish/error 收尾时调用）：本轮 turn 确定
 * 结束，趁势拉种子纠偏任何缺了收尾的残留项；未启动时等价于启动。
 */
export function resyncPiRunning(): void {
  if (!watchStarted) {
    startPiRunningWatch();
    return;
  }
  reseed();
}

/**
 * 启动时在飞流登记水合（刷新恢复的"运行态真相"兜底层）。
 *
 * 登记的正常通道是 transport 发送时写 storage（sessionStorage + localStorage
 * 镜像），但 webview 存储可能被整页清空/配额连带——登记丢了在飞流就无人认领
 * （表现为刷新后回到空白草稿、发送按钮不转 stop）。sidecar 的 activeTurns 带
 * {sessionId, requestId}（list_running turns 字段），是运行态事实源：对"会话
 * 还没有登记槽"的在跑轮次据此重建，attach 走 Rust 重放缓冲，全程不依赖 storage。
 * 已有该会话登记（requestId 更准、owner 是发起线程）则不顶。
 *
 * 返回在跑明细供调用方选回切目标；通道不支持/请求失败返回空清单
 * （降级为 localStorage 镜像与最近会话兜底）。
 */
export async function hydrateRunningRegistrations(): Promise<PiRunningTurn[]> {
  const channel = getPiChannel();
  if (!channel.listRunningTurns) return [];
  let turns: PiRunningTurn[];
  try {
    turns = await channel.listRunningTurns();
  } catch {
    return [];
  }
  for (const t of turns) {
    if (piResumableStorage.peekEntries().some((e) => e.sessionId === t.sessionId)) continue;
    piResumableStorage.setStreamId(t.requestId, t.sessionId, t.sessionId);
  }
  return turns;
}

/**
 * 运行态直查（transport.reconnectToStream 登记落空时的最后一搏）：按会话 id
 * 找确定在跑的轮次 requestId，顺手重建登记（后续 subscribe/finish 清理走
 * 正常通道）。无能力/无在跑轮次返回 null，调用方维持既有降级路径。
 */
export async function findRunningTurn(sessionId: string): Promise<PiRunningTurn | null> {
  const channel = getPiChannel();
  if (!channel.listRunningTurns) return null;
  try {
    const turns = await channel.listRunningTurns();
    const turn = turns.find((t) => t.sessionId === sessionId);
    if (turn && !piResumableStorage.getStreamId(sessionId)) {
      piResumableStorage.setStreamId(turn.requestId, sessionId, sessionId);
    }
    return turn ?? null;
  } catch {
    return null;
  }
}

/** 订阅运行集合变更（渲染快照用 isSessionRunning） */
export function subscribeRunningSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 某会话（remoteId = pi sessionId）是否有 turn 在跑。
 * undefined（本地新线程未 initialize）恒 false，由框架 isRunning 兜底当前线程。
 */
export function isSessionRunning(sessionId: string | undefined): boolean {
  return sessionId ? runningSessions.has(sessionId) : false;
}

/** 侧边栏列表项 hook：幂等拉起订阅+种子，随集合变更重渲染 */
export function usePiSessionRunning(sessionId: string | undefined): boolean {
  useEffect(() => {
    startPiRunningWatch();
  }, []);
  return useSyncExternalStore(
    subscribeRunningSessions,
    () => isSessionRunning(sessionId),
    () => false,
  );
}
