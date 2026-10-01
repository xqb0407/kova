"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WsPiChannel } from "@/lib/pi/pi-ws-channel";
import { WsPiClient } from "@/lib/pi/pi-runtime/ws-pi-client";
import { usePiRuntime } from "@/lib/pi/pi-runtime";
import { peekPiChannel, setPiChannel, type PiChannelStatus } from "@/lib/pi/pi-channel";
import {
  clearRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";

/**
 * 远程运行时：通过 WsPiChannel 连接用户桌面端网关，react-pi 迁移阶段 5c 起
 * 与桌面端完全同链路——usePiRuntime + PiClient 契约（快照权威 + 原生事件流），
 * 仅客户端实现不同（WsPiClient 走 WebSocket，桌面 TauriPiClient 走 invoke）。
 *
 * 时序约束：setPiChannel 必须先于任何 piRequest 型调用（会话偏好/分支等管理
 * 模块走模块级通道表）——同组件内 effect 按 hook 定义顺序执行，因此注册
 * effect 置于 usePiRuntime 之前。
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

  // 新链路（迁移阶段 5c）：channel 变化即换客户端（旧连接已 close，controller
  // 随 provider 重挂重建）
  const client = useMemo(() => new WsPiClient(channel), [channel]);
  const runtime = usePiRuntime({ client });

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
