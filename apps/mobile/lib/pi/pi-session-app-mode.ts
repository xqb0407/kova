"use client";

import { useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react-native";
import { piRequest } from "@/lib/pi/pi-bridge";
import { getAppMode, useAppMode, type AppMode } from "@/lib/pi/app-mode";
import {
  refreshSessionPrefs,
  piSessionIdForThread,
  piSessionPrefsMap,
} from "@/lib/pi/pi-thread-adapter";

/**
 * 会话级工作模式（work / code / design）的前端镜像（与 pi-session-thinking 同款形态）：
 * - 事实源在 sidecar：sessions 表 app_mode 偏好列（NULL = 本会话从未切过档），
 *   投影进 list_sessions 快照供水合；定靶 set_app_mode 只写被点名会话，
 *   A 会话切档不牵连 B 会话，也不动全局默认；
 * - 无会话级记忆的线程回落**全局默认档**（设置 → 通用维护的 kv pi.app_mode，
 *   镜像在 lib/pi/app-mode.ts——新对话用的就是它）；
 * - 未发送草稿（还没有 sessionId）的档位选择只记内存，首条消息派发前经
 *   flushDraftAppModeSelection 定靶写入新建会话。
 *
 * 与 pi-session-mode（agent/plan/ask 权限档）正交：那个切权限，这个切人群定位。
 */

/** threadId -> 该线程记住的档位（会话偏好列有值、或草稿期用户显式选过才有条目） */
const threadModes = new Map<string, AppMode>();
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

/** 白名单外的脏值视同「本会话没有记忆」，交由回落处理 */
function asAppMode(raw: unknown): AppMode | null {
  return raw === "work" || raw === "code" || raw === "design" ? raw : null;
}

/** 当前线程的档位显示值：会话级记忆优先，无则回落全局默认档 */
export function useThreadAppMode(threadId: string | undefined): AppMode {
  const own = useSyncExternalStore(
    subscribe,
    () => (threadId ? (threadModes.get(threadId) ?? null) : null),
    () => null,
  );
  const fallback = useAppMode();
  return own ?? fallback;
}

/**
 * 主线程的生效档位（不在顶栏、又处处要看档位的消费点用：工具行收敛、Git 胶囊
 * 显隐、面板标签…）。形态对齐 pi-session-mode 的 useIsAskMode：自取 mainThreadId，
 * 调用方不必层层透传 threadId。
 */
export function useCurrentAppMode(): AppMode {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  return useThreadAppMode(threadId);
}

/** 切线程时水合：取该会话持久化的档位；没有记忆的已建线程清掉陈旧条目回落默认档。
 *  未落库草稿不清——草稿期的显式选择跟随到其会话诞生 */
export function hydrateThreadAppMode(threadId: string): void {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  const own = asAppMode(prefs?.appMode);
  const current = threadModes.get(threadId) ?? null;
  if (own === current) return;
  if (own) threadModes.set(threadId, own);
  else threadModes.delete(threadId);
  notify();
}

/**
 * 在线程里选档位：带本线程 sessionId 定靶 set_app_mode（sidecar 只对该会话落
 * 偏好列并重排该会话提示词，全局默认与其它会话不动）；未发送草稿只记内存，
 * 首条发送建会话后 flush。定靶被拒（sidecar 不可用/会话不存在）回退到落库真值显示。
 */
export async function setThreadAppMode(
  threadId: string,
  mode: AppMode,
): Promise<void> {
  threadModes.set(threadId, mode);
  notify();
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  try {
    await piRequest({ type: "set_app_mode", mode, sessionId });
  } catch {
    hydrateThreadAppMode(threadId);
    notify();
    return;
  }
  await refreshSessionPrefs();
  hydrateThreadAppMode(threadId);
  notify();
}

/** 首条消息派发前（initialize 绑定 sessionId 后）把草稿期记忆的档位定靶写入新建会话 */
export function flushDraftAppModeSelection(threadId: string): void {
  const saved = threadModes.get(threadId);
  if (!saved) return;
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return;
  const prefs = piSessionPrefsMap.get(sessionId);
  if (asAppMode(prefs?.appMode)) return;
  void setThreadAppMode(threadId, saved);
}

/** 诊断/测试用：当前线程生效档位的直读（非响应式） */
export function getThreadAppModeSnapshot(threadId: string): AppMode {
  return threadModes.get(threadId) ?? getAppMode();
}
