/**
 * 命令分发的基础原语：CommandHandler 签名与协议层序号发生器。
 * 领域 handler 模块见 handlers/，串行队列见 mgmt-queue.ts。
 */

/** 管理命令处理器：reqId 用于应答帧回填，msg 为原始命令行（字段按命令自取） */
export type CommandHandler = (
  reqId: string,
  msg: Record<string, unknown>,
) => Promise<void>;

let fallbackSeq = 0;

/** 协议层序号：请求缺 id 时的兜底 reqId、插件耗时操作的 opId 共用（进程内唯一） */
export function nextFallbackSeq(): number {
  return fallbackSeq++;
}
