"use client";

import { useSyncExternalStore } from "react";
import { listen } from "@/desktop-bridge/event";
import { piRequest } from "@/lib/pi/pi-bridge";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { subscribeWireFrames } from "@/lib/pi/wire-bus";

/**
 * 读取键 = 渲染侧线程 id 归一（piStoreKeyForThread 的语义内联）。不直接 import
 * piStoreKeyForThread：兄弟测试文件对 pi-thread-adapter 的进程级 mock.module 桩
 * 未必覆盖后加的导出（见 pi-session-model.test 的泄漏注释），而
 * piSessionIdForThread 是它们都覆盖的基础导出——语义等价（能换 sessionId 用
 * sessionId，草稿回落草稿 id），依赖面更小。
 */
const storeKey = (threadId: string): string => piSessionIdForThread(threadId) ?? threadId;

/**
 * 后台任务台账 store（sidecar bg-tasks.ts 的 per-thread 快照镜像，形态同
 * pi-todo/pi-running）：
 * - 事实源在 sidecar：bash 注册（显式 runInBackground / 超时自动转后台）、
 *   task_output/task_stop 状态回写、宿主退出推送（bg_task_exit）、轮边界探测，
 *   变化经 thread_event（event.type = "bg_tasks"）推全量快照；
 * - 切线程/刷新用 get_bg_tasks 水合（sidecar 会先与宿主的任务表对账：重启后
 *   内存台账清零，但宿主里仍在跑的任务靠这一步补回）；
 * - 侧车换代（pi_restarted / pi-exit）清空残影并按已知键重水合；
 * - 渲染方：header 快速查看按钮的运行中徽标 + 快速查看浮层「后台任务」区块。
 */

export type BgTaskInfo = {
  taskId: number;
  command: string;
  source: "explicit" | "timeout";
  startedAt: number;
  running: boolean;
  exitCode: number | null;
};

type BgTaskSnapshot = BgTaskInfo[];

const EMPTY: BgTaskSnapshot = [];

const snapshots = new Map<string, BgTaskSnapshot>();
const listeners = new Set<() => void>();
/** 键 → 发起时的换代号：换代后旧请求不再拦新请求（否则重水合会被在飞旧请求吞掉） */
const inflight = new Map<string, number>();
/**
 * 见过的线程键（跨侧车换代保留，FIFO 上限 64）：崩后新实例启动时按它重水合，
 * 否则 pi-exit 清空快照后没人再问，宿主里还在跑的任务会从 UI 消失。
 */
const knownKeys = new Set<string>();
/**
 * 换代计数：清空快照时自增，在飞的水合应答据此作废——旧侧车的应答可能在
 * pi-exit 之后才落到渲染层，不挡的话刚清掉的残影会被重新写回来。
 */
let generation = 0;
let watchStarted = false;

function notify() {
  for (const l of listeners) l();
}

function rememberKey(key: string): void {
  if (!key || knownKeys.has(key)) return;
  knownKeys.add(key);
  if (knownKeys.size > 64) {
    const oldest = knownKeys.values().next().value;
    if (oldest !== undefined) knownKeys.delete(oldest);
  }
}

/** 模块级订阅函数（Header 热路径：hook 内联箭头会每渲染退订/重订一次） */
function subscribeBgTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSnapshot(threadKey: string, tasks: unknown): void {
  // 读写同键：读取经 storeKey（piStoreKeyForThread）把草稿 id 归一成 sessionId，
  // 写入也必须走同一映射——sidecar 的 thread_event 对"本会话新建的线程"带的是
  // 草稿 threadId（run 的键），原样落盘会写进草稿键、按 sessionId 读永远 miss
  // （实时状态看不见，只有切线程水合能补上）。已绑定/恢复线程两者同值，无影响。
  const key = storeKey(threadKey);
  const next = validTasks(tasks);
  rememberKey(key);
  if (snapshots.get(key) === next) return;
  snapshots.set(key, next);
  notify();
}

