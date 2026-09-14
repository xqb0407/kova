"use client";

import { AssistantRuntimeProvider, useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { installFrontendLogging } from "@/lib/frontend-logging";
import { initNotifyPipeline } from "@/lib/notify";
import { PiTransport } from "@/lib/pi-transport";
import { createPiThreadListAdapter, piSessionCwdMap } from "@/lib/pi-thread-adapter";
import { getWorkspace, setWorkspace } from "@/lib/workspace-store";
import { ConnectScreen } from "@/components/remote/connect-screen";
import { RemoteRuntimeProvider } from "@/components/remote/remote-runtime-provider";
import {
  getRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";
import { WanderingEyes } from "../loading-ui/wandering-eyes";
/** splash 最小展示时长：保证启动动画至少播一会儿，不被快速水合直接闪没。
 *  迭代1b（P6）：3000 → 800——固定 3s 开屏把分块/按需加载的全部启动收益
 *  掩盖在动画里；800ms 仍够眼睛动画起步，观感待重启后重新评估。 */
const SPLASH_MIN_MS = 800;

/**
 * 启动占位屏：随静态导出的预渲染 HTML 直接输出，webview 导航后立即可见，
 * 无需等 JS 水合。窗口 transparent:true 时启动阶段没有实体内容——
 * Windows 全透明区域点击穿透、macOS 看似未启动——占位屏提供可见可点击
 * 的加载反馈，直到运行时就绪。
 *
 * 挂载期间在 html 上打 data-boot-splash（globals.css 据此让 body 透明，
 * 露出桌面/窗口材质，仅眼睛浮在上面）；卸载时摘除，恢复 body 正常底色。
 * 静态 HTML 已带该标记（layout.tsx），水合后的 effect 重复打标是幂等操作。
 */
function BootSplash() {
  useEffect(() => {
    document.documentElement.dataset.bootSplash = "";
    return () => {
      delete document.documentElement.dataset.bootSplash;
    };
  }, []);

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-background/95 text-muted-foreground">
      <WanderingEyes className="h-12 w-[108px]" />
    </div>
  );
}

/**
 * 全局 workspace 跟随当前会话：左侧列表切到某个已落盘会话时，把
 * workspace-store 同步到该会话记录的 cwd（无 cwd 的任务会话则清空），
 * 让 Git 面板/审查/检查点条读到的都是"这个对话的工作目录"。
 * 未发送首条消息的新会话（无 remoteId）不同步——保留用户刚在胶囊里选的目录。
 */
function WorkspaceThreadSync() {
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  useEffect(() => {
    const item = threadItems.find((t) => t.id === mainThreadId);
    if (!item?.remoteId) return;
    const cwd = piSessionCwdMap.get(item.remoteId) ?? null;
    if (getWorkspace() !== cwd) setWorkspace(cwd);
  }, [mainThreadId, threadItems]);

  return null;
}

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
      <WorkspaceThreadSync />
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

  if (phase === "loading") return <BootSplash />;
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
  const [splashMinDone, setSplashMinDone] = useState(false);
  const splashStartRef = useRef(Date.now());

  useEffect(() => {
    setDesktop(isTauri());
    // 桌面端挂载 console.warn/error 与崩溃转发（写 web.log，内部自判环境）
    installFrontendLogging();
    // 通知管线：事件总线 → 提示音 + webhook 派发（幂等，桌面/远程网页都装配）
    initNotifyPipeline();
    const remain = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStartRef.current));
    const timer = setTimeout(() => setSplashMinDone(true), remain);
    return () => clearTimeout(timer);
  }, []);

  // 首帧（含静态导出的预渲染 HTML）恒为 BootSplash，与水合后 effect 翻转前的
  // 客户端首帧一致，避免 hydration mismatch；桌面端水合前窗口由此获得实体内容。
  if (desktop === null || !splashMinDone) return <BootSplash />;
  if (desktop) return <TauriRuntimeProvider>{children}</TauriRuntimeProvider>;
  return <RemoteGate>{children}</RemoteGate>;
}
