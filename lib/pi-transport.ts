"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * 通过 Tauri command/event 与 Rust 侧 pi-agent sidecar 通信的 ChatTransport。
 * 事件链路：invoke("pi_prompt") → 子进程 stdin → stdout 行 → Rust 转发 "pi-chunk" 事件 → 这里解析为 UIMessageChunk。
 * 每行形如 { "id": "<requestId>", "chunk": { ...UIMessageChunk } }，按 requestId 过滤。
 */
export class TauriPiTransport implements ChatTransport<UIMessage> {
  async sendMessages({
    chatId,
    messages,
    abortSignal,
  }: {
    chatId: string;
    messages: UIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = `pi-${crypto.randomUUID()}`;
    // 取最后一条用户消息的文本（regenerate 场景同样复用最后一条用户输入）
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text =
      lastUser?.parts
        .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n") ?? "";

    // chatId 是 runtime 内部 thread id；registry 里存着它对应的 pi session 文件路径
    // （重启后点击历史会话时也由 adapter 的 unstable_useAdapters 补齐映射）
    const sessionId = piSessionRegistry.get(chatId);

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
            threadId: chatId,
            sessionId,
            cwd: getWorkspace() ?? undefined,
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

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // sidecar 场景没有可恢复的 HTTP 流
    return null;
  }
}
