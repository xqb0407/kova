"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { listen } from "@/desktop-bridge/event";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  LIBRARY_DIRECTIVE_TYPE,
  parseLibraryDirectiveId,
  setMissingLibraryRefIds,
  type ParsedLibraryReference,
} from "@/lib/composer/library-reference";
import { libraryRefsCheck } from "@/lib/workspace/library-note-meta";

/**
 * 资料库引用失效守卫：草稿里的 `:library[...]` 芯片是插入时固化的绝对路径，
 * 文件可能在那之后被删除（Finder/同步盘/应用内）。这里持续校验并把缺失的
 * 引用暴露给两处：
 *
 * - `MissingReferencesBar`（输入框上方）：列出失效引用 + 一键移除；
 * - 发送拦截：ImeEnterGuard / 发送按钮按**当前线程**检查
 *   `hasMissingLibraryRefs(threadId)`，有失效引用就不发（toast 提示先移除）。
 *
 * 另有一道安全网在发送展开（expandLibraryDirectives 的缺失集合）：即使绕过
 * UI 发送，也输出「已删除」标记而不是死路径。
 *
 * 校验时机：草稿变化（防抖）、窗口聚焦 / 页面可见、`library:changed`
 * （主进程 watcher 的变更广播，见 main/library-watch.ts）。校验失败一律
 * fail-open——不因为探测命令挂掉而把用户锁在输入框外。
 */

export interface MissingLibraryRef {
  /** 指令 id（精确移除用） */
  id: string;
  /** 芯片 label（展示用） */
  label: string;
  rel: string;
}

const EMPTY: readonly MissingLibraryRef[] = [];

const byThread = new Map<string, MissingLibraryRef[]>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** 全局缺失集合同步（发送展开安全网的读取源；跨线程并集） */
function syncGlobalMissing(): void {
  const ids = new Set<string>();
  for (const list of byThread.values()) {
    for (const item of list) ids.add(item.id);
  }
  setMissingLibraryRefIds(ids);
}

function setThreadMissing(
  threadId: string,
  list: MissingLibraryRef[],
): void {
  if (list.length === 0) {
    if (!byThread.has(threadId)) return;
    byThread.delete(threadId);
  } else {
    byThread.set(threadId, list);
  }
  syncGlobalMissing();
  emitChange();
}

/** 当前会话草稿里的失效引用（MissingReferencesBar / 发送按钮消费） */
export function useMissingLibraryRefs(
  threadId: string | null | undefined,
): readonly MissingLibraryRef[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (byThread.get(threadId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

/**
 * 发送拦截用（同步、无 hook 场景）。传 threadId 时只看当前线程——旧线程残留的
 * 失效状态不该阻塞当前对话；不传则查全局并集（仅诊断/兜底用）。
 */
export function hasMissingLibraryRefs(threadId?: string | null): boolean {
  if (threadId) return (byThread.get(threadId)?.length ?? 0) > 0;
  for (const list of byThread.values()) {
    if (list.length > 0) return true;
  }
  return false;
}

function collectLibraryRefs(
  text: string,
): { id: string; label: string; ref: ParsedLibraryReference }[] {
  if (!text.includes(":library[")) return [];
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  const out: { id: string; label: string; ref: ParsedLibraryReference }[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") continue;
    if (segment.type !== LIBRARY_DIRECTIVE_TYPE) continue;
    const ref =
      parseLibraryDirectiveId(segment.id) ??
      parseLibraryDirectiveId(segment.label);
    if (ref) out.push({ id: segment.id, label: segment.label, ref });
  }
  return out;
}

/** 按线程递增的校验序号：并发线程各自作废自己的旧请求，不互相踩 */
const validateSeqByThread = new Map<string, number>();

/** 校验当前草稿里的资料库引用；结果写入 store（含全局安全网同步） */
export async function validateDraftLibraryRefs(
  threadId: string,
  text: string,
): Promise<void> {
  const refs = collectLibraryRefs(text);
  if (refs.length === 0) {
    setThreadMissing(threadId, []);
    return;
  }
  const ticket = (validateSeqByThread.get(threadId) ?? 0) + 1;
  validateSeqByThread.set(threadId, ticket);
  const isCurrent = () => validateSeqByThread.get(threadId) === ticket;
  let missing: MissingLibraryRef[];
  try {
    const res = await libraryRefsCheck(
      refs.map((r) => ({ id: r.id, rel: r.ref.rel, absPath: r.ref.absPath })),
    );
    if (!isCurrent()) return;
    const missingIds = new Set(res.missing);
    missing = refs
      .filter((r) => missingIds.has(r.id))
      .map((r) => ({ id: r.id, label: r.label, rel: r.ref.rel }));
  } catch {
    // 探测命令失败：维持现状（fail open），不把用户锁在输入框外
    return;
  }
  setThreadMissing(threadId, missing);
}

/**
 * 草稿守卫 hook（composer 挂载）：文本变化防抖校验；聚焦 / watcher 变更重校验。
 */
export function useLibraryRefGuard(
  threadId: string | null | undefined,
  text: string,
): void {
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!threadId) return;
    if (!text.includes(":library[")) {
      void validateDraftLibraryRefs(threadId, text);
      return;
    }
    const timer = setTimeout(() => {
      void validateDraftLibraryRefs(threadId, textRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [threadId, text]);

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let off: (() => void) | undefined;
    void listen("library:changed", () => {
      void validateDraftLibraryRefs(threadId, textRef.current);
    }).then((un) => {
      if (!alive) un();
      else off = un;
    });
    const revalidate = () => {
      void validateDraftLibraryRefs(threadId, textRef.current);
    };
    window.addEventListener("focus", revalidate);
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [threadId]);
}
