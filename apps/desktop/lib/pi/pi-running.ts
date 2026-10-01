"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { getPiChannel, type PiRunningTurn } from "@/lib/pi/pi-channel";
import { piResumableStorage } from "@/lib/pi/pi-resume-storage";
import { markThreadActivity } from "@/lib/pi/pi-last-activity";

/**
 * 全局"会话运行中"集合（pi-agent sidecar activeTurns 的投影）。
 * - 事实源在 sidecar：agent 轮起止以 thread_event（agent_start/agent_end）
 *   广播（迁移 4c 起为本 store 的增量源，替代 pi-channel 的 turn_changed
 *   订阅）。自持 pi-chunk-batch 监听（与 pi-channel 的旁路监听同款模式）：
 *   不能挂在 TauriPiClient 的事件 watcher 上——它按「有订阅/在飞请求」早退，
 *   空闲期侧边栏的起止增量会断流；双前缀预筛（thread_event + agent_start/
 *   agent_end）后正文里的同名词因 JSON 转义不会误匹配
 * - listRunning（管理通道）做种子水合；合并规则：快照 = 最近一次种子 fold
 *   每会话已知最新增量（start/end 事件）。种子在订阅登记完成后发起（sidecar
 *   按 stdout 全序写出，先订阅后种子则任何事件要么在种子里、要么在订阅后
 *   到达，无空窗）；增量可双向修正快照的滞后
 * - sidecar 重启（pi-exit）：增量与快照作废，清空后重新种子水合
 */

/** pi-chunk-batch 行最小形状（镜像 Rust ChunkLine，只关心行文本） */
type RunWireLine = { l: string };
/** thread_event 行的最小解析形状（只需事件种类与会话归属） */
type RunWireMsg = {
  type?: string;
  sessionId?: unknown;
  event?: { type?: string };
};

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
  // turn 收尾即一次消息活动：本端发起的在 transport 发送时已盖过，这里补上
  // 其它端（如桌面应用里跑的）聊完的会话，让它们的行也立刻显示「刚刚」
  if (!active) {
    markThreadActivity(sessionId);
    // 在飞流登记随轮次结束作废：实时流已尽，内容从转录走历史加载。定时任务的
    // 轮次前端没有发起消费者，登记（启动水合/挂载探查重建）不会经 transport
    // finish 通道清理——不清就会留着陈旧 requestId，下次点进该会话触发一次
    // 空转 resume，甚至把已结束轮次的重放缓冲再倒进线程（消息重复/空窗）。
    piResumableStorage.clear(sessionId);
  }
  recompute();
}

/**
 * 幂等启动订阅 + 种子水合（首个 usePiSessionRunning 挂载时触发）。
 * 种子在监听登记完成之后才发起——顺序颠倒会把登记窗口里广播的起止事件
 * 漏掉，投影从此缺一次收尾（listen promise resolve 后再 reseed）。
 */
export function startPiRunningWatch(): void {
  if (watchStarted) return;
  const channel = getPiChannel();
  if (!channel.listRunning) return;
  watchStarted = true;
  void (async () => {
    // 增量源 = thread_event 的 agent_start/agent_end（迁移 4c）。监听与页面
    // 同生命周期，不退订；pi-exit 作废全部已知状态并重新种子水合
    await listen<RunWireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        const line = wire.l;
        if (!line.includes('"thread_event"')) continue;
        if (
          !line.includes('"agent_start"') &&
          !line.includes('"agent_end"')
        ) {
          continue;
        }
        let parsed: RunWireMsg;
        try {
          parsed = JSON.parse(line) as RunWireMsg;
        } catch {
          continue;
        }
        if (parsed.type !== "thread_event") continue;
        const kind = parsed.event?.type;
        const sid = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
        if (!sid || !kind) continue;
        if (kind === "agent_start") onTurnEvent(sid, true);
        else if (kind === "agent_end") onTurnEvent(sid, false);
      }
    });
    await listen<string>("pi-exit", () => onTurnEvent(null, false));
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
