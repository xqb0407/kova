"use client";

/**
 * 桌宠事件转发（主窗口侧）：agent-events 总线 → 主进程 → 悬浮窗。
 *
 * 悬浮窗是独立渲染进程，听不到主窗口内存里的 agent-events 总线；这里把六类
 * 生命周期事件原样经 bridge 转给主进程，由 pet-window.ts 投递到悬浮窗。
 * 内嵌宿主（主窗口内）不走这条链——它直接 subscribeAgentEvents。
 *
 * 在 `initNotifyPipeline` 同点接线（幂等）；bridge 调用失败静默（悬浮窗没开
 * 时主进程返回后丢弃，转发本身永远不该影响会话主流程）。
 */

import { subscribeAgentEvents } from "@/lib/pi/agent-events";
import { relayPetEvent } from "@/desktop-bridge/pet";
import { isDesktop } from "@/lib/desktop-env";

let started = false;

export function startPetEventRelay(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (!isDesktop()) return;
  subscribeAgentEvents((event) => {
    void relayPetEvent({
      name: event.name,
      threadId: event.threadId,
      data: event.data,
      occurredAt: event.occurredAt,
    }).catch(() => {
      // 悬浮窗未创建 / 桥不可用：转发失败可接受，不重试不落盘
    });
  });
}
