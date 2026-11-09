"use client";

import { useSyncExternalStore } from "react";

/**
 * 资料库自动召回开关（默认开）。
 *
 * 控制两条路径，关掉后与旧版行为一致：
 * - composer 的「可能相关」建议条；
 * - 发送时附带最多 2 条笔记标题的隐藏块（library-hints）。
 *
 * 只影响**新消息**：已经发出去的隐藏块仍在历史里。持久化 localStorage，
 * 按客户端各自保存（桌面 WebView 与远程网页互不影响）。
 */
const STORAGE_KEY = "kova.library.autoRecall";

let enabled = true;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStored(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* 隐私模式/无 localStorage：默认开 */
  }
  return true;
}

if (typeof window !== "undefined") enabled = readStored();

export function isLibraryAutoRecallEnabled(): boolean {
  return enabled;
}

export function useLibraryAutoRecallEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isLibraryAutoRecallEnabled,
    () => true,
  );
}

export function setLibraryAutoRecallEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* 写失败：仅本进程生效 */
  }
  emit();
}
