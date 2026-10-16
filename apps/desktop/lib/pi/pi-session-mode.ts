"use client";

import { useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";
import { isApprovalLevel, type ApprovalLevel } from "pi-protocol";
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";
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
 * - 草稿（无 sessionId）的显示值 = 全局默认档 kv pi.mode：sidecar 建会话时读的
 *   就是那一份（见 loadGlobalModeDefault），显示与首轮实跑同源
 * - plan_exit 的执行确认不在这里：它走逐工具审批通道（pi-tool-approval）
 */

export type SessionMode = "agent" | "plan" | "ask" | "goal";

/** 四档字面量的宽松规整。散落的 `x === "a" || x === "b"` 白名单是加枚举值时
 *  最典型的静默漏改点——ask 的 chunk 会被整个丢弃，UI 卡在旧模式，表现为
 *  「点了没反应」。所有外部来源（chunk、会话列表偏好）一律经这里收口 */
export function normalizeSessionMode(raw: unknown): SessionMode | null {
  return raw === "agent" || raw === "plan" || raw === "ask" || raw === "goal" ? raw : null;
}

/**
 * 逐工具审批级别（按「问多少」从紧到松）：
 * ask = 每次确认；workspace-write = 工作区内的 write/edit 免确认、之外一律确认；
 * auto-edit = 编辑全免确认；review = 不问人、模型逐次判风险（失败退回弹卡）；
 * auto = 全免。边界判定在 sidecar（软链接按真实落点算）。
 *
 * 字面量清单的单源在 pi-protocol 的 APPROVAL_LEVELS：协议、sidecar、两个前端
 * 共读一份，加档时不会再漏改这里的白名单（见 docs/permission-modes.md）。
 */
export type { ApprovalLevel };

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

/* ---------------------- 全局默认档（草稿期的显示真值） ---------------------- */

/** kv「最近一次使用」的键：sidecar 的 applyMode 写它，新会话物化时读它 */
const MODE_KV_KEY = "pi.mode";

/**
 * 全局默认档（kv `pi.mode`「最近一次使用」）：**新会话在 sidecar 物化时读的就是它**
 * （resolve.ts 的新会话分支），所以草稿期没有服务端快照可水合时，选择器显示的
 * 必须是它，而不是写死的占位（agent/ask）。
 *
 * 为什么不能只靠占位——两个方向都会骗人：
 * - 显示"变更前确认"而首轮实际按别的档跑（典型是 AI 审查/完全访问：设计上不弹卡），
 *   改动静默发生、没有任何报错线索，用户的结论只会是"权限设置坏了"；
 * - 点一个"已经选中"的项是空操作（pick 的 `o === current` 早退），于是"我设置了这个"
 *   连一个请求都没发出去，而 UI 看上去已经选好。
 * 显示与真值同源之后两件事都不会再发生：想换档就点（值不同 → 真的发 set_mode），
 * 不换就是所见即所跑。
 *
 * 只读一次；此后每次 set_mode 成功都同步成新值（那正是 kv 被写掉的时刻）。
 * 非桌面/远程模式（无本地 kv）或数据库不可用时保留占位——退回改动前的行为。
 */
let globalDefault: PlanningSnapshot | null = null;
let globalDefaultLoad: Promise<void> | null = null;

function fallbackSnapshot(): PlanningSnapshot {
  return globalDefault ?? DEFAULT_PLANNING_SNAPSHOT;
}

/** 读取全局默认档并通知订阅者；选择器挂载时经 fetchPlanningState 触发 */
export function loadGlobalModeDefault(): Promise<void> {
  if (!globalDefaultLoad) {
    globalDefaultLoad = (async () => {
      try {
        if (!isDesktop()) return;
        const value = await invoke<string | null>("kv_get", { key: MODE_KV_KEY });
        if (!value) return;
        const last = JSON.parse(value) as { mode?: unknown; approvalLevel?: unknown };
        const mode = normalizeSessionMode(last?.mode);
        if (!mode) return;
        globalDefault = {
          mode,
          approvalLevel: isApprovalLevel(last.approvalLevel) ? last.approvalLevel : "ask",
          planning: mode === "plan" ? "planning" : "inactive",
        };
        notify();
      } catch {
        // kv 不可用/损坏：保留占位默认
      }
    })();
  }
  return globalDefaultLoad;
}

/** 测试缝：清掉已读的全局默认档（用例之间隔离） */
export function resetGlobalModeDefaultForTest(): void {
  globalDefault = null;
  globalDefaultLoad = null;
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
    approvalLevel: isApprovalLevel(d.approvalLevel) ? d.approvalLevel : "ask",
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
        ? (snapshots.get(storeKey(threadId, true)) ?? fallbackSnapshot())
        : fallbackSnapshot(),
    () => fallbackSnapshot(),
  );
}

/** React 之外的读法（测试、非组件调用点）。形态对齐 app-mode 的 getAppMode() */
export function sessionModeSnapshot(threadId: string | undefined): PlanningSnapshot {
  return threadId
    ? (snapshots.get(storeKey(threadId, true)) ?? fallbackSnapshot())
    : fallbackSnapshot();
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

async function requestMode(threadId: string, payload: Record<string, unknown>): Promise<PlanningSnapshot> {
  const sessionId = piSessionIdForThread(threadId);
  const res = await piRequest<ModeResponse>({ ...payload, threadId, ...(sessionId ? { sessionId } : {}) });
  const snap = snapshotFrom(res);
  setSnapshot(threadId, snap);
  return snap;
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

export async function setSessionMode(
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
    return;
  }
  // 已绑定会话：落库成功即不再需要草稿记忆
  draftPicks.delete(threadId);
  const snap = await requestMode(threadId, {
    type: "set_mode",
    mode,
    ...(approvalLevel ? { approvalLevel } : {}),
  });
  // set_mode 成的这一档同时就是 kv「最近一次使用」（applyMode → persistModePrefs）：
  // 草稿默认档得跟着它走，否则「在 A 会话选了 X、再开新对话」显示的仍是上一档，
  // 而首轮实际按 X 跑——又回到"所见非所跑"
  globalDefault = snap;
  notify();
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
    const snap = await requestMode(threadId, {
      type: "set_mode",
      mode: pick.mode,
      ...(pick.approvalLevel ? { approvalLevel: pick.approvalLevel } : {}),
    });
    draftPicks.delete(threadId);
    // 与 setSessionMode 同一条纪律：这条 set_mode 同样写了 kv「最近一次使用」，
    // 草稿默认档跟着走（否则「在草稿里选了 ask → 发出 → 再开新对话」又显示旧档）
    globalDefault = snap;
    notify();
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
 * 没有 sessionId 的线程（未发送草稿）不发请求——sidecar 不可能持有它的特殊模式，
 * threadId-only 的请求还会懒建空白会话（污染）——改为读全局默认档 kv pi.mode：
 * 那正是这条会话建出来时会用的档，也是选择器唯一能诚实显示的值。
 */
export async function fetchPlanningState(threadId: string): Promise<void> {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return loadGlobalModeDefault();
  const prefs = piSessionPrefsMap.get(sessionId);
  const prefsMode = normalizeSessionMode(prefs?.mode);
  if (prefs && prefsMode) {
    setSnapshot(threadId, {
      mode: prefsMode,
      approvalLevel: isApprovalLevel(prefs.approvalLevel) ? prefs.approvalLevel : "ask",
      planning: prefsMode === "plan" ? "planning" : "inactive",
    });
  }
  await requestMode(threadId, { type: "get_planning_state" });
}
