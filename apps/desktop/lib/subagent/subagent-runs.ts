"use client";

import { useEffect, useSyncExternalStore } from "react";
import { piRequest, type PiResponse } from "@/lib/pi/pi-bridge";
import {
  getPiChannel,
  type SubagentActivityItem,
  type SubagentRunStatus,
} from "@/lib/pi/pi-channel";
import { getPanelTabs, openPanelTab, setActivePanelTab } from "@/lib/panels/panel-tabs";

/**
 * 子智能体运行状态 store（sidecar Task 委派的投影，面板 tab 与消息行的事实源）。
 *
 * 三条数据路（互补，任一先到都能立起条目）：
 * 1. prompt 流内 data-subagentDelegation chunk（Task 启动时发起）：
 *    toolCallId ↔ delegationId 绑定 + 元信息；刷新 attach 会回放，
 *    transport postTransform 拦截后喂 applyDelegationChunk。
 * 2. 无 id 通知行 subagent_activity（subscribeSubagentActivity，Tauri 通道）：
 *    delegate 的思考/正文增量、工具起止、轮次、结算终态，实时流式进 blocks。
 * 3. get_subagent_activity 快照（打开 tab 时按需拉）：刷新后补历史活动、
 *    点开已完成的委派；查无记录（sidecar 重启/被清理）置 expired。
 *
 * 历史重建（get_history）没有绑定 chunk：TaskToolUI 从结果文本解析
 * "Delegation <8位> started" 兜底，store 按 ≥4 位前缀认领条目。
 */

export type { SubagentActivityItem, SubagentRunStatus };

/** 归并后的活动块：thinking/text 增量在 store 内就地合并（数组不随 token 增长） */
export type SubagentBlock =
  | { kind: "turn"; n: number; at: number }
  | {
      kind: "thinking" | "text";
      id: string;
      text: string;
      done: boolean;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      argsSummary?: string;
      resultSummary?: string;
      failed?: boolean;
      done: boolean;
      at: number;
    };

export type SubagentRunState = {
  delegationId: string;
  agentName: string;
  description?: string;
  /** 派活说明原文（快照带回）：面板第一条气泡的后备来源 */
  task?: string;
  status: SubagentRunStatus;
  startedAt?: number;
  completedAt?: number;
  turns: number;
  toolCalls: number;
  /** 最终报告（status 条目 / 快照带回） */
  report?: string;
  blocks: SubagentBlock[];
  /** 快照已拉取过（成功或 expired），避免重复请求 */
  hydrated: boolean;
  /** 快照查无此委派（重启/记录被清）：面板显示过期空态 */
  expired: boolean;
};

/** 本地活动块上限（sidecar 缓冲 400；实时流再高一个量级封顶，防长任务撑爆） */
const MAX_LOCAL_BLOCKS = 1200;

const runs = new Map<string, SubagentRunState>();
/** toolCallId -> delegationId（data-subagentDelegation 绑定） */
const bindings = new Map<string, string>();
const listeners = new Set<() => void>();
const hydrating = new Set<string>();

function notify() {
  for (const l of listeners) l();
}

function defaultState(delegationId: string): SubagentRunState {
  return {
    delegationId,
    agentName: "",
    status: "running",
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    blocks: [],
    hydrated: false,
    expired: false,
  };
}

/** 浅拷贝更新（useSyncExternalStore 快照要求引用不可变） */
function updateRun(
  delegationId: string,
  mutate: (draft: SubagentRunState) => void,
): void {
  const cur = runs.get(delegationId) ?? defaultState(delegationId);
  const next: SubagentRunState = { ...cur, blocks: [...cur.blocks] };
  mutate(next);
  runs.set(delegationId, next);
  notify();
}

