"use client";

import { useSyncExternalStore } from "react";

/**
 * 主区导航历史（浏览器式前进/后退，ephemeral，不持久化）。
 *
 * 条目是主区状态的快照 { threadId, menu }：threadId = assistant-ui 的
 * mainThreadId（含未落盘草稿的 __LOCALID_ id，进程内稳定）；menu =
 * activeMenu（"" 即聊天页）。设置页走 base 的独立 view 状态，不在栈里；
 * 历史为进程内 ephemeral，刷新即清（浏览器常规，草稿 id 也不会跨重启残留）。
 *
 * 记录与执行分离：
 * - 记录：CloneThreadShell（唯一实例）挂 tracker，[mainThreadId, currentMenu]
 *   变化即 syncNavCurrent。非导航引发的变化把合并窗口起点压进 back、清空
 *   forward；导航执行中（applying）的变化只更新 current 不动栈，threadId
 *   追平 pending 那一次顺带解除 applying——menu 同步先落、会话异步后落，
 *   两次上报都在 applying 期内，不产生中间条目。
 * - 合并窗口（BURST_WINDOW_MS）：一次用户操作常触发两次上报（从页面点
 *   会话行：先清菜单再切线程）。窗口内的连续上报合并为一次入栈、取窗口
 *   起点的快照——否则「页面 → 点会话 → 后退」要按两次才回页面。
 * - 启动占位（provisional）：首个快照是启动期的占位草稿，启动回切落地时
 *   直接替换、不入栈——否则每次刷新 back 里都躺着一个幻影「新对话」。
 * - 执行：按钮调 requestNavBack/Forward，store 弹栈计算目标并置
 *   applying/pending（applySeq 自增触发订阅者）；执行器（也是
 *   CloneThreadShell——唯一同时持有 setActiveMenu 与 aui 的地方）据此
 *   setActiveMenu + switchToThread。applying 的解除以 tracker 侧追平为准；
 *   切换失败由执行器 finishNavApply 复位；APPLY_TIMEOUT_MS 是兜底安全阀，
 *   防止切换悬挂把导航永久锁死（switchToThread 对已删 id 不抛错而是拉空
 *   快照造幽灵行，执行器须先行校验目标仍在列表里，见 shell 侧）。
 */

export interface ThreadNavEntry {
  /** assistant-ui mainThreadId（含草稿 id） */
  threadId: string;
  /** 主区菜单（activeMenu）；"" = 聊天页 */
  menu: string;
}

export interface ThreadNavState {
  readonly back: readonly ThreadNavEntry[];
  readonly forward: readonly ThreadNavEntry[];
  readonly current: ThreadNavEntry;
  /** 导航执行中：syncNavCurrent 只更新 current，不动栈 */
  readonly applying: boolean;
  /** 待切换的目标（applying 时非空） */
  readonly pending: ThreadNavEntry | null;
  /** apply 请求序号：执行器的 effect 依赖它触发 */
  readonly applySeq: number;
  /** 首个快照尚未到达（未开始记录） */
  readonly started: boolean;
  /** 首个快照是启动占位：下一个真实落地直接替换，不入栈 */
  readonly provisional: boolean;
}

/** 历史栈上限（两个栈各自计）：防长会话无限增长；浏览器同样截断 */
const MAX_HISTORY = 50;
/** 连续上报的合并窗口：覆盖「清菜单 + 切线程」的两次同步/异步上报 */
const BURST_WINDOW_MS = 150;
/** applying 安全阀：切换悬挂超过此时长即复位，导航不永久锁死 */
const APPLY_TIMEOUT_MS = 5000;

const EMPTY_STATE: ThreadNavState = {
  back: [],
  forward: [],
  current: { threadId: "", menu: "" },
  applying: false,
  pending: null,
  applySeq: 0,
  started: false,
  provisional: false,
};

let state: ThreadNavState = EMPTY_STATE;

const listeners = new Set<() => void>();