function validTasks(tasks: unknown): BgTaskSnapshot {
  if (!Array.isArray(tasks)) return EMPTY;
  const rows: BgTaskInfo[] = [];
  for (const raw of tasks) {
    const t = raw as Partial<BgTaskInfo>;
    if (
      typeof t?.taskId === "number" &&
      typeof t.command === "string" &&
      (t.source === "explicit" || t.source === "timeout") &&
      typeof t.startedAt === "number" &&
      typeof t.running === "boolean"
    ) {
      rows.push({
        taskId: t.taskId,
        command: t.command,
        source: t.source,
        startedAt: t.startedAt,
        running: t.running,
        exitCode: typeof t.exitCode === "number" ? t.exitCode : null,
      });
    }
  }
  return rows;
}

/** thread_event 的 bg_tasks 帧入口（wire-bus 预筛后才会走到这里；也是测试缝） */
export function applyBgTaskEvent(sessionId: string, tasks: unknown): void {
  setSnapshot(sessionId, tasks);
}

/**
 * 侧车进程真死（pi-exit）：只把「运行中」行摘掉，终态行保留——它们是用户
 * 还没看过/还没关掉的历史，清空会让快速查看的「已结束」记录闪没。新实例
 * 启动后的 pi_restarted 再对运行中的线程重水合，补回宿主里仍存活的行。
 * 返回是否摘掉了任何行（供换代判断「哪些线程需要重拉」用）。
 */
function clearRunningRows(): boolean {
  generation += 1;
  let changed = false;
  for (const [key, tasks] of snapshots) {
    const kept = tasks.filter((task) => task.running);
    if (kept.length === tasks.length) continue;
    if (kept.length === 0) snapshots.delete(key);
    else snapshots.set(key, kept);
    changed = true;
  }
  if (changed) notify();
  return changed;
}

/**
 * 侧车换代后按已知键重水合（dev 热重启 / 崩溃重启 / 被看守杀掉）。
 * 旧实例的台账已清零，但宿主后台任务表跨回合存活：不重拉的话，仍在跑的
 * 任务会从徽标/快速查看消失；反过来，旧实例里「运行中」的残影会一直挂着
 * （用户现场：快速查看里一条后台任务常驻）。
 */
function rehydrateSnapshots(): void {
  if (knownKeys.size === 0) return;
  // 只重拉「上一拍还有运行中任务」的线程：全量重拉会把几十个线程的
  // get_bg_tasks 塞进管理队列，而这些线程的终态行随换代清掉即可（下次
  // 切线程/开浮层会自然水合）。判定必须先于摘行——clearRunningRows 会把
  // 运行中行摘掉，先摘再判就永远查不到该重拉的键（pi_restarted 在无
  // pi-exit 的热重启路径上是唯一信号，漏掉它存活任务会从 UI 消失）。
  const liveKeys: string[] = [];
  for (const key of knownKeys) {
    if (snapshots.get(key)?.some((task) => task.running)) liveKeys.push(key);
  }
  clearRunningRows();
  for (const key of liveKeys) fetchBgTasks(key);
}

/**
 * 幂等启动订阅（首个消费方挂载时触发；监听与页面同生命周期，不退订）。
 * accept 预筛挡掉无关帧：thread_event 热路径是 message_update。
 */
