"use client";

import { useSyncExternalStore } from "react";
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
 *   task_output/task_stop 状态回写、轮边界探测，变化经 thread_event
 *   （event.type = "bg_tasks"）推全量快照；
 * - 切线程/刷新用 get_bg_tasks 水合（sidecar 重启后内存态为空，返回空清单
 *   是合法态——等下一次工具结果落位自然重建）；
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
const inflight = new Set<string>();
let watchStarted = false;

function notify() {
  for (const l of listeners) l();
}

/** 模块级订阅函数（Header 热路径：hook 内联箭头会每渲染退订/重订一次） */
function subscribeBgTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSnapshot(sessionId: string, tasks: unknown): void {
  // 统一按 sessionId 作键：写入（thread_event / 水合应答）与读取
  // （piStoreKeyForThread 对已绑定线程解析出的就是 sessionId）天然同键；
  // 未发送草稿没有 sessionId，也自然没有后台任务。
  const next = validTasks(tasks);
  if (snapshots.get(sessionId) === next) return;
  snapshots.set(sessionId, next);
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
}

type BgWireMsg = {
  type: string;
  sessionId?: string;
  event?: { type?: string; tasks?: unknown };
};

/** 订阅当前线程的后台任务快照 */
export function useThreadBgTasks(threadId: string | undefined): BgTaskSnapshot {
  return useSyncExternalStore(
    subscribeBgTasks,
    () => (threadId ? (snapshots.get(storeKey(threadId)) ?? EMPTY) : EMPTY),
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
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  if (inflight.has(sessionId)) return;
  inflight.add(sessionId);
  piRequest<{ type: "bg_tasks"; tasks: unknown[] }>({
    type: "get_bg_tasks",
    threadId,
    sessionId,
  })
    .then((res) => {
      setSnapshot(sessionId, res.tasks);
    })
    .catch(() => {})
    .finally(() => inflight.delete(sessionId));
}

/* ------------------------- 测试缝 ------------------------- */

export const bgTasksSnapshotForTest = (threadId: string): BgTaskSnapshot =>
  snapshots.get(storeKey(threadId)) ?? EMPTY;
