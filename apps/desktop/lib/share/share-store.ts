"use client";

/**
 * 分享选择模式的会话级状态（模块单例 + useSyncExternalStore）。
 *
 * 为什么不放 React Context：入口在 Header、选择层在每条消息、工具栏在 Thread，
 * 三处分属不同子树；模块 store 让三处各自订阅，不必把 Header/Thread 一起拖进
 * Provider。选择操作是低频动作，整体快照替换足够。
 *
 * 选择按「轮」联动：一条用户消息和它后面直到下一条用户消息之前的所有助手
 * 消息是同一轮——勾任意一条，整轮一起选/取消（消息列表经 syncShareTurns
 * 同步进 store；列表变化时工具栏会重新同步）。
 */
import { useSyncExternalStore } from "react";

export type ShareTurnMap = ReadonlyMap<string, readonly string[]>;

export type ShareModeState = {
  mode: "idle" | "selecting";
  selected: ReadonlySet<string>;
  /** 从「分享对话」进入：工具栏挂载后把当前会话的全部消息补成默认选中 */
  autoAll: boolean;
  /** 从「分享此条」进入：轮表同步到位后把选中项扩成整轮（一次性） */
  pendingExpand: boolean;
  turns: ShareTurnMap;
};

const IDLE: ShareModeState = {
  mode: "idle",
  selected: new Set(),
  autoAll: false,
  pendingExpand: false,
  turns: new Map(),
};

let state: ShareModeState = IDLE;
const listeners = new Set<() => void>();

const commit = (next: ShareModeState) => {
  state = next;
  for (const listener of listeners) listener();
};

export function subscribeShareState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getShareState(): ShareModeState {
  return state;
}

export function enterShareMode(ids?: readonly string[]): void {
  commit({
    mode: "selecting",
    selected: new Set(ids ?? []),
    autoAll: ids === undefined,
    pendingExpand: ids !== undefined,
    // 选择中再次进入（如换一条「分享此条」）：轮表仍然有效，保留即可用
    turns: state.mode === "selecting" ? state.turns : new Map(),
  });
}

export function exitShareMode(): void {
  if (state.mode === "idle") return;
  commit(IDLE);
}

/** 勾选按整轮生效；轮表还没同步到（极端时序）就退化为单条 */
export function toggleShareMessage(id: string): void {
  if (state.mode !== "selecting") return;
  const group = state.turns.get(id) ?? [id];
  const selected = new Set(state.selected);
  const turnOn = !selected.has(id);
  for (const groupId of group) {
    if (turnOn) selected.add(groupId);
    else selected.delete(groupId);
  }
  commit({ ...state, selected });
}

export function selectAllMessages(ids: readonly string[]): void {
  if (state.mode !== "selecting") return;
  commit({ ...state, selected: new Set(ids) });
}

export function clearShareSelection(): void {
  if (state.mode !== "selecting") return;
  commit({ ...state, selected: new Set() });
}

/** 工具栏挂载后调用：把「全选」意图落成具体 id 集合 */
export function materializeAutoAll(ids: readonly string[]): void {
  if (state.mode !== "selecting" || !state.autoAll) return;
  commit({ ...state, autoAll: false, selected: new Set(ids) });
}

/**
 * 消息列表 → 轮表同步（选择模式下消息集变化时由工具栏调用）。
 * 首次同步时若带着「分享此条」的一次性意图，把选中项扩成整轮。
 */
export function syncShareTurns(turns: ShareTurnMap): void {
  if (state.mode !== "selecting") return;
  // 头尾两个停靠条都会同步，轮表没变时跳过，避免多余的全局通知
  if (state.turns === turns && !state.pendingExpand) return;
  if (state.pendingExpand) {
    const selected = new Set<string>();
    for (const id of state.selected) {
      for (const groupId of turns.get(id) ?? [id]) selected.add(groupId);
    }
    commit({ ...state, turns, selected, pendingExpand: false });
    return;
  }
  commit({ ...state, turns });
}

export function useShareState(): ShareModeState {
  return useSyncExternalStore(subscribeShareState, getShareState, () => IDLE);
}
