"use client";

/**
 * 全局「会话运行中」集合（sidecar activeTurns 的投影）——移动端版，语义移植自
 * apps/desktop/lib/pi/pi-running.ts，数据源换成移动端的通道能力：
 *  - 种子：`channel.listRunning()`（会话 id 清单）；
 *  - 增量：`channel.subscribeTurns`（session_state / turn_changed 无 id 广播，
 *    经网关白名单转发，与订阅了哪个线程无关）；
 *  - 事件源失效（cb(null)，WS 换连接）：清空 + 重新水合。
 *
 * 为什么需要它：框架的 `threadListItem.isRunning` 只覆盖"挂载过运行时"的线程，
 * 切走/刷新后的后台轮（定时任务、桌面端发起的轮次）在列表里看不到运行态——
 * 移动端此前 `resyncPiRunning` 是个空壳桩（"运行态由快照 metadata.status 驱动"），
 * 而快照只在整表 reload 时刷新，后台跑起来了行上也还是旧的。
 *
 * 合并规则同桌面端：种子 = 最近一次 fold，增量按每会话最新一条 start/end 修正；
 * 投影没变不 notify（end 幂等不抖动）。
 */
import { useEffect, useSyncExternalStore } from "react";
import { getPiChannel, type PiChannel } from "@/lib/pi/pi-channel";

const runningSessions = new Set<string>();
const listeners = new Set<() => void>();

/** 最近一次种子快照；null = 尚未取得（事件源失效即作废） */
let seedSnapshot: string[] | null = null;
/** 种子之后每会话已知最新增量（true = 在跑 / false = 已收尾） */
const deltas = new Map<string, boolean>();

let watchStarted = false;
let teardown: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

/** 快照 ⊕ 增量 → runningSessions；投影没变则不 notify */
function recompute(): void {
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

function reseed(channel: PiChannel): void {
  if (!channel.listRunning) return;
  // 发起时刻仍标"在跑"的增量名单：种子晚于这些 start 行写出，若名单项不在
  // 种子里，唯一解释是它的 end 行没送达——清掉这条陈旧增量完成纠偏
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
      // 通道不支持/请求失败：静默，事件流照常工作
    });
}

/** 幂等启动订阅 + 种子水合（首个 usePiSessionRunning 挂载时触发） */
export function startPiRunningWatch(): void {
  if (watchStarted) return;
  let channel: PiChannel;
  try {
    channel = getPiChannel();
  } catch {
    return; // 通道未就绪（未配对）：等下一个订阅者重试
  }
  watchStarted = true;

  const onTurn = (sessionId: string | null, active: boolean) => {
    if (sessionId === null) {
      // 事件源失效：一切已知状态作废，清空 + 重新水合
      seedSnapshot = null;
      deltas.clear();
      runningSessions.clear();
      notify();
      reseed(channel);
      return;
    }
    deltas.set(sessionId, active);
    recompute();
  };

  const sub = channel.subscribeTurns?.(onTurn);
  if (sub && typeof (sub as Promise<() => void>).then === "function") {
    void (sub as Promise<() => void>)
      .then((off) => {
        teardown = off;
        reseed(channel); // 时序契约：先订阅就绪，再种子（见 PiChannel.subscribeTurns 注）
      })
      .catch(() => {
        watchStarted = false; // 登记失败：允许下次重试
      });
    return;
  }
  teardown = (sub as (() => void) | undefined) ?? null;
  reseed(channel);
}

/**
 * 手动对齐（WS 重连/收尾时调用）：事件源换了连接，快照与增量都要重来。
 * 未启动时等价于启动。
 */
export function resyncPiRunning(): void {
  if (!watchStarted) {
    startPiRunningWatch();
    return;
  }
  try {
    reseed(getPiChannel());
  } catch {
    /* 通道不可用：保留现状 */
  }
}

/** 订阅运行集合变更（渲染快照用） */
export function subscribeRunningSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 某会话（= sessionId）是否有 turn 在跑 */
export function isSessionRunning(sessionId: string | undefined): boolean {
  return sessionId ? runningSessions.has(sessionId) : false;
}

/** 列表行 hook：幂等拉起订阅+种子，随集合变更重渲染 */
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

/** 仅供测试：清空集合与台账 */
export function __resetPiRunningForTests(): void {
  runningSessions.clear();
  deltas.clear();
  seedSnapshot = null;
  watchStarted = false;
  teardown?.();
  teardown = null;
  listeners.clear();
}