function setState(next: ThreadNavState) {
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

export function getThreadNavState(): ThreadNavState {
  return state;
}

const sameEntry = (a: ThreadNavEntry, b: ThreadNavEntry) =>
  a.threadId === b.threadId && a.menu === b.menu;

let burstTimer: ReturnType<typeof setTimeout> | null = null;
let burstPrev: ThreadNavEntry | null = null;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

/** 把合并窗口攒下的「窗口起点」压入 back（窗口到期与 requestNav* 时调用） */
function flushBurst(): void {
  if (burstTimer) {
    clearTimeout(burstTimer);
    burstTimer = null;
  }
  const prev = burstPrev;
  burstPrev = null;
  if (!prev) return;
  setState({
    ...state,
    back: [...state.back, prev].slice(-MAX_HISTORY),
    forward: [],
  });
}

function armApplyTimeout(): void {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => finishNavApply(), APPLY_TIMEOUT_MS);
  // bun/node 下不阻止进程退出（测试兜底）；DOM lib 的 setTimeout 返回
  // number，unref 视运行时存在与否可选调用
  (applyTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * tracker 上报当前主区状态。非导航引发的变化：合并窗口起点压入 back、清空
 * forward（用户走向了新地方）。导航执行中只更新 current，直到 threadId
 * 追平 pending——menu 同步先落、会话异步后落，两次上报都在 applying 期内，
 * 追平那一次顺带解除 applying（成功切换的唯一定格路径；失败路径由执行器
 * finishNavApply 负责，安全阀兜底悬挂）。
 */
export function syncNavCurrent(next: ThreadNavEntry): void {
  if (!state.started) {
    clearNavTimers();
    setState({ ...EMPTY_STATE, started: true, current: next, provisional: true });
    return;
  }
  if (state.applying) {
    if (next.threadId === state.pending?.threadId) {
      if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = null;
      }
      setState({ ...state, current: next, applying: false, pending: null });
      return;
    }
    if (sameEntry(next, state.current)) return;
    setState({ ...state, current: next });
    return;
  }
  // 启动占位：首个真实落地直接替换，不产生「回到启动草稿」的幻影条目
  if (state.provisional) {
    setState({ ...state, current: next, provisional: false });
    return;
  }
  if (sameEntry(next, state.current)) return;
  // 合并窗口：起点只在窗口的第一笔上报时记，窗口内后续上报只推进 current
  if (!burstPrev) burstPrev = state.current;
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = setTimeout(flushBurst, BURST_WINDOW_MS);
  setState({ ...state, current: next, forward: [] });
}

/** 后退：back 弹栈 → current 进 forward；无可退或执行中返回 false */
export function requestNavBack(): boolean {
  if (state.applying || !state.started) return false;
  flushBurst();
  if (state.back.length === 0) return false;
  const target = state.back[state.back.length - 1];
  setState({
    ...state,
    back: state.back.slice(0, -1),
    forward: [...state.forward, state.current].slice(-MAX_HISTORY),
    applying: true,
    pending: target,
    applySeq: state.applySeq + 1,
  });
  armApplyTimeout();
  return true;
}

/** 前进：forward 弹栈 → current 进 back；无可进或执行中返回 false */
export function requestNavForward(): boolean {
  if (state.applying || !state.started) return false;
  flushBurst();
  if (state.forward.length === 0) return false;
  const target = state.forward[state.forward.length - 1];
  setState({
    ...state,
    forward: state.forward.slice(0, -1),
    back: [...state.back, state.current].slice(-MAX_HISTORY),
    applying: true,
    pending: target,
    applySeq: state.applySeq + 1,
  });
  armApplyTimeout();
  return true;
}

/** 导航执行收尾：成功落地由 tracker 的追平上报自然解除；切换失败（会话
 *  已删等）或安全阀到点由本方法复位，栈不回滚——目标条目就此放弃 */
export function finishNavApply(): void {
  if (!state.applying) return;
  if (applyTimer) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  setState({ ...state, applying: false, pending: null });
}

/** 测试与极端情况（执行器卸载等）复位历史 */
export function resetNavHistory(): void {
  clearNavTimers();
  state = EMPTY_STATE;
  for (const l of listeners) l();
}

function clearNavTimers(): void {
  if (burstTimer) {
    clearTimeout(burstTimer);
    burstTimer = null;
  }
  burstPrev = null;
  if (applyTimer) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
}

/** 立即结算合并窗口（requestNav* 前置与测试用） */
export function flushNavBurst(): void {
  flushBurst();
}

export function useThreadNavState(): ThreadNavState {
  return useSyncExternalStore(subscribe, getThreadNavState, () => EMPTY_STATE);
}

export function useThreadNavCanBack(): boolean {
  return useSyncExternalStore(
    subscribe,
    // 合并窗口挂着未入栈的起点也算可退（按钮不闪禁用）
    () =>
      !state.applying &&
      state.started &&
      (state.back.length > 0 || burstPrev !== null),
    () => false,
  );
}

export function useThreadNavCanForward(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !state.applying && state.started && state.forward.length > 0,
    () => false,
  );
}
