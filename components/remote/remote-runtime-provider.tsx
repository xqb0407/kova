"use client";

import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WsPiChannel } from "@/lib/pi-ws-channel";
import { setPiChannel, type PiChannelStatus } from "@/lib/pi-channel";
import { PiTransport } from "@/lib/pi-transport";
import { createPiThreadListAdapter } from "@/lib/pi-thread-adapter";
import {
  clearRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";

/**
 * 远程运行时：通过 WsPiChannel 连接用户桌面端网关，
 * 与桌面 TauriRuntimeProvider 完全同构（RemoteThreadList + pi 会话事实源），仅通道不同。
 *
 * 时序约束：setPiChannel 必须先于 useRemoteThreadListRuntime（其 adapter 的
 * list/initialize 等可能即时触发），因此通道创建放在 useMemo 并置于 hooks 顶部。
 */
export function RemoteRuntimeProvider({
  config,
  children,
}: {
  config: RemoteConfig;
  children: React.ReactNode;
}) {
  const prevChannelRef = useRef<WsPiChannel | null>(null);
  const channel = useMemo(() => {
    // StrictMode 下 memo 工厂会执行两次：先关闭前一个，避免孤儿连接
    prevChannelRef.current?.close();
    const c = new WsPiChannel(config.url, config.token);
    setPiChannel(c);
    prevChannelRef.current = c;
    return c;
  }, [config.url, config.token]);
  useEffect(() => {
    return () => {
      prevChannelRef.current?.close();
      prevChannelRef.current = null;
      setPiChannel(null);
    };
  }, []);

  const [status, setStatus] = useState<PiChannelStatus>({ connected: false });
  useEffect(() => {
    return channel.onStatusChange?.(setStatus);
  }, [channel]);

  const transport = useMemo(() => new PiTransport(), []);
  const adapter = useMemo(() => createPiThreadListAdapter(), []);

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useChatRuntime({ transport }),
    adapter,
  });

  const disconnected =
    typeof status.error === "string" && status.error !== "reconnecting...";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {disconnected && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-destructive px-4 py-2 text-sm text-destructive-foreground">
          <span>与桌面端的连接已断开（{status.error}）</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 bg-transparent text-inherit"
            onClick={() => window.location.reload()}
          >
            重试
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 bg-transparent text-inherit"
            onClick={() => {
              channel.close();
              clearRemoteConfig();
              window.location.reload();
            }}
          >
            重新配对
          </Button>
        </div>
      )}
      {children}
    </AssistantRuntimeProvider>
  );
}
