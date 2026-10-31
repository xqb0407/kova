import { PROMPT_QUEUE_LIMIT } from "pi-protocol";
import { toast } from "@/components/ui/toast";

/**
 * 发送前队列容量守卫（v3.1）：此刻发送会进排队车道（线程忙或队列非空）且
 * 排队条已满（PROMPT_QUEUE_LIMIT）时拦下并提示。不拦的话 sidecar 会以
 * QUEUE_LIMIT error chunk 静默拒绝——错误文本在新链路无呈现面（排队消息没有
 * 气泡可挂错误卡），而发送动作已清空草稿，等于无声丢一条消息（2026-10-31
 * 用户反馈定稿为发送前拦截）。
 *
 * 返回 true = 已拦截，调用方不要再 send（草稿保留）。
 * steer 车道（并入活跃轮）不占队列，调用方不要对 steer 发送套这个守卫；
 * 空闲 + 队列非空的孤儿场景由接力泵自愈派发，满队列存活窗口极短，不做拦截。
 */
export function queueSendBlocked(
  willQueueSend: boolean,
  queuedCount: number,
): boolean {
  return willQueueSend && queuedCount >= PROMPT_QUEUE_LIMIT;
}

/** 带提示的完整守卫：命中即 toast 并返回 true（调用方不要再 send） */
export function blockSendIfQueueFull(
  willQueueSend: boolean,
  queuedCount: number,
): boolean {
  const blocked = queueSendBlocked(willQueueSend, queuedCount);
  if (blocked) {
    toast.error(
      `排队消息已达上限（${PROMPT_QUEUE_LIMIT} 条），请等当前回复完成，或先清理/暂停排队条`,
    );
  }
  return blocked;
}
