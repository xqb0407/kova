"use client";

import { useAuiState } from "@assistant-ui/react";
import { usePiQueue } from "@/lib/pi/pi-runtime";

/**
 * 发送锁：消息尚未全部送达（本轮在跑流式生成、或队列里还有待派发的排队项）
 * 时禁止改模型/思考档位。sidecar 的定靶 set_model / set_thinking 会即时改写
 * 被点名 run 的 state，进行中/排队中的消息会被换成新配置应答，
 * 与发送时刻的选择相违；队列清空且本轮收尾后自动解锁。
 * 模型选择器（model-picker，含并入面板的思考强度）共用。
 *
 * 暂停中的队列不在锁内（stopped/manual）：暂停 = 没有「即将以此配置派发」
 * 的语义，恢复接棒用的是恢复时刻的会话配置——切模型正是「上一个模型不可用、
 * 队列派发不出去」死结的钥匙，锁着它 = 只能逐条删队列才能换模型。
 * isRunning 仍锁：轮在跑时暂停位可能是 Stop 收尾的残留瞬间，set_model 会
 * 改写下一轮的应答配置。
 */
export function useSendLock(): boolean {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { queue } = usePiQueue();
  if (isRunning) return true;
  if (queue.paused) return false;
  return queue.steering.length > 0 || queue.followUp.length > 0;
}
