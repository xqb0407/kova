"use client";

import { useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";
import { piRequest } from "@/lib/pi/pi-bridge";
import {
  piSessionIdForThread,
  piSessionPrefsMap,
  piStoreKeyForThread,
} from "@/lib/pi/pi-thread-adapter";

/**
 * 会话模式与计划状态（pi-agent sidecar 的 modes.ts 状态机镜像）。
 * - 事实源在 sidecar：prompt 流里的 data-planningState chunk 推送变更（见 pi-transport 的 tap）
 * - 管理操作（set_mode/get_planning_state）走 piRequest 请求-响应，响应即新状态
 * - 前端只是 per-thread 快照 store，切换线程时各自独立
 * - plan_exit 的执行确认不在这里：它走逐工具审批通道（pi-tool-approval）
 */

export type SessionMode = "agent" | "plan" | "ask";

/** 三档字面量的宽松规整。散落的 `x === "a" || x === "b"` 白名单是加枚举值时
 *  最典型的静默漏改点——ask 的 chunk 会被整个丢弃，UI 卡在旧模式，表现为
 *  「点了没反应」。所有外部来源（chunk、会话列表偏好）一律经这里收口 */
export function normalizeSessionMode(raw: unknown): SessionMode | null {
  return raw === "agent" || raw === "plan" || raw === "ask" ? raw : null;
}

/** 逐工具审批级别（agent 模式）：ask = 每次确认；auto-edit = 编辑免确认；auto = 全免 */
export type ApprovalLevel = "ask" | "auto-edit" | "auto";

export type PlanningStateValue = "inactive" | "planning";

export type PlanningSnapshot = {
  mode: SessionMode;
  approvalLevel: ApprovalLevel;
  planning: PlanningStateValue;
};

export const DEFAULT_PLANNING_SNAPSHOT: PlanningSnapshot = {
  mode: "agent",
  approvalLevel: "ask",
  planning: "inactive",
};

/** threadId -> 最近一次已知的模式快照（键 = piStoreKeyForThread 归一后的 sessionId） */
const snapshots = new Map<string, PlanningSnapshot>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/**
 * store 键归一（读写共用；规则见 piStoreKeyForThread）。草稿期落的本地快照
 * 在绑定后惰性搬到会话键：不搬的话「新对话里选了 plan → 发送」会当场闪回默认档
 * （UI 转读会话键，而草稿键上那份本地态再也无人读），随后才由 chunk/水合覆盖。
 * 只搬一次，且会话键已有真值时不动它——live 真值永远优先。
 */
function storeKey(threadId: string, migrate = false): string {
  const key = piStoreKeyForThread(threadId);
  if (migrate && key !== threadId) {
    const draft = snapshots.get(threadId);
    if (draft && !snapshots.has(key)) snapshots.set(key, draft);
  }
  return key;
}

function setSnapshot(threadId: string, snap: PlanningSnapshot) {
  snapshots.set(storeKey(threadId, true), snap);
  notify();
}

/** 消费 prompt 流里的 data-planningState chunk（pi-transport 调用） */
export function applyPlanningChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<PlanningSnapshot>;
  const mode = normalizeSessionMode(d.mode);
  if (!mode || (d.planning !== "inactive" && d.planning !== "planning")) {
    return;
  }
  setSnapshot(threadId, {
    mode,
    approvalLevel:
      d.approvalLevel === "auto-edit" || d.approvalLevel === "auto" ? d.approvalLevel : "ask",
    planning: d.planning,
  });
}

/** 订阅当前线程的模式快照 */
export function useSessionMode(threadId: string | undefined): PlanningSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () =>
      threadId
        ? (snapshots.get(storeKey(threadId, true)) ?? DEFAULT_PLANNING_SNAPSHOT)
        : DEFAULT_PLANNING_SNAPSHOT,
    () => DEFAULT_PLANNING_SNAPSHOT,
  );
}

/** React 之外的读法（测试、非组件调用点）。形态对齐 app-mode 的 getAppMode() */
export function sessionModeSnapshot(threadId: string | undefined): PlanningSnapshot {
  return threadId
    ? (snapshots.get(storeKey(threadId, true)) ?? DEFAULT_PLANNING_SNAPSHOT)
    : DEFAULT_PLANNING_SNAPSHOT;
}

/** 工具行、面板标签、composer 底栏共用同一个判据：别处各自判 mode 会漂 */
export function useIsAskMode(): boolean {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  return useSessionMode(threadId).mode === "ask";
}

type ModeResponse = {
  type: "mode_changed" | "planning_state";
  mode: SessionMode;
  approvalLevel?: ApprovalLevel;
  planning: PlanningStateValue;
};

function snapshotFrom(res: ModeResponse): PlanningSnapshot {
  return {
    mode: res.mode,
    approvalLevel: res.approvalLevel ?? "ask",
    planning: res.planning,
  };
}

async function requestMode(threadId: string, payload: Record<string, unknown>): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  const res = await piRequest<ModeResponse>({ ...payload, threadId, ...(sessionId ? { sessionId } : {}) });
  setSnapshot(threadId, snapshotFrom(res));
}

/** 手动切换模式；agent 模式可携带审批级别（变更前确认/自动编辑/完全访问）。
 *  未发送草稿（尚无会话）只落本地快照：threadId-only 的 set_mode 会懒建空白
 *  会话（污染），而草稿真正建会话（首次发送走 createThread）后偏好跟随
 *  「最近一次使用」，届时再切一次即可同步 sidecar。 */
export function setSessionMode(
  threadId: string,
  mode: SessionMode,
  approvalLevel?: ApprovalLevel,
): Promise<void> {
  if (!piSessionIdForThread(threadId)) {
    setSnapshot(threadId, {
      mode,
      approvalLevel: approvalLevel ?? "ask",
      planning: mode === "plan" ? "planning" : "inactive",
    });
    return Promise.resolve();
  }
  return requestMode(threadId, {
    type: "set_mode",
    mode,
    ...(approvalLevel ? { approvalLevel } : {}),
  });
}

/**
 * 拉取 sidecar 侧模式快照并水合本地 store：页面刷新/切线程后 mode-picker
 * 内存快照丢失，用请求-响应恢复（无运行中 turn 也有效）。
 * 先用会话列表带来的持久化偏好播种（sidecar 重启/Running 被驱逐也能恢复 UI，
 * live 状态随后覆盖），再向 sidecar 拉活动真值。
 * 没有任何已知 sessionId 的线程（未发送草稿）直接跳过请求：sidecar 不可能
 * 持有它的特殊模式，而请求会懒建会话（污染）。
 */
export function fetchPlanningState(threadId: string): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return Promise.resolve();
  const prefs = piSessionPrefsMap.get(sessionId);
  const prefsMode = normalizeSessionMode(prefs?.mode);
  if (prefs && prefsMode) {
    setSnapshot(threadId, {
      mode: prefsMode,
      approvalLevel:
        prefs.approvalLevel === "auto-edit" || prefs.approvalLevel === "auto"
          ? prefs.approvalLevel
          : "ask",
      planning: prefsMode === "plan" ? "planning" : "inactive",
    });
  }
  return requestMode(threadId, { type: "get_planning_state" });
}
