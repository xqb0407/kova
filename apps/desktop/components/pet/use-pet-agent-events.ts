"use client";

/**
 * 桌宠事件接线：把一个「事件帧订阅源」翻译成宠物动作 + 头顶气泡。
 *
 * 订阅源由宿主注入（依赖倒置，两种宿主共用本 hook）：
 * - 内嵌宿主：`subscribeAgentEvents`（主窗口内存总线，零转发）；
 * - 悬浮窗宿主：desktop-bridge `listen("pet-agent-event")`（经主进程转投）；
 * - dev 预览页：本地模拟总线（按钮手动 emit）。
 *
 * 收敛规则：
 * - 映射不到的事件（未登记的新事件）直接忽略；
 * - 新事件顶掉旧气泡并重置自动收起计时；动作经命令面插播，播完自动回落；
 * - 气泡点击：带 threadId 时回调 `onOpenSession`（跳会话），否则仅收起。
 */

import * as React from "react";
import type { PetMotionInput } from "@/lib/pet/types";
import { reactionForAgentEvent } from "@/lib/pet/agent-mapping";
import type { PetAgentEventFrame } from "@/desktop-bridge/pet";
import type { PetBubbleState } from "./pet-bubble";

export type PetEventSubscribe = (
  cb: (frame: PetAgentEventFrame) => void,
) => () => void;

export interface UsePetAgentEventsOptions {
  /** 事件帧订阅源（见上） */
  subscribe: PetEventSubscribe;
  /** 命令面下发动作（PetRef.motion） */
  onMotion: (input: PetMotionInput) => void;
  /** 气泡点击跳会话（悬浮窗走桥，内嵌直发 window 事件；不传则点击仅收起） */
  onOpenSession?: (sessionId: string) => void;
  /** 气泡自动收起毫秒数（默认 6000） */
  bubbleMs?: number;
}

export function usePetAgentEvents(options: UsePetAgentEventsOptions): {
  bubble: PetBubbleState | null;
  dismissBubble: () => void;
  /** 气泡点击：有会话意图跳会话，否则仅收起 */
  onBubbleClick: (bubble: PetBubbleState) => void;
} {
  const { subscribe, onMotion, onOpenSession, bubbleMs = 6000 } = options;

  const [bubble, setBubble] = React.useState<PetBubbleState | null>(null);
  const bubbleSeq = React.useRef(0);
  const timerRef = React.useRef<number | undefined>(undefined);

  const dismissBubble = React.useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setBubble(null);
  }, []);

  const onMotionRef = React.useRef(onMotion);
  onMotionRef.current = onMotion;
  const onOpenSessionRef = React.useRef(onOpenSession);
  onOpenSessionRef.current = onOpenSession;
  const bubbleMsRef = React.useRef(bubbleMs);
  bubbleMsRef.current = bubbleMs;

  React.useEffect(() => {
    const armTimer = () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setBubble(null);
      }, bubbleMsRef.current);
    };

    const unsubscribe = subscribe((frame) => {
      const reaction = reactionForAgentEvent(frame.name, frame.data);
      if (!reaction) return;
      onMotionRef.current({ type: reaction.motion, replay: true });
      // 过程性事件（无气泡文案）只切动作，还顺手收掉旧气泡——
      // 比如挂着的"等你审批"在用户批准、agent 继续干活后不该再挂着
      if (reaction.bubble === undefined) {
        dismissBubble();
        return;
      }
      bubbleSeq.current += 1;
      setBubble({
        id: `${frame.occurredAt ?? Date.now()}:${bubbleSeq.current}`,
        text: reaction.bubble,
        actionSessionId: frame.threadId,
      });
      armTimer();
    });

    return () => {
      unsubscribe();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [subscribe, dismissBubble]);

  const handleBubbleClick = React.useCallback(
    (target: PetBubbleState) => {
      if (target.actionSessionId) onOpenSessionRef.current?.(target.actionSessionId);
      dismissBubble();
    },
    [dismissBubble],
  );

  return { bubble, dismissBubble, onBubbleClick: handleBubbleClick };
}
