"use client";

import { AssistantRuntimeProvider, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { useMemo } from "react";
import { isTauri } from "@/lib/tauri";
import { TauriPiTransport } from "@/lib/pi-transport";
import { createPiThreadListAdapter } from "@/lib/pi-thread-adapter";

/**
 * Tauri 桌面端：pi-agent sidecar 作为会话事实源（RemoteThreadList + 持久化 session 文件）。
 * 浏览器 dev：沿用 /api/chat + 内存线程列表。
 * 两个环境互不切换（构建目标固定），因此按 isTauri 拆成两个组件避免条件 hook。
 */
function TauriRuntimeProvider({ children }: { children: React.ReactNode }) {
  const transport = useMemo(() => new TauriPiTransport(), []);
  const adapter = useMemo(() => createPiThreadListAdapter(), []);

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useChatRuntime({ transport }),
    adapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function WebRuntimeProvider({ children }: { children: React.ReactNode }) {
  const transport = useMemo(
    () => new AssistantChatTransport({ api: "/api/chat" }),
    [],
  );
  const runtime = useChatRuntime({ transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export function DemoRuntimeProvider({ children }: { children: React.ReactNode }) {
  if (isTauri()) return <TauriRuntimeProvider>{children}</TauriRuntimeProvider>;
  return <WebRuntimeProvider>{children}</WebRuntimeProvider>;
}
