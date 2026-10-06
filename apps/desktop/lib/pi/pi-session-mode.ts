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

export type SessionMode = "agent" | "plan" | "ask" | "goal" | "workflow";

/** 四档字面量的宽松规整。散落的 `x === "a" || x === "b"` 白名单是加枚举值时
 *  最典型的静默漏改点——ask 的 chunk 会被整个丢弃，UI 卡在旧模式，表现为
 *  「点了没反应」。所有外部来源（chunk、会话列表偏好）一律经这里收口 */
export function normalizeSessionMode(raw: unknown): SessionMode | null {
  return raw === "agent" || raw === "plan" || raw === "ask" || raw === "goal" || raw === "workflow"
    ? raw
    : null;
}

/**
 * 逐工具审批级别（按「问多少」从紧到松）：
 * ask = 每次确认；workspace-write = 工作区内的 write/edit 免确认、之外一律确认；
 * auto-edit = 编辑全免确认；auto = 全免。边界判定在 sidecar（软链接按真实落点算）。
 */
export type ApprovalLevel = "ask" | "workspace-write" | "auto-edit" | "auto";

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
      d.approvalLevel === "workspace-write" ||
      d.approvalLevel === "auto-edit" ||
      d.approvalLevel === "auto"
        ? d.approvalLevel
        : "ask",
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
/**
 * 草稿期（还没有 sessionId）选过的档位。**必须留着补发**：这一档决定「改动前问不问」，
 * 只写在前端内存里就等于没生效——首条消息建出来的 run 会按全局默认档装配，而 UI 一直
 * 显示用户选的那一档（症状：选「工作区内自动」，bash 却直接跑了）。
 * 与模型/思考档/工作模式的 flushDraftXxxSelection 同一套路，见 flushDraftModeSelection。
 */
const draftPicks = new Map<string, { mode: SessionMode; approvalLevel?: ApprovalLevel }>();

export function setSessionMode(
  threadId: string,
  mode: SessionMode,
  approvalLevel?: ApprovalLevel,
): Promise<void> {
  if (!piSessionIdForThread(threadId)) {
    // 两级档位正交：选能力模式（问答/计划/目标）不带审批档，**不能**因此把上一句
    // 选的档位丢掉或显示成默认——草稿期是"用户已经选了什么"的本地模型，缺了哪一级
    // 就沿用上一句的值，否则「先选完全访问、再选计划模式」会当场退回变更前确认
    const prev =
      draftPicks.get(threadId) ??
      ({
        mode: sessionModeSnapshot(threadId).mode,
        approvalLevel: sessionModeSnapshot(threadId).approvalLevel,
      } satisfies { mode: SessionMode; approvalLevel?: ApprovalLevel });
    const nextLevel = approvalLevel ?? prev.approvalLevel ?? "ask";
    draftPicks.set(threadId, {
      mode,
      ...(nextLevel ? { approvalLevel: nextLevel } : {}),
    });
    setSnapshot(threadId, {
      mode,
      approvalLevel: nextLevel,
      planning: mode === "plan" ? "planning" : "inactive",
    });
    return Promise.resolve();
  }
  // 已绑定会话：落库成功即不再需要草稿记忆
  draftPicks.delete(threadId);
  return requestMode(threadId, {
    type: "set_mode",
    mode,
    ...(approvalLevel ? { approvalLevel } : {}),
  });
}

/**
 * 首条消息派发前（会话绑定后）把草稿期选的档位定靶补发。
 *
 * 不补发的后果不是"显示不准"而是**权限档没生效**：run 按全局默认装配，用户以为
 * 自己选了「工作区内自动」，实际跑的是全局那一档（可能更宽松），而 UI 显示的是他选的。
 * 调用点与 flushDraftModelSelection 等三个同期（usePiRuntime 的 initialize），
 * 且**要 await**：这一条决定首轮怎么执行，晚到就等于首轮按错档跑。
 *
 * 失败保留草稿，下次绑定再试（与三个同期 fire-and-forget 的取舍不同——它没有回退显示：
 * 档位不像模型那样有"降级可用"的形态）。
 */
export async function flushDraftModeSelection(threadId: string): Promise<void> {
  const pick = draftPicks.get(threadId);
  if (!pick) return;
  if (!piSessionIdForThread(threadId)) return;
  try {
    await requestMode(threadId, {
      type: "set_mode",
      mode: pick.mode,
      ...(pick.approvalLevel ? { approvalLevel: pick.approvalLevel } : {}),
    });
    draftPicks.delete(threadId);
  } catch {
    // 保留草稿：下一次绑定（或用户再切一次档）会重试
  }
}

/** 测试缝：某线程是否还压着未补发的草稿档 */
export function draftModePickForTest(threadId: string) {
  return draftPicks.get(threadId);
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
        prefs.approvalLevel === "workspace-write" ||
        prefs.approvalLevel === "auto-edit" ||
        prefs.approvalLevel === "auto"
          ? prefs.approvalLevel
          : "ask",
      planning: prefsMode === "plan" ? "planning" : "inactive",
    });
  }
  return requestMode(threadId, { type: "get_planning_state" });
}
