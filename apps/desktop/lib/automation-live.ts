"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getPiChannel, type PiAutomationFrame } from "@/lib/pi-channel";
import { emitAgentEvent } from "@/lib/agent-events";

/**
 * 定时任务实时状态投影（前端 store）：
 * - 事实源：sidecar 调度器钩子发出的 automation_fired / automation_run_done
 *   无 id 自发通知帧（经 Rust 合批/远程白名单广播，见 protocol.ts 头注释）；
 * - 投影：taskId → 运行中条目 / 上次结果，供管理页行内状态与 ⚡ 徽标消费；
 * - 事件：结算帧转发到 agent-events 总线（automation.task.completed/failed），
 *   提示音/弹窗/webhook 订阅者随注册表自动跟随。fired 帧不转发——interval
 *   任务常规触发不该高频打扰；M4 若加"每次触发通知"开关再扩。
 *
 * 容错：webview 关窗期间丢了 done 帧会残留 running——管理页数据种子
 * （automation_list 的持久化 lastStatus）在 M3 收敛纠偏，这里不重复造种子。
 */

export type AutomationRunningEntry = {
  runId: string;
  taskName: string;
  firedAt: string;
};

export type AutomationLastResult = {
  ok: boolean;
  error?: string;
  /** 该次运行的真实 agent 会话 id（可跳转回溯）；调度错误路径可能缺省 */
  sessionId?: string;
  finishedAt: string;
};

const runningByTask = new Map<string, AutomationRunningEntry>();
const lastResultByTask = new Map<string, AutomationLastResult>();
const listeners = new Set<() => void>();
let watchStarted = false;

function notify() {
  for (const l of listeners) l();
}

export function subscribeAutomationLive(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 快照引用稳定性：Map.get 的同一条目引用不变 → useSyncExternalStore 不抖动 */
export function getAutomationRunning(taskId: string): AutomationRunningEntry | undefined {
  return runningByTask.get(taskId);
}

export function getAutomationLastResult(taskId: string): AutomationLastResult | undefined {
  return lastResultByTask.get(taskId);
}

// —— 侧边栏会话列表联动 ——
// fired 帧意味着调度器刚把定时会话物化进 store，done 帧意味着该会话的
// 标题/最后消息落定；RemoteThreadList 快照不会自动感知外部新建，宿主
// （agent-thread/base）注册一个 threads.reload() 回调。短去抖：一批
// 连续帧（多任务同刻触发 / fired 紧跟 done）合并为一次刷新；已有窗口
// 挂起时不再顺延，高频触发下刷新仍会落地。
let frameSync: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function setAutomationFrameSync(cb: (() => void) | null): void {
  frameSync = cb;
  if (!cb && syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

function requestThreadListSync(): void {
  if (!frameSync || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    frameSync?.();
  }, 500);
}

function onFrame(frame: PiAutomationFrame) {
  if (frame.type === "automation_fired") {
    runningByTask.set(frame.taskId, {
      runId: frame.runId,
      taskName: frame.taskName,
      firedAt: frame.firedAt,
    });
    // 新一轮开始即作废上次结果（行徽标回到"运行中"，不闪旧成败）
    lastResultByTask.delete(frame.taskId);
    notify();
    requestThreadListSync();
    return;
  }
  // runId 守卫：乱序/迟到的旧轮 done 帧不得顶掉新一轮状态
  const cur = runningByTask.get(frame.taskId);
  if (!cur || cur.runId === frame.runId) {
    runningByTask.delete(frame.taskId);
  }
  lastResultByTask.set(frame.taskId, {
    ok: frame.ok,
    error: frame.error,
    sessionId: frame.sessionId,
    finishedAt: frame.finishedAt,
  });
  notify();
  requestThreadListSync();
  emitAgentEvent(frame.ok ? "automation.task.completed" : "automation.task.failed", {
    threadId: frame.sessionId,
    data: {
      taskId: frame.taskId,
      taskName: frame.taskName,
      // runId = 任务 runHistory 条目 id（sidecar 钩子用 historyEntryId 填）：
      // automations.ts 借它记账 run→真实会话，历史条目跨重启可跳回
      ...(frame.runId ? { runId: frame.runId } : {}),
      ...(frame.error ? { message: frame.error.slice(0, 200) } : {}),
    },
  });
}

/** 幂等启动订阅（notify 管线装配时调用一次；推送型通道缺该能力 → 静默降级） */
export function startAutomationLiveWatch(): void {
  if (watchStarted || typeof window === "undefined") return;
  const channel = getPiChannel();
  if (!channel.subscribeAutomationEvents) return;
  watchStarted = true;
  void (async () => {
    const teardown = await channel.subscribeAutomationEvents!(onFrame);
    void teardown; // 订阅与页面同生命周期，不退订
  })();
}

/** 行内视图 hook：该任务此刻是否在跑（管理页 ⚡ 转圈、会话列表徽标共用） */
export function useAutomationRunning(taskId: string | undefined): boolean {
  useEffect(() => {
    startAutomationLiveWatch();
  }, []);
  return useSyncExternalStore(
    subscribeAutomationLive,
    () => (taskId ? runningByTask.has(taskId) : false),
    () => false,
  );
}

/** 行内视图 hook：最近一次结算（帧驱动，实时性最高；持久事实源是任务记录本身） */
export function useAutomationLastResult(
  taskId: string | undefined,
): AutomationLastResult | undefined {
  useEffect(() => {
    startAutomationLiveWatch();
  }, []);
  return useSyncExternalStore(
    subscribeAutomationLive,
    () => (taskId ? lastResultByTask.get(taskId) : undefined),
    () => undefined,
  );
}
