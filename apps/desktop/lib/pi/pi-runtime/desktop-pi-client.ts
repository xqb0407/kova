"use client";

/**
 * DesktopPiClient：PiClient 契约的桌面端实现（react-pi 迁移阶段 2+3，阶段 5c
 * 起为 PiClientBase 的 桌面壳 薄适配——传输依赖注入：invoke/event）。
 *
 * - 管理类方法走 piRequest 通道（invoke pi_request，管理队列串行）；
 * - sendMessage 复用现有 pi_prompt（带 sessionId 定靶），不消费 AI SDK chunk 流；
 * - subscribe 经基座共享逻辑：监听 pi-chunk-batch 里的原始行（sidecar delta 化
 *   原生事件 + data-* 旁路 + finish/error 收尾帧），pi-exit 即事件源换代。
 */
import { invoke } from "@/desktop-bridge/core";
import { listen } from "@/desktop-bridge/event";
import { piRequest, type PiResponse } from "@/lib/pi/pi-bridge";
import { PiClientBase, type PiClientTransport } from "./pi-client-base";
import type { TurnCheckpointObserver } from "./turn-checkpoints";

/** pi-chunk-batch 载荷的一行（镜像 pi_agent.rs ChunkLine，pi-channel 未导出） */
type WireLine = { i: number | null; l: string };

const desktopTransport: PiClientTransport = {
  request: <T extends PiResponse>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => piRequest<T>(payload, timeoutMs),

  sendPrompt: async (args) => {
    await invoke("pi_prompt", {
      requestId: args.requestId,
      text: args.text,
      // running 键统一用 sessionId：abort/steer/队列按同键命中
      threadId: args.threadId,
      sessionId: args.threadId,
      cwd: args.cwd,
      attachments: args.attachments,
      steer: args.steer,
      goalMaxAutoTurns: args.goalMaxAutoTurns ?? null,
    });
  },

  abort: (threadId) => invoke("pi_abort", { threadId }),

  watchLines: async (cb) =>
    listen<WireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) cb(wire.l);
    }),

  watchGeneration: async (cb) => listen<string>("pi-exit", () => cb()),

  // 观看集合上报：主进程只会把该集合内会话的逐 token 增量送到本窗口，
  // 多会话并发时后台会话的 message_update 不再跨进程
  watchSessions: (sessionIds) => {
    // 裁剪是纯优化：命令失败时主进程沿用上一次的观看集合（不是退回全量），
    // 本次新增订阅的会话在下次上报成功前收不到逐 token 增量；收尾帧不是
    // heavy，最终内容仍由快照补齐。实际只在发送方窗口销毁时才会失败，故不重试。
    invoke("pi_watch_sessions", { sessions: sessionIds }).catch(() => undefined);
  },
};

export class DesktopPiClient extends PiClientBase {
  constructor(checkpoints?: TurnCheckpointObserver) {
    super(desktopTransport, checkpoints);
  }
}
