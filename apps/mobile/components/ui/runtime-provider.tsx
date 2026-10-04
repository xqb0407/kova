import { AssistantRuntimeProvider } from "@assistant-ui/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { WsPiChannel } from "@/lib/pi/pi-ws-channel";
import { WsPiClient } from "@/lib/pi/pi-runtime/ws-pi-client";
import { usePiRuntime } from "@/lib/pi/pi-runtime";
import {
  setPiChannel,
  type PiChannel,
  type PiChannelStatus,
} from "@/lib/pi/pi-channel";
import { MockPiClient } from "@/lib/pi/mock/mock-transport";
import { Banner } from "./banner";
import type { RemoteConfig } from "@/lib/mobile/secure-store";

/**
 * 远程运行时：与桌面端「远程访问」网页端同链路——WsPiChannel 连网关，
 * WsPiClient 实现 PiClient 契约，usePiRuntime 挂外部 store。
 * 手机端没有任何 capability 降级：网关对聊天命令（prompt / abort / 工具审批 /
 * 提问 / 队列 / 模型与思考档位切换）全放行，只有凭据、MCP、skills、subagents、
 * memory、automation 的写操作在 remote.rs 的 REMOTE_DENIED_TYPES 里被拒。
 *
 * Mock 演示模式（url 是 mock: scheme）：不建 WS 通道，客户端换 MockPiClient
 * （脚本化流式/排队/中断）；模块级通道表注册的是同一 transport 的适配器，
 * 模型与思考档位选择等管理模块照常有应答。断线横幅/重新配对在 mock 里不触发。
 *
 * 时序约束：setPiChannel 必须先于任何 piRequest 型调用（会话偏好、分支等管理
 * 模块走模块级通道表）。同组件内 effect 按定义顺序执行，所以注册 effect 排在
 * usePiRuntime 之前——这个顺序不能调换。
 *
 * 通道惰性建在 ref 里而非 useMemo：StrictMode 双渲染时 React 提交的是第一次
 * 的结果，"第二次工厂里 close 上一个"会杀掉真正保留的连接。
 */
export function RuntimeProvider({
  config,
  onFatal,
  children,
}: {
  config: RemoteConfig;
  /** 认证失效一类不可自愈的错误：交回上层重新配对 */
  onFatal: (reason: string) => void;
  children: ReactNode;
}) {
  const mock = config.url.startsWith("mock:");

  const chRef = useRef<{ key: string; ch: WsPiChannel } | null>(null);
  const key = `${config.url}|${config.token}`;
  if (!mock && chRef.current?.key !== key) {
    chRef.current?.ch.close();
    chRef.current = { key, ch: new WsPiChannel(config.url, config.token) };
  }
  const channel = chRef.current?.ch;

  const client = useMemo(
    () =>
      mock
        ? new MockPiClient()
        : new WsPiClient(channel!),
    [mock, channel],
  );

  // 模块级通道表的入口：真连接用 WS 通道；mock 用同一 transport 的适配器
  // （PiClientBase 的管理请求与 piRequest 型模块共享一套会话状态）
  const tableChannel: PiChannel | null = mock
    ? client instanceof MockPiClient
      ? client.channel
      : null
    : (channel ?? null);

  // 注册进模块级通道表放在 effect setup。StrictMode 的 setup→cleanup→setup
  // 重放会误杀真连接：cleanup 只调度销毁，紧接着的 setup 取消它；真实卸载才销毁。
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!tableChannel) return;
    if (destroyTimer.current) {
      clearTimeout(destroyTimer.current);
      destroyTimer.current = null;
    }
    setPiChannel(tableChannel);
    return () => {
      destroyTimer.current = setTimeout(() => {
        destroyTimer.current = null;
        tableChannel.close?.();
      }, 250);
    };
  }, [tableChannel]);

  const [status, setStatus] = useState<PiChannelStatus>({ connected: mock });
  useEffect(() => {
    if (!channel) return;
    return channel.onStatusChange(setStatus);
  }, [channel]);

  // 回前台立刻给一次连接机会（并清零退避计数）：移动系统会回收后台套接字，
  // 而网关既无应用层心跳也无 authed 后的空闲超时，半开连接要等下一次写失败
  // 才暴露——不主动探测，用户会在"看起来还连着"的界面上白等一轮超时
  useEffect(() => {
    if (!channel) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") channel.reconnectNow();
    });
    return () => sub.remove();
  }, [channel]);

  // 认证失败：token 失效或被吊销，重连无意义，退回配对屏
  useEffect(() => {
    if (mock) return;
    const text = status.error ?? "";
    if (/unauthorized|auth|token|invalid/i.test(text) && !status.connected) {
      onFatal(text);
    }
  }, [status, onFatal, mock]);

  const runtime = usePiRuntime({
    client,
    onError: (error) => {
      // 运行期错误由各处的横幅/卡片呈现，这里只留痕，不打断
      console.error("[pi-runtime]", error);
    },
  });

  const error = status.error;
  // "reconnecting..." 是通道自己在重连，横幅不打扰；其余是真断了
  const disconnected = typeof error === "string" && error !== "reconnecting...";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {mock ? (
        // 演示模式必须常驻标注：本地脚本化回复与真桌面端回复在 UI 上同形，
        // 不打标识用户会以为已经连上了自己的桌面端（决策：mock 保留但不得
        // 掩盖真实连接状态，也不参与断链/重连判定）
        <Banner text="演示数据：未连接桌面端，回复来自本地脚本" />
      ) : null}
      {disconnected ? (
        <Banner
          tone="danger"
          text={`与桌面端的连接已断开（${error}）`}
          action={{ label: "重新配对", onPress: () => onFatal(error) }}
        />
      ) : null}
      {children}
    </AssistantRuntimeProvider>
  );
}
