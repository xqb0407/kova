"use client";

/**
 * 共享 PiClient 上下文。
 *
 * 主会话的 AssistantRuntimeProvider 内部创建了 DesktopPiClient / WsPiClient；
 * 辅助会话 tab 需要在同一进程/连接上再挂一个嵌套 runtime（不同 threadId），
 * 因此把 client 经 context 下发给副屏视图，避免第二份连接或第二套传输。
 */

import { createContext, useContext, type ReactNode } from "react";
import type { PiClient } from "@/lib/pi/pi-runtime/types";

const PiClientContext = createContext<PiClient | null>(null);

export function PiClientProvider({
  client,
  children,
}: {
  client: PiClient;
  children: ReactNode;
}) {
  return (
    <PiClientContext.Provider value={client}>{children}</PiClientContext.Provider>
  );
}

/** 主 runtime 内部为 null；副屏视图拿到共享 client 后才挂嵌套 runtime */
export function usePiClient(): PiClient | null {
  return useContext(PiClientContext);
}