/** 把一条归一化活动条目并进 blocks（live 通知与快照回放共用同一 reducer） */
function applyItemTo(draft: SubagentRunState, item: SubagentActivityItem): void {
  switch (item.kind) {
    case "turn": {
      draft.turns = Math.max(draft.turns, item.n);
      draft.blocks.push({ kind: "turn", n: item.n, at: item.at });
      break;
    }
    case "thinking":
    case "text": {
      const blocks = draft.blocks;
      if (item.op === "start") {
        blocks.push({
          kind: item.kind,
          id: item.id,
          text: "",
          done: false,
          startedAt: item.at,
        });
      } else if (item.op === "delta") {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === item.kind && b.id === item.id && !b.done) {
            blocks[i] = { ...b, text: b.text + (item.delta ?? "") };
            break;
          }
        }
        // 找不到开放块（start 丢了）：以 delta 直接起一块
        if (!blocks.some((b) => b.kind === item.kind && b.id === item.id)) {
          blocks.push({
            kind: item.kind,
            id: item.id,
            text: item.delta ?? "",
            done: false,
            startedAt: item.at,
          });
        }
      } else {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === item.kind && b.id === item.id && !b.done) {
            blocks[i] = { ...b, done: true, endedAt: item.at };
            break;
          }
        }
      }
      break;
    }
    case "tool": {
      const blocks = draft.blocks;
      if (item.op === "start") {
        // 实时计数（live 行显示用）；status 终态条目与快照会以权威值覆盖
        draft.toolCalls += 1;
        blocks.push({
          kind: "tool",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          argsSummary: item.argsSummary,
          done: false,
          at: item.at,
        });
      } else {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === "tool" && b.toolCallId === item.toolCallId) {
            blocks[i] = {
              ...b,
              resultSummary: item.resultSummary,
              failed: item.failed,
              done: true,
            };
            break;
          }
        }
      }
      break;
    }
    case "status": {
      draft.status = item.status;
      draft.turns = item.turns;
      draft.toolCalls = item.toolCalls;
      draft.completedAt = item.at;
      if (item.report) draft.report = item.report;
      break;
    }
  }
  if (draft.blocks.length > MAX_LOCAL_BLOCKS) {
    draft.blocks.splice(0, draft.blocks.length - MAX_LOCAL_BLOCKS);
  }
}

/** transport postTransform 拦截 data-subagentDelegation（旁路 chunk 不进消息流） */
export function applyDelegationChunk(data: unknown): void {
  const d = data as {
    toolCallId?: unknown;
    delegationId?: unknown;
    agentName?: unknown;
    description?: unknown;
  };
  if (typeof d?.toolCallId !== "string" || typeof d?.delegationId !== "string") return;
  bindings.set(d.toolCallId, d.delegationId);
  const agentName = typeof d.agentName === "string" ? d.agentName : "";
  const description = typeof d.description === "string" ? d.description : undefined;
  updateRun(d.delegationId, (draft) => {
    if (agentName) draft.agentName = agentName;
    if (description) draft.description = description;
  });
}

/** 历史重建兜底：Task 结果文本里的 8 位短 id（"Delegation abc12345 started"） */
export function parseDelegationIdFromResult(text: string): string | undefined {
  return /Delegation ([0-9a-f]{8}) started/.exec(text)?.[1];
}

/** 完整 id 直查；≥4 位前缀在已知条目里找唯一匹配（与 sidecar findDelegation 同语义） */
export function resolveDelegationId(idOrPrefix: string | undefined): string | undefined {
  if (!idOrPrefix) return undefined;
  if (runs.has(idOrPrefix)) return idOrPrefix;
  if (idOrPrefix.length < 4) return undefined;
  let found: string | undefined;
  for (const id of runs.keys()) {
    if (id.startsWith(idOrPrefix)) {
      if (found) return undefined; // 歧义前缀不猜
      found = id;
    }
  }
  return found;
}

export function getSubagentRun(idOrPrefix: string | undefined): SubagentRunState | undefined {
  const id = resolveDelegationId(idOrPrefix);
  return id ? runs.get(id) : undefined;
}

export function getSubagentRunByToolCall(toolCallId: string): SubagentRunState | undefined {
  return getSubagentRun(bindings.get(toolCallId));
}

/** binding 反查：delegationId → toolCallId（面板据此在主会话消息流里定位那条 Task 工具行，
 *  取它的 args.task 作为"派活说明"）。无绑定时返回 undefined，调用方回退按结果文本匹配 */
export function toolCallIdForDelegation(idOrPrefix: string): string | undefined {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  for (const [toolCallId, delegationId] of bindings) {
    if (delegationId === id) return toolCallId;
  }
  return undefined;
}

/**
 * 快照水合（幂等，防并发重入）：打开 tab / 只见到活动没见到绑定时调用。
 * meta 以快照为准（权威）；blocks 本地已有则不覆盖（live 尾随在前）。
 */
