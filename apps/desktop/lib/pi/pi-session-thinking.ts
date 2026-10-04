"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import {
  getThinkingLevel,
  useThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@/lib/settings/thinking-settings";
import { refreshSessionPrefs, piSessionIdForThread, piSessionPrefsMap } from "@/lib/pi/pi-thread-adapter";

/**
 * 会话级思考档位记忆的前端镜像（与 pi-session-model 同款形态）：
 * - 事实源在 sidecar：转录 thinking_level_change 行（§6 M4 真值），投影到
 *   sessions 表 thinking_level 偏好列供列表水合；定靶 set_thinking 只写被点名
 *   会话，其余会话不受影响；
 * - 无会话级记忆的线程回落**默认档位**（设置页/启动恢复维护的 kv pi.thinking）；
 * - 未发送草稿（还没有 sessionId）的档位选择只记内存，首条消息派发前经
 *   flushDraftThinkingSelection 定靶写入新建会话。
 */

/** threadId -> 该线程记住的档位（会话偏好列有值、或草稿期用户显式选过才有条目） */
const threadLevels = new Map<string, ThinkingLevel>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function asThinkingLevel(raw: unknown): ThinkingLevel | null {
  return (THINKING_LEVELS as readonly string[]).includes(String(raw))
    ? (raw as ThinkingLevel)
    : null;
}

/** 当前线程的档位显示值：会话级记忆优先，无则回落默认档位 */
export function useThreadThinking(threadId: string | undefined): ThinkingLevel {
  const own = useSyncExternalStore(
    subscribe,
    () => (threadId ? (threadLevels.get(threadId) ?? null) : null),
    () => null,
  );
  const fallback = useThinkingLevel();
  return own ?? fallback;
}

/** 切线程时水合：取该会话持久化的档位；没有记忆的已建线程清掉陈旧条目回落默认。
 *  未落库草稿不清——草稿期的显式选择跟随到其会话诞生 */
export function hydrateThreadThinking(threadId: string): void {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  const own = asThinkingLevel(prefs?.thinkingLevel);
  const current = threadLevels.get(threadId) ?? null;
  if (own === current) return;
  if (own) threadLevels.set(threadId, own);
  else threadLevels.delete(threadId);
  notify();
}

/**
 * 在线程里选档位：带本线程 sessionId 定靶 set_thinking（sidecar 只对该会话落
 * 档位行/偏好列，不动默认档位）；未发送草稿只记内存，首条发送建会话后 flush。
 * 定靶被拒（sidecar 不可用/会话不存在）回退到落库真值显示。
 */
export async function setThreadThinking(
  threadId: string,
  level: ThinkingLevel,
): Promise<void> {
  threadLevels.set(threadId, level);
  notify();
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  try {
    await piRequest({ type: "set_thinking", level, sessionId });
  } catch {
    hydrateThreadThinking(threadId);
    notify();
    return;
  }
  await refreshSessionPrefs();
  hydrateThreadThinking(threadId);
  notify();
}

/** 首条消息派发前（initialize 绑定 sessionId 后）把草稿期记忆的档位定靶写入新建会话 */
export function flushDraftThinkingSelection(threadId: string): void {
  const saved = threadLevels.get(threadId);
  if (!saved) return;
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  if (asThinkingLevel(prefs?.thinkingLevel)) return;
  void setThreadThinking(threadId, saved);
}

/** 诊断/测试用：全局默认档位的直读 */
export function getThreadThinkingSnapshot(threadId: string): ThinkingLevel {
  return threadLevels.get(threadId) ?? getThinkingLevel();
}
