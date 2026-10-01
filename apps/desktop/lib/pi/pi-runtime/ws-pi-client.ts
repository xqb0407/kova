"use client";

/**
 * WsPiClient：PiClient 契约的远程网页端实现（react-pi 迁移阶段 5c）。
 *
 * 复用 PiClientBase 全部传输无关逻辑（快照权威 + delta 重建 + data-* 旁路
 * 分流 + 完成提醒 + 检查点卡），传输走 WsPiChannel：
 * - 管理类 request（id 注入 + 15s 超时，error 应答归一为异常）；
 * - prompt 帧直发（sendPromptFrame，chunk/thread_event 行经 onRawLine 回流）；
 * - 中断走通道 abort（{type:"abort", threadId}）；
 * - 事件源换代 = 连接断开（路由全灭，清流式台账）+ 重连 authed（重拉快照自愈）。
 *
 * 线程身份 = pi sessionId（与桌面新链路一致）：sendMessage 的 threadId 即
 * sessionId，sidecar running 键两端同键。
 */
import type { PiResponse } from "@/lib/pi/pi-bridge";
import type { WsPiChannel } from "@/lib/pi/pi-ws-channel";
import { PiClientBase, type PiClientTransport } from "./pi-client-base";
import type { TurnCheckpointObserver } from "./turn-checkpoints";

export class WsPiClient extends PiClientBase {
  constructor(channel: WsPiChannel, checkpoints?: TurnCheckpointObserver) {
    const transport: PiClientTransport = {
      request: async <T extends PiResponse>(
        payload: Record<string, unknown>,
        timeoutMs?: number,
      ) => {
        const res = await channel.request(payload, timeoutMs);
        if (res.type === "error") throw new Error(res.errorText);
        return res as T;
      },

      sendPrompt: (args) => {
        // 无连接且未入队：按发送失败处理（基座回滚 inflight 台账并向上抛）
        if (!channel.sendPromptFrame(args)) {
          return Promise.reject(new Error("not connected"));
        }
        return Promise.resolve();
      },

      abort: (threadId) => channel.abort(threadId),

      watchLines: async (cb) => channel.onRawLine(cb),

      watchGeneration: async (cb) => {
        const offClose = channel.onDisconnected(cb);
        const offAuthed = channel.onAuthed(cb);
        return () => {
          offClose();
          offAuthed();
        };
      },
    };
    super(transport, checkpoints);
  }
}
