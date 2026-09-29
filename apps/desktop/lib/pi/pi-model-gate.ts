"use client";

import { useAuiState } from "@assistant-ui/react";
import { toast } from "@/components/ui/toast";
import { useThreadModel } from "@/lib/pi/pi-session-model";

/**
 * 未选模型闸门：当前线程（含会话级记忆，回落全局）没有模型选择时为 true。
 *
 * 为什么需要它：sidecar 的 resolveCurrentModel 在无选择时会静默取目录里第一个
 * 有凭据的模型（defaultModel），界面却显示「选择模型」占位——用户看到的与实际
 * 应答的模型不是一回事，且没有任何提示。发送入口据此显式拦下（发送键禁用、
 * Enter 不提交），把「先选模型」摆在动作发生前。
 *
 * 取值口径与 model-picker 显示的完全一致（同一个 useThreadModel），避免出现
 * 「界面说有模型、闸门说没有」的分叉。
 */
export function useNoModelSelected(): boolean {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  return useThreadModel(threadId) == null;
}

/** 拦下发送时的提示文案（发送键 tooltip 与 toast 共用同一句） */
export const NO_MODEL_HINT = "先选择模型，再发送消息";

let lastHintAt = 0;

/** 发送被闸门拦下时的一次性提示：3s 内不重复弹（连按 Enter 不刷屏） */
export function notifyNoModelSelected(): void {
  const now = Date.now();
  if (now - lastHintAt < 3000) return;
  lastHintAt = now;
  toast.error(NO_MODEL_HINT);
}