export async function hydrateSubagentSnapshot(idOrPrefix: string): Promise<void> {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  if (runs.get(id)?.hydrated || hydrating.has(id)) return;
  hydrating.add(id);
  try {
    const res = await piRequest<
      Extract<PiResponse, { type: "subagent_activity_snapshot" }>
    >({ type: "get_subagent_activity", delegationId: id });
    // 规范键迁移：前缀/短 id 查询建的别名条目并回全量 id 名下——否则后续
    // 按完整 delegationId 广播的活动会另立门户，别名 tab 收不到增量尾巴
    const canonical = res.record.delegationId || id;
    if (canonical !== id) {
      const alias = runs.get(id);
      runs.delete(id);
      if (alias) {
        const cur = runs.get(canonical);
        runs.set(canonical, {
          ...cur,
          delegationId: canonical,
          agentName: cur?.agentName || alias.agentName,
          description: cur?.description ?? alias.description,
          blocks: cur?.blocks.length ? cur.blocks : alias.blocks,
          startedAt: cur?.startedAt ?? alias.startedAt,
          status: cur && cur.status !== "running" ? cur.status : alias.status,
          completedAt: cur?.completedAt ?? alias.completedAt,
          turns: Math.max(cur?.turns ?? 0, alias.turns),
          toolCalls: Math.max(cur?.toolCalls ?? 0, alias.toolCalls),
          report: cur?.report ?? alias.report,
          hydrated: false, // 快照载荷随即写入正式条目
          expired: false,
        });
      }
    }
    updateRun(canonical, (draft) => {
      draft.agentName = res.record.agentName || draft.agentName;
      draft.description = res.record.description ?? draft.description;
      draft.task = res.record.task ?? draft.task;
      draft.status = res.record.status as SubagentRunStatus;
      draft.startedAt = res.record.startedAt;
      draft.completedAt = res.record.completedAt;
      draft.turns = res.record.turns;
      draft.toolCalls = res.record.toolCalls;
      draft.report = res.record.report ?? draft.report;
      if (draft.blocks.length === 0) {
        for (const item of res.items as SubagentActivityItem[]) {
          applyItemTo(draft, item);
        }
      }
      draft.hydrated = true;
    });
  } catch {
    // 查无记录（sidecar 重启/被清理）或旧 sidecar 无此命令：标记过期，不再重试
    updateRun(id, (draft) => {
      draft.hydrated = true;
      draft.expired = true;
    });
  } finally {
    hydrating.delete(id);
  }
}

let watchStarted = false;

/** 幂等启动活动通知订阅（首个 Task 行/面板 tab 挂载时触发；WS 通道无能力则空转） */
export function startSubagentRunsWatch(): void {
  if (watchStarted) return;
  const channel = getPiChannel();
  if (!channel.subscribeSubagentActivity) return;
  watchStarted = true;
  void (async () => {
    const teardown = await channel.subscribeSubagentActivity!((delegationId, item) => {
      if (!runs.has(delegationId)) {
        // 没赶上绑定 chunk（别的窗口启动的委派）：立条目并拉快照补 meta
        runs.set(delegationId, defaultState(delegationId));
        void hydrateSubagentSnapshot(delegationId);
      }
      updateRun(delegationId, (draft) => applyItemTo(draft, item));
    });
    void teardown; // 与页面同生命周期，不退订
  })();
}

/** 打开（或激活）该委派的「子智能体」面板 tab：一个委派一个 tab，支持并行多开 */
export function openSubagentTab(idOrPrefix: string, title?: string): void {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  const { tabs } = getPanelTabs();
  const existing = tabs.find((t) => t.type === "subagent" && t.delegationId === id);
  if (existing) {
    setActivePanelTab(existing.id);
  } else {
    openPanelTab("subagent", { delegationId: id, title });
  }
  // 面板收起时唤起（同 tool-panel 的入口行为）
  window.dispatchEvent(new Event("agent-panel:open"));
}

/** 运行秒数（running 取当下，结算取 completedAt）；无 startedAt 返回 0 */
export function subagentElapsedSeconds(
  run: SubagentRunState | undefined,
  now: number = Date.now(),
): number {
  if (!run?.startedAt) return 0;
  const end = run.status === "running" ? now : (run.completedAt ?? now);
  return Math.max(0, Math.round((end - run.startedAt) / 1000));
}

function subscribeRuns(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 消息行 hook：toolCallId → 绑定的委派条目 */
export function useSubagentRunByToolCall(toolCallId: string): SubagentRunState | undefined {
  useEffect(() => {
    startSubagentRunsWatch();
  }, []);
  return useSyncExternalStore(
    subscribeRuns,
    () => getSubagentRunByToolCall(toolCallId),
    () => undefined,
  );
}

/** 面板 tab hook：按 id/前缀取条目；条目未立起或没赶上活动流时拉快照补水合 */
export function useSubagentRun(idOrPrefix: string | undefined): SubagentRunState | undefined {
  useEffect(() => {
    startSubagentRunsWatch();
    if (idOrPrefix) void hydrateSubagentSnapshot(idOrPrefix);
  }, [idOrPrefix]);
  return useSyncExternalStore(
    subscribeRuns,
    () => getSubagentRun(idOrPrefix),
    () => undefined,
  );
}
