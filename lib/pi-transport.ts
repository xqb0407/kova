"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { getPiChannel } from "@/lib/pi-channel";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * pi-agent 的 ChatTransport：把 assistant-ui 的 sendMessages 请求转为
 * 当前 PiChannel（桌面 Tauri invoke / 远程 WebSocket）上的 prompt 流。
 *
 * 事件链路（桌面）：promptStream → invoke("pi_prompt") → 子进程 stdin → stdout 行
 *   → Rust 转发 "pi-chunk" 事件 → TauriPiChannel 按 requestId 过滤为 UIMessageChunk。
 * 事件链路（远程）：promptStream → WS {"type":"prompt"} → 网关 → sidecar →
 *   网关按 id 路由回本连接 → WsPiChannel 分流为 UIMessageChunk。
 */
export class PiTransport implements ChatTransport<UIMessage> {
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

    return getPiChannel().promptStream({
      requestId,
      text,
      threadId: chatId,
      sessionId,
      cwd: getWorkspace() ?? undefined,
      abortSignal,
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // sidecar 场景没有可恢复的 HTTP 流
    return null;
  }
}
