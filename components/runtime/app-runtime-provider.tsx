"use client";

import { AssistantRuntimeProvider, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { PiTransport } from "@/lib/pi-transport";
import { createPiThreadListAdapter } from "@/lib/pi-thread-adapter";
import { ConnectScreen } from "@/components/remote/connect-screen";
import { RemoteRuntimeProvider } from "@/components/remote/remote-runtime-provider";
import {
  getRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";

/**
 * Tauri 桌面端：pi-agent sidecar 作为会话事实源（RemoteThreadList + 持久化 session 文件）。
 * 远程网页端：经隧道直连桌面端 WS 网关（配对码认证），运行时与桌面同构。
 * 构建目标固定、环境互不切换，按 isTauri/远程拆分组件避免条件 hook。
 */
function TauriRuntimeProvider({ children }: { children: React.ReactNode }) {
  const transport = useMemo(() => new PiTransport(), []);
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

/**
 * 远程分支门卫：读 localStorage 前返回 null（SSR 与首帧一致，避免水合不匹配），
 * 无存档进连接屏，有存档进远程运行时。
 */
function RemoteGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "connect" | "ready">("loading");
  const [config, setConfig] = useState<RemoteConfig | null>(null);

  useEffect(() => {
    const saved = getRemoteConfig();
    if (saved) {
      setConfig(saved);
      setPhase("ready");
    } else {
      setPhase("connect");
    }
  }, []);

  if (phase === "loading") return null;
  if (phase === "connect" || !config) {
    return (
      <ConnectScreen
        onConnected={(cfg) => {
          setConfig(cfg);
          setPhase("ready");
        }}
      />
    );
  }
  return <RemoteRuntimeProvider config={config}>{children}</RemoteRuntimeProvider>;
}

export function AppRuntimeProvider({ children }: { children: React.ReactNode }) {
  // 环境判定推迟到水合完成后：静态导出的预渲染 HTML 无 window（isTauri()=false），
  // 若水合首帧直接按环境分支渲染，桌面端会因 SSR 树（null）与客户端树（完整 UI）不一致
  // 触发 hydration mismatch。首帧恒为 null，水合成功后再切真实分支。
  const [desktop, setDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    setDesktop(isTauri());
  }, []);

  if (desktop === null) return null;
  if (desktop) return <TauriRuntimeProvider>{children}</TauriRuntimeProvider>;
  return <RemoteGate>{children}</RemoteGate>;
}
