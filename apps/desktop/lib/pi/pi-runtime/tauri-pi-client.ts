"use client";

/**
 * TauriPiClient：PiClient 契约的桌面端实现（react-pi 迁移阶段 2+3，阶段 5c
 * 起为 PiClientBase 的 Tauri 薄适配——传输依赖注入：invoke/event）。
 *
 * - 管理类方法走 piRequest 通道（invoke pi_request，管理队列串行）；
 * - sendMessage 复用现有 pi_prompt（带 sessionId 定靶），不消费 AI SDK chunk 流；
 * - subscribe 经基座共享逻辑：监听 pi-chunk-batch 里的原始行（sidecar delta 化
 *   原生事件 + data-* 旁路 + finish/error 收尾帧），pi-exit 即事件源换代。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { piRequest, type PiResponse } from "@/lib/pi/pi-bridge";
import { PiClientBase, type PiClientTransport } from "./pi-client-base";
import type { TurnCheckpointObserver } from "./turn-checkpoints";

/** pi-chunk-batch 载荷的一行（镜像 pi_agent.rs ChunkLine，pi-channel 未导出） */
type WireLine = { i: number | null; l: string };

const tauriTransport: PiClientTransport = {
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
};

export class TauriPiClient extends PiClientBase {
  constructor(checkpoints?: TurnCheckpointObserver) {
    super(tauriTransport, checkpoints);
  }
}
