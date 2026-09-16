"use client";

import { AssistantRuntimeProvider, useAui, useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { installFrontendLogging } from "@/lib/frontend-logging";
import { initNotifyPipeline } from "@/lib/notify";
import { PiTransport } from "@/lib/pi-transport";
import { piResumableStorage } from "@/lib/pi-resume-storage";
import { hydrateRunningRegistrations } from "@/lib/pi-running";
import { readLastThread, recordLastThread } from "@/lib/pi-last-thread";
import { createPiThreadListAdapter, piSessionCwdMap } from "@/lib/pi-thread-adapter";
import { getWorkspace, setWorkspace } from "@/lib/workspace-store";
import { ConnectScreen } from "@/components/remote/connect-screen";
import { RemoteRuntimeProvider } from "@/components/remote/remote-runtime-provider";
import {
  getRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";
import { createSleepingMate, type MoodMate } from "@/lib/mood-mates";
/** splash 最小展示时长：保证启动动画至少播一会儿，不被快速水合直接闪没。
 *  迭代1b（P6）：3000 → 800——固定 3s 开屏把分块/按需加载的全部启动收益
 *  掩盖在动画里；800ms 仍够云朵呼吸动画起步，观感待重启后重新评估。 */
const SPLASH_MIN_MS = 800;
/** 唤醒动画展示时长：云宝 '01' 序列 0→2100ms（揉眼两下→1400ms 完全睁眼），
 *  1800ms 交棒停在"睡眼全开"的点上，不等它慢慢落回 '02' 待机。 */
const SPLASH_WAKE_MS = 1800;

/**
 * 启动占位屏：随静态导出的预渲染 HTML 直接输出，webview 导航后立即可见，
 * 无需等 JS 水合。窗口 transparent:true 时启动阶段没有实体内容——
 * Windows 全透明区域点击穿透、macOS 看似未启动——占位屏提供可见可点击
 * 的加载反馈，直到运行时就绪。
 *
 * 角色为云宝 Nimbo（Mood Mates 引擎，第三方社区许可，见 public/mood-mates/
 * LICENSE）：水合后异步注入引擎脚本并创建睡眠态（'00'：闭眼、zzz 漂浮、
 * 缓慢呼吸）；ready 后切 '01' 唤醒序列，走完 SPLASH_WAKE_MS 回调 onFinished
 * 由宿主卸载。引擎未加载完成的瞬间占位屏只有纯色底（预渲染 HTML 不含云，
 * 这是换用引擎版角色的代价）；脚本加载失败则不阻塞启动，ready 即直接交棒。
 *
 * 挂载期间在 html 上打 data-boot-splash（globals.css 据此让 body 透明，
 * 露出桌面/窗口材质，仅云朵浮在上面）；卸载时摘除，恢复 body 正常底色。
 * 静态 HTML 已带该标记（layout.tsx），水合后的 effect 重复打标是幂等操作。
 */
function BootSplash({
  ready,
  onFinished,
}: {
  ready: boolean;
  onFinished: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [mate, setMate] = useState<MoodMate | null>(null);
  const [mateFailed, setMateFailed] = useState(false);
  // onFinished 经 ref 调用：宿主多是内联箭头函数，避免其身份变化重启唤醒计时器
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    document.documentElement.dataset.bootSplash = "";
    return () => {
      delete document.documentElement.dataset.bootSplash;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let instance: MoodMate | null = null;
    void createSleepingMate(boxRef.current!)
      .then((m) => {
        if (cancelled) {
          m.destroy();
          return;
        }
        instance = m;
        setMate(m);
      })
      .catch(() => {
        if (!cancelled) setMateFailed(true);
      });
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!ready || (!mate && !mateFailed)) return;
    if (!mate) {
      finishedRef.current();
      return;
    }
    mate.setEmotion("01");
    const timer = setTimeout(() => finishedRef.current(), SPLASH_WAKE_MS);
    return () => clearTimeout(timer);
  }, [ready, mate, mateFailed]);

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center bg-background/95">
      <div ref={boxRef} className="h-[150px] w-[150px]" />
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
    // 顺带记"最近打开的会话"：刷新启动回切的兜底（见 pi-last-thread.ts）
    recordLastThread(item.remoteId);
    const cwd = piSessionCwdMap.get(item.remoteId) ?? null;
    if (getWorkspace() !== cwd) setWorkspace(cwd);
  }, [mainThreadId, threadItems]);

  return null;
}

/**
 * 刷新回切三级：1) "在飞流登记"对应的会话（任务还在跑——框架续流只发生在
 * 主线程，chat 以列表行 id===remoteId===sessionId 认领登记并自动 attach）；
 * 2) 登记缺失（webview 存储被清等）→ 向 sidecar 运行态真相水合（同时重建
 * 登记，续流可 attach）并回其在跑会话；3) 无在跑轮次 → 回"最近打开的会话"，
 * 避免刷新后停在空白新草稿（2026-09-14"刷新后消息没渲染"观感修复）。
 *
 * 先 reload() 等列表就位再 switch：避免走 adapter.fetch 物化出无标题的临时行。
 * 仅启动时执行一次；会话已被删（switch 抛错）静默跳过，不阻塞启动。
 */
function ResumeRunningThread() {
  const aui = useAui();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    void (async () => {
      try {
        // 向 sidecar 运行态真相反填缺登记的在跑轮次（多槽登记；不覆盖已有槽），
        // 续流认领不依赖 sessionStorage 存活
        const turns = await hydrateRunningRegistrations();
        const running = new Set(turns.map((t) => t.sessionId));
        const withSid = piResumableStorage
          .peekEntries()
          .filter((e): e is typeof e & { sessionId: string } => !!e.sessionId);
        // 优先回"确实还在跑"的会话（刷新前最后发起且在飞），其次最近的登记，
        // 最后回"最近打开的会话"
        const target =
          [...withSid].reverse().find((e) => running.has(e.sessionId))?.sessionId ??
          withSid.at(-1)?.sessionId ??
          readLastThread();
        if (!target) return;
        await aui.threads.reload();
        await aui.threads.switchToThread(target);
      } catch {
        // 会话已被删等：静默跳过，不阻塞启动
      }
    })();
  }, [aui]);

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
      <ResumeRunningThread />
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

  // 开屏叙事（睡眠→唤醒→交棒）由 AppRuntimeProvider 层的 BootSplash 统一播完，
  // 到这里只剩读 localStorage 的一帧空档；此分支仅 web 端会走到（桌面端进
  // TauriRuntimeProvider），透明窗口问题不存在，直接空渲染即可——若在这里再挂
  // 一个 BootSplash，云朵会"醒两次"，开屏时长翻倍。
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
  const [splashMinDone, setSplashMinDone] = useState(false);
  // 环境判定 + 最短时长都齐了还不够：云朵还要播完唤醒动画才交棒（进应用）
  const [splashDone, setSplashDone] = useState(false);
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

  // 首帧（含静态导出的预渲染 HTML）恒为睡眠态 BootSplash，与水合后 effect 翻转前的
  // 客户端首帧一致，避免 hydration mismatch；桌面端水合前窗口由此获得实体内容。
  // 环境判定与最短时长都满足后 ready 置真 → 唤醒动画 → splashDone 才真正进应用。
  if (desktop === null || !splashMinDone || !splashDone)
    return (
      <BootSplash
        ready={desktop !== null && splashMinDone}
        onFinished={() => setSplashDone(true)}
      />
    );
  if (desktop) return <TauriRuntimeProvider>{children}</TauriRuntimeProvider>;
  return <RemoteGate>{children}</RemoteGate>;
}