export function startBgTasksWatch(): void {
  if (watchStarted) return;
  watchStarted = true;
  void subscribeWireFrames<BgWireMsg>(
    ["thread_event"],
    (parsed) => {
      if (parsed.type !== "thread_event") return;
      const sid = (parsed as { sessionId?: unknown }).sessionId;
      const event = (parsed as { event?: { type?: unknown; tasks?: unknown } }).event;
      if (typeof sid === "string" && event?.type === "bg_tasks") {
        applyBgTaskEvent(sid, event.tasks);
      }
    },
    { accept: (raw) => raw.includes('"bg_tasks"') },
  );
  // 侧车换代广播（pi_restarted）：旧实例的台账随模块状态清零，宿主的任务表
  // 还在——按已知键重水合，别让存活任务消失。
  void subscribeWireFrames<{ type: string }>(["pi_restarted"], () =>
    rehydrateSnapshots(),
  ).catch(() => undefined);
  // pi-exit：进程真死，摘掉「运行中」行（终态行保留），防残影挂着；新实例
  // 启动后的 pi_restarted 再走重水合。网页端没有桌面桥（listen 抛 kovaHost
  // missing）：静默降级。
  listen<unknown>("pi-exit", () => clearRunningRows()).catch(() => undefined);
}

type BgWireMsg = {
  type: string;
  sessionId?: string;
  event?: { type?: string; tasks?: unknown };
};

/**
 * 读取：键归一 + 惰性 rekey。侧车换代/绑定完成前落在草稿键上的快照，
 * 在能换出 sessionId 后搬到会话键（与其它 per-thread store 同款惰性迁移）；
 * 不搬的话实时徽标会永久 miss，只剩切线程水合能显示。
 */
function snapshotFor(threadId: string): BgTaskSnapshot {
  const key = storeKey(threadId);
  const hit = snapshots.get(key);
  if (hit) return hit;
  if (key !== threadId) {
    const legacy = snapshots.get(threadId);
    if (legacy) {
      snapshots.delete(threadId);
      snapshots.set(key, legacy);
      return legacy;
    }
  }
  return EMPTY;
}

/** 订阅当前线程的后台任务快照 */
export function useThreadBgTasks(threadId: string | undefined): BgTaskSnapshot {
  return useSyncExternalStore(
    subscribeBgTasks,
    () => (threadId ? snapshotFor(threadId) : EMPTY),
    () => EMPTY,
  );
}

/** 运行中任务数（header 徽标用；与快照同源同通知） */
export function useRunningBgTaskCount(threadId: string | undefined): number {
  const tasks = useThreadBgTasks(threadId);
  return tasks.filter((t) => t.running).length;
}

/** 线程切换/浮层开启时向 sidecar 取水合快照（失败静默：区块只是空态） */
export function fetchBgTasks(threadId: string): void {
  // 键与读取同源（piStoreKeyForThread）；草稿期没有 sessionId 时用 threadId，
  // 不能因此跳过水合——草稿线程也可能已经有后台任务（sidecar 账本按它记账）。
  const sessionId = piSessionIdForThread(threadId);
  const key = sessionId ?? threadId;
  rememberKey(key);
  if (inflight.get(key) === generation) return;
  const gen = generation;
  inflight.set(key, gen);
  piRequest<{ type: "bg_tasks"; tasks: unknown[] }>({
    type: "get_bg_tasks",
    threadId,
    ...(sessionId ? { sessionId } : {}),
  })
    .then((res) => {
      // 应答可能跨越换代（pi-exit 清空后才到）：旧快照不再写回
      if (gen !== generation) return;
      setSnapshot(key, res.tasks);
    })
    .catch(() => {})
    .finally(() => {
      if (inflight.get(key) === gen) inflight.delete(key);
    });
}

/** 停止单个后台任务（快速查看「停止」按钮）：stop_bg_task 协议命令；失败
 *  reject（宿主归属拒绝/任务不存在），由调用方 toast 展示真实原因。终态
 *  不在这里等——sidecar 结算后经 thread_event bg_tasks 推回，行自动翻转。 */
export async function stopBgTask(threadId: string, taskId: number): Promise<void> {
  await piRequest<{ type: "bg_task_stop_result"; ok: boolean }>({
    type: "stop_bg_task",
    threadId,
    taskId,
  });
}

/* ------------------------- 测试缝 ------------------------- */

export const bgTasksSnapshotForTest = (threadId: string): BgTaskSnapshot =>
  snapshots.get(storeKey(threadId)) ?? EMPTY;
