/**
 * IM 会话线程键（由 apps/electron/main/im/router.ts 生成）：`im:<sessionId>`。
 *
 * 这类会话由 IM 消息驱动，没有桌面交互面：
 * - Question 工具无处作答（卡片要桌面 composer 才能渲染）——工具表里不注入，
 *   execute 里也兜一层，绝不挂起；
 * - 逐工具审批卡同样无处点击——主进程 router 把审批请求转成 IM 文本消息，
 *   用户在聊天里回复「允许/拒绝」后经 tool_confirm 结算（见 router 的
 *   data-toolApproval 分支），所以审批链本身保持原样等待。
 *
 * 桌面端打开同一个会话时 threadId 就是 sessionId（不以 im: 开头），工具与
 * 交互面照常可用——无人值守判定只认「当前是谁在驱动这一轮」。
 */
export function isImThread(threadId: string): boolean {
  return threadId.startsWith("im:");
}
