"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UIMessageChunk } from "ai";
import type { PiResponse } from "@/lib/pi-bridge";

/**
 * pi-agent 通道抽象：把"管理类请求-响应 + prompt 流式输出 + 全局中断"收口成接口。
 * - TauriPiChannel：桌面端，走 Tauri invoke/event（原 pi-bridge/pi-transport 逻辑平移）
 * - WsPiChannel：远程网页端，走 WebSocket（见 pi-ws-channel.ts）
 *
 * piRequest / createPiThreadListAdapter 通过模块级注册表（setPiChannel/getPiChannel）
 * 与具体通道解耦：运行时 provider 挂载前 set，之后所有调用原样工作在任一通道上。
 */

export type PromptStreamArgs = {
  /** 调用方生成（pi-${uuid}），sidecar 按 id 回发 chunk */
  requestId: string;
  text: string;
  threadId: string;
  sessionId?: string | null;
  cwd?: string | null;
  abortSignal?: AbortSignal;
};

export type PiChannelStatus = {
  connected: boolean;
  error?: string;
};

export interface PiChannel {
  readonly kind: "tauri" | "ws";
  /** 管理类请求-响应；id 注入由实现负责（Tauri 侧 Rust 注入，WS 侧 JS 注入） */
  request(payload: Record<string, unknown>, timeoutMs?: number): Promise<PiResponse>;
  /** 发起 prompt，返回按 requestId 分流的 chunk 流（finish/error 关流） */
  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk>;
  /** 全局中断（sidecar 侧 abort 无 id，作用于当前正在跑的 prompt） */
  abort(): Promise<void>;
  close?(): void;
  /** WS 通道连接状态回调；Tauri 通道恒连接，可不实现 */
  onStatusChange?(cb: (s: PiChannelStatus) => void): () => void;
}

// ---------- 模块级注册表 ----------

let current: PiChannel | null = null;

export function setPiChannel(ch: PiChannel | null) {
  current = ch;
}

export function getPiChannel(): PiChannel {
  // 兜底：未注册时惰性创建 Tauri 通道（保持桌面端现网行为）
  return (current ??= new TauriPiChannel());
}

// ---------- Tauri 通道 ----------

export class TauriPiChannel implements PiChannel {
  readonly kind = "tauri" as const;

  async request(
    payload: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<PiResponse> {
    const invokePromise = invoke<string>("pi_request", { payload }).then(
      (line) => JSON.parse(line) as PiResponse,
    );
    return Promise.race([
      invokePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pi-agent request timed out")), timeoutMs),
      ),
    ]);
  }

  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk> {
    const { requestId, text, threadId, sessionId, cwd, abortSignal } = args;

    let unlisten: UnlistenFn | null = null;
    const cleanup = () => {
      unlisten?.();
      unlisten = null;
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        // 先挂监听再发起 prompt，避免漏掉最早的 chunk
        unlisten = await listen<string>("pi-chunk", (event) => {
          let parsed: { id?: string | null; chunk?: UIMessageChunk };
          try {
            parsed = JSON.parse(event.payload);
          } catch {
            return;
          }
          if (parsed.id !== requestId || !parsed.chunk) return;
          controller.enqueue(parsed.chunk);
          if (parsed.chunk.type === "finish" || parsed.chunk.type === "error") {
            cleanup();
            controller.close();
          }
        });

        try {
          await invoke("pi_prompt", {
            requestId,
            text,
            threadId,
            sessionId,
            cwd,
          });
        } catch (err) {
          controller.enqueue({
            type: "error",
            errorText: err instanceof Error ? err.message : String(err),
          } as UIMessageChunk);
          cleanup();
          controller.close();
        }
      },
      cancel() {
        cleanup();
      },
    });

    abortSignal?.addEventListener(
      "abort",
      () => {
        void invoke("pi_abort").catch(() => {});
      },
      { once: true },
    );

    return stream;
  }

  async abort() {
    await invoke("pi_abort").catch(() => {});
  }
}
