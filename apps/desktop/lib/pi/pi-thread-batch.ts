"use client";

import { useSyncExternalStore } from "react";

/**
 * 侧边栏批量管理模式（ephemeral，不持久化）：
 * - active：批量模式开关。开启后列表行渲染勾选框、点击行 = 切换选中
 *   （不激活会话）；关闭即清空选择
 * - selected：跨 tab 统一的选中集合（任务/项目两个 tab 勾的是同一池，
 *   切 tab 不清）——批量归档一次可覆盖两个 tab 里勾中的会话
 * - visibleIds：各 tab 当前渲染的会话 id 集，由列表组件注册（搜索过滤、
 *   项目组「显示更多」分页后同步更新），「全选」只选当前 tab 的可见项
 */

export type ThreadBatchTab = "tasks" | "projects";

export interface ThreadBatchState {
  readonly active: boolean;
  /** 插入序保留勾选先后（action bar 展示「已选 n 项」即此数） */
  readonly selected: readonly string[];
  readonly visible: Readonly<
    Record<ThreadBatchTab, readonly string[] | undefined>
  >;
}

const EMPTY_STATE: ThreadBatchState = {
  active: false,
  selected: [],
  visible: { tasks: undefined, projects: undefined },
};

const listeners = new Set<() => void>();

let state: ThreadBatchState = EMPTY_STATE;

function setState(next: ThreadBatchState) {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getThreadBatchState(): ThreadBatchState {
  return state;
}

export function enterThreadBatch(): void {
  if (state.active) return;
  setState({ ...state, active: true });
}

/** 退出即清空：批量选择是模式内的临时集合，不跨模式保留 */
export function exitThreadBatch(): void {
  if (!state.active && state.selected.length === 0) return;
  setState({ ...state, active: false, selected: [] });
}

/** 勾选切换；未开启批量模式时忽略（行内不应出现入口，兜底防误触） */
export function toggleThreadBatchSelect(id: string): void {
  if (!state.active) return;
  setState(
    state.selected.includes(id)
      ? { ...state, selected: state.selected.filter((s) => s !== id) }
      : { ...state, selected: [...state.selected, id] },
  );
}

/** 全选（当前 tab 可见项）/ 清空选择（按钮复用：全选后即「取消全选」） */
export function setThreadBatchSelection(ids: readonly string[]): void {
  if (!state.active) return;
  setState({ ...state, selected: [...ids] });
}

/** 列表组件注册/注销当前 tab 的可见 id 集（搜索/分页/空列表同步跟进）。
 *
 *  按内容比对，不是引用比对：可见集是列表组件里 useMemo 出来的数组，上游
 *  （threadIds / 分组 / 置顶）只要换个新引用身份就变，而注册发生在 effect 里
 *  ——引用不等就写入 → 订阅整份 state 的 CloneThreadShell 重渲染 → 列表重算
 *  又给一个新数组 → 再写入，就是那条「Maximum update depth exceeded」。
 *  内容一样就当作没发生（可见集是集合语义，身份对消费者没有意义）。 */
export function setThreadBatchVisible(
  tab: ThreadBatchTab,
  ids: readonly string[] | undefined,
): void {
  const prev = state.visible[tab];
  if (prev === ids) return;
  if (prev && ids && prev.length === ids.length && prev.every((id, i) => id === ids[i])) {
    return;
  }
  setState({ ...state, visible: { ...state.visible, [tab]: ids } });
}

export function useThreadBatchState(): ThreadBatchState {
  return useSyncExternalStore(subscribe, getThreadBatchState, () => EMPTY_STATE);
}

/** 行组件窄订阅：只随模式开关重渲染 */
export function useThreadBatchActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state.active,
    () => false,
  );
}

/** 行组件窄订阅：只随本行选中与否重渲染（勾选别的行不牵连） */
export function useIsThreadBatchSelected(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state.selected.includes(id),
    () => false,
  );
}
