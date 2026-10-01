/**
 * steer 意图标记（composer → transport 的单跳信号，「并入当前轮」用）：
 * assistant-ui 的 SendOptions.steer 在 AI SDK 链路不透传（useAISDKRuntime 无
 * queue/steer 消费），transport.sendMessages 也收不到 send options，所以走
 * 模块级标记：发送前 mark（⌥点击 / Shift+⌘+Enter，仅运行中），transport
 * sendMessages 时 consume 并随 prompt 协议帧带 steer 字段给 sidecar。
 *
 * 标记一次性（消费即清除，只影响下一次发送）；两处调用点都有 canSend/
 * isRunning 守卫，标记悬空（标了没发出去）的窗口被压到最小。
 */
const pending = new Set<string>();

/** 标记该线程的下一次发送为「并入当前轮」（仅运行中调用） */
export function markSteerNextSend(chatId: string): void {
  pending.add(chatId);
}

/** transport 消费：该线程下一次发送是否带 steer 标记（取走即清） */
export function consumeSteerIntent(chatId: string): boolean {
  const has = pending.delete(chatId);
  return has;
}

/** 只读窥探（不移除）：入队预期 gate 用——键盘 steer 发送已标记时跳过 gate，
 *  避免本该即时显示的并入消息被守门隐藏 */
export function peekSteerIntent(chatId: string): boolean {
  return pending.has(chatId);
}
