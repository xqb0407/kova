"use client";

import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WsPiChannel } from "@/lib/pi-ws-channel";
import { peekPiChannel, setPiChannel, type PiChannelStatus } from "@/lib/pi-channel";
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
 * 时序约束：setPiChannel 必须先于 useRemoteThreadListRuntime 触发其 adapter 的
 * list/initialize——同组件内 effect 按 hook 定义顺序执行，因此注册 effect 置于该
 * hook 之前。
 * StrictMode 注意：useMemo 工厂双跑时 React 提交的是第一次结果，"第二次工厂里
 * close 上一个"会杀掉真正保留的连接；改用惰性 useRef 使双跑幂等。
 */
export function RemoteRuntimeProvider({
  config,
  children,
}: {
  config: RemoteConfig;
  children: React.ReactNode;
}) {
  // 渲染期惰性创建（ref 有则复用）：StrictMode 双渲染只建一条连接；
  // config（url/token）变化时旧通道即时关闭，换新。
  const chRef = useRef<{ key: string; ch: WsPiChannel } | null>(null);
  const key = `${config.url}|${config.token}`;
  if (chRef.current?.key !== key) {
    chRef.current?.ch.close();
    chRef.current = { key, ch: new WsPiChannel(config.url, config.token) };
  }
  const channel = chRef.current.ch;
  // 注册进模块级通道表放在 effect setup。StrictMode 的 setup→cleanup→setup 重放
  // 会误杀真连接：cleanup 只调度销毁，紧接着的 setup 取消它并重新注册；
  // 真实卸载才会销毁。销毁前再确认注册表仍指向本通道，避免误伤已接管的新实例。
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (destroyTimer.current) {
      clearTimeout(destroyTimer.current);
      destroyTimer.current = null;
    }
    setPiChannel(channel);
    return () => {
      destroyTimer.current = setTimeout(() => {
        destroyTimer.current = null;
        channel.close();
        if (peekPiChannel() === channel) setPiChannel(null);
      }, 250);
    };
  }, [channel]);

  const [status, setStatus] = useState<PiChannelStatus>({ connected: false });
  useEffect(() => {
    return channel.onStatusChange?.(setStatus);
  }, [channel]);

  const transport = useMemo(() => new PiTransport(), []);
  const adapter = useMemo(() => createPiThreadListAdapter(), []);

  // joinStrategy "none"：多任务排队时 user 消息先入列、assistant 回复按序后补，
  // 相邻 assistant 消息默认会被转换层合并成一条——禁用 join，每轮回复独立成条
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useChatRuntime({ transport, joinStrategy: "none" }),
    adapter,
  });

  const disconnected =
    typeof status.error === "string" && status.error !== "reconnecting...";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {disconnected && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-destructive/10 px-4 py-2 text-sm text-destructive-foreground">
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
