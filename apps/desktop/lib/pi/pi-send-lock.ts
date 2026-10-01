"use client";

import { useAuiState } from "@assistant-ui/react";
import { usePiQueue } from "@/lib/pi/pi-runtime";

/**
 * 发送锁：消息尚未全部送达（本轮在跑流式生成、或队列里还有待派发的排队项）
 * 时禁止改模型/思考档位。sidecar 的 set_model 与 set_thinking 都会即时广播到
 * 驻留会话（直接改 run.agent.state），进行中/排队中的消息会被换成新配置应答，
 * 与发送时刻的选择相违；队列清空且本轮收尾后自动解锁。
 * 模型选择器（model-picker）与思考档位选择器（thinking-picker）共用。
 */
export function useSendLock(): boolean {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { queue } = usePiQueue();
  return isRunning || queue.steering.length > 0 || queue.followUp.length > 0;
}
