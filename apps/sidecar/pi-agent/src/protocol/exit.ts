/**
 * 进程退出状态机：stdin 关闭（父进程写完）不等于任务处理完毕，
 * 等挂起请求清零再冲刷 stdout 退出（顺带断开全部 MCP 连接防孤儿进程）。
 * handleLine 经 beginOp/endOp 计数在飞请求；shutdown 命令置关闭标记，
 * 由该命令自身的 handleLine finally 触发收尾。
 */
import { mcpManager } from "../mcp/mcp-manager";

let stdinClosed = false;
let pendingOps = 0;
let exiting = false;

function maybeExit() {
  if (exiting || !stdinClosed || pendingOps > 0) return;
  exiting = true;
  // 退出前断开全部 MCP 连接（stdio 子进程随 SDK close 收尾，避免孤儿进程）
  mcpManager.disposeAll();
  // end() 会先冲刷 stdout 队列再退出，避免超长响应行被截断
  process.stdout.end(() => process.exit(0));
}

/** 入口在 stdin 关闭时调用（readline close 事件） */
export function markStdinClosed() {
  stdinClosed = true;
  maybeExit();
}

export function beginOp(): void {
  pendingOps += 1;
}

export function endOp(): void {
  pendingOps -= 1;
  maybeExit();
}

/** shutdown 命令置位：本命令的 handleLine finally 会经 endOp → maybeExit 收尾 */
export function markStdinClosedForShutdown(): void {
  stdinClosed = true;
}
