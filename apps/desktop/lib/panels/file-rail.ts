"use client";

import { useSyncExternalStore } from "react";

/**
 * 文件预览右缘文件树的展开态（模块级、应用生命周期内记忆）：
 * 切文件标签会重挂载视图，开合状态若放组件 state 会每次回到默认——
 * 这里按 lib/terminal/dock.ts 的同款形态持有，切标签原样保持。
 * 不持久化：重启回到默认展开。
 */

let open = true;
/** 展开态宽度（px）：拖拽调宽，模块级记忆（切文件标签不重置） */
export const RAIL_MIN_WIDTH = 160;
export const RAIL_MAX_WIDTH = 480;
const RAIL_DEFAULT_WIDTH = 224;
let width = RAIL_DEFAULT_WIDTH;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 订阅右栏是否展开（原始值快照：只有开合翻转才重渲染） */
export function useFileRailOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => true,
  );
}

/** 切换右栏开合 */
export function toggleFileRail(): void {
  open = !open;
  notify();
}

/** 订阅展开态宽度（拖拽逐帧调用，快照是原始值，只有变化才通知） */
export function useFileRailWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => width,
    () => RAIL_DEFAULT_WIDTH,
  );
}

/** 宽度夹取（拖拽实时预览与最终提交共用同一规则）：
 *  再窄树不可用，再宽把代码区挤没 */
export function clampFileRailWidth(px: number): number {
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(px)));
}

/** 设置展开态宽度 */
export function setFileRailWidth(px: number): void {
  const next = clampFileRailWidth(px);
  if (next === width) return;
  width = next;
  notify();
}

/** 测试缝：直读当前开态 / 宽度（与 hook 同源） */
export const fileRailOpenForTest = (): boolean => open;
export const fileRailWidthForTest = (): number => width;
