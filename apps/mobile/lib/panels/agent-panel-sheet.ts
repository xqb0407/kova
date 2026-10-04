"use client";

/**
 * 面板抽屉的开关状态（模块级 store）：药丸自己点开是一路，`/activity`、
 * `/plan-panel` 这类指令要在没有药丸的情况下也能把面板唤起来，所以开关
 * 不能只活在药丸组件的 useState 里。会话维度不参与：面板是当前线程的视图，
 * 换线程时由拿到的最新 threadId 派生内容。
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openAgentPanel(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeAgentPanel(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useAgentPanelOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => open,
    () => false,
  );
}
