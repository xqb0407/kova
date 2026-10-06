"use client";

import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { installFrontendLogging } from "@/lib/frontend-logging";
import { primeAppMeta } from "@/lib/app-meta";
import { installPerfWatch, uninstallPerfWatch } from "@/lib/perf-watch";
import { toast } from "@/components/ui/toast";
import { initNotifyPipeline } from "@/lib/notify/notify";
import { piResumableStorage } from "@/lib/pi/pi-resume-storage";
import { hydrateRunningRegistrations } from "@/lib/pi/pi-running";
import {
  readLastThread,
  readNewThreadActionCount,
  recordLastThread,
  syncClearLastThread,
} from "@/lib/pi/pi-last-thread";
import { piSessionCwdMap } from "@/lib/pi/pi-thread-adapter";
import { initAppearance } from "@/lib/settings/appearance";
import { piRuntimeAdapters } from "@/lib/attachments/pi-attachment-adapter";
import { usePiRuntime } from "@/lib/pi/pi-runtime";
import { TauriPiClient } from "@/lib/pi/pi-runtime/tauri-pi-client";
import {
  getWorkspace,
  getWorkspaceSource,
  setWorkspace,
} from "@/lib/workspace/workspace-store";
import { ConnectScreen } from "@/components/remote/connect-screen";
import { RemoteRuntimeProvider } from "@/components/remote/remote-runtime-provider";
import {
  getRemoteConfig,
  type RemoteConfig,
} from "@/lib/remote";
import { KovaBoot } from "@/components/loading-ui/kova-boot";
/** splash 最小展示时长：保证启动动画至少播一会儿，不被快速水合直接闪没。
 *  迭代1b（P6）：3000 → 800——固定 3s 开屏把分块/按需加载的全部启动收益
 *  掩盖在动画里。换 KovaBoot 品牌开屏后定在 1800：逐字聚焦约 1.5s 播完，
 *  掐在半模糊状态不可接受，1800ms 留出落定帧的停留。 */
const SPLASH_MIN_MS = 900;

/**
 * 启动占位屏：随静态导出的预渲染 HTML 直接输出，webview 导航后立即可见，
 * 无需等 JS 水合。窗口 transparent:true 时启动阶段没有实体内容——
 * Windows 全透明区域点击穿透、macOS 看似未启动——占位屏提供可见可点击
 * 的加载反馈，直到运行时就绪。
 *
 * 角色为 KovaBoot 品牌开屏动画（components/loading-ui/kova-boot）：
 * 猫图标常驻 + 「扣瓦」字标逐字聚焦落定；纯 CSS 合成器动画，
 * 预渲染 HTML 即可播放（无 canvas 引擎、无接管时序），
 * ready 即回调 onFinished 由宿主卸载（最短展示时长由宿主 SPLASH_MIN_MS 兜底）。
 *
 * 挂载期间在 html 上打 data-boot-splash（globals.css 据此让 body 透明，
 * 露出桌面/窗口材质，仅开屏动画浮在上面）；卸载时摘除，恢复 body 正常底色。
 * 静态 HTML 已带该标记（layout.tsx），水合后的 effect 重复打标是幂等操作。
 */
function BootSplash({
  ready,
  onFinished,
}: {
  ready: boolean;
  onFinished: () => void;
}) {
  // onFinished 经 ref 调用：宿主多是内联箭头函数，避免其身份变化重复交棒
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    document.documentElement.dataset.bootSplash = "";
    return () => {
      delete document.documentElement.dataset.bootSplash;
    };
  }, []);

  useEffect(() => {
    if (ready) finishedRef.current();
  }, [ready]);

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center bg-background">
      <KovaBoot className="text-zinc-950 dark:text-zinc-50" />
    </div>
  );
}

/**
 * 全局 workspace 跟随当前会话：左侧列表切到某个已落盘会话时，把
 * workspace-store 同步到该会话记录的 cwd（无 cwd 的任务会话则清空），
 * 让 Git 面板/审查/检查点条读到的都是"这个对话的工作目录"。
 * 同步值标记 source="session"（胶囊显示"跟随"角标），与用户手动选择区分。
 * 草稿会话（无 remoteId）：不清"用户刚在胶囊里选的目录"（source=user），
 * 但上一会话遗留的 session 同步值要清掉——否则从旧对话切到新对话时，
 * 新草稿静默继承旧目录（正是"没选目录却进了旧目录"的入口之一）。
 */
function WorkspaceThreadSync() {
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  useEffect(() => {
    const item = threadItems.find((t) => t.id === mainThreadId);
    if (!item) return;
    // 指针"写通"：pi-last-thread 恒等于主线程当前所在（草稿=清空）。启动决策
    // 不受影响——ResumeRunningThread 在首次渲染就捕获了上次加载留下的指针，
    // 渲染早于本 effect，这里的清空只影响下一次刷新。用户刷新前停在新对话时，
    // 这里清掉指针，下次刷新就不再被拉回旧会话（2026-09-22 修复）。
    // 用 syncClear 而非动作清空：首帧停在草稿是内部机制，不算用户意图。
    if (!item.remoteId) {
      syncClearLastThread();
      // 草稿上的目录若只是上一会话的"跟随"残值（非用户本会话手动选），清掉
      if (getWorkspaceSource() === "session") setWorkspace(null);
      return;
    }
    recordLastThread(item.remoteId);
    const cwd = piSessionCwdMap.get(item.remoteId) ?? null;
    if (getWorkspace() !== cwd) setWorkspace(cwd, "session");
  }, [mainThreadId, threadItems]);

  return null;
}

/**
 * 刷新回切三级：1) "在飞流登记"对应的会话（任务还在跑——框架续流只发生在
 * 主线程，chat 以列表行 id===remoteId===sessionId 认领登记并自动 attach）；
 * 2) 登记缺失（webview 存储被清等）→ 向 sidecar 运行态真相水合（同时重建
 * 登记，续流可 attach）并回其在跑会话；3) 无在跑轮次 → 回"最近打开的会话"，
 * 避免刷新后停在空白新草稿（2026-09-14"刷新后消息没渲染"观感修复）。
 * 第 3 级用首帧捕获的"最近打开的会话"指针（渲染早于写通清空，读到的即刷新前
 * 状态）：刷新前已切到新对话时指针已被入口动作/写通清掉 → 捕获值为空、不回切，
 * 停在新草稿即符合预期（2026-09-22 点新对话后刷新回到旧会话的修复）；回切前再查
 * "新对话"动作计数增量复查用户意图。每次决策 console.warn 一条 "[resume] tier=..."
 * 进 web.log。
 *
 * 先 reload() 等列表就位再 switch：避免走 adapter.fetch 物化出无标题的临时行。
 * 仅启动时执行一次；会话已被删（switch 抛错）静默跳过，不阻塞启动。
 */
function ResumeRunningThread() {
  const aui = useAui();
  const attemptedRef = useRef(false);
  // 决策快照在**首次渲染**捕获：WorkspaceThreadSync 挂载即写通（首帧主线程必是
  // 草稿 → 清空指针），渲染早于一切 effect，捕获到的才是上一次加载留下的值。
  // effect 里现读会拿到本次清空，回切整体失效。newThreadActions 同帧快照：
  // tier-3 回切前查它的增量（而非指针值——写通清空会让指针必然偏离捕获值，
  // 无法区分机制清空与用户动作），启动窗口里用户真点了"新对话"才放弃回切。
  const [loadSnapshot] = useState(() => ({
    lastThread: readLastThread(),
    newThreadActions: readNewThreadActionCount(),
  }));
  const lastThreadAtLoad = loadSnapshot.lastThread;

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    // 回切结果留痕用（catch 作用域可见）：决策行（tier=...）只有目标，没有
    // 成败——绑定劫持类事故（2026-09-28）排查时缺"switch 到底成没成"这一环
    let resumeTarget: string | null = null;
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
        // 最后回"最近打开的会话"（渲染时捕获值）
        const runningTarget =
          [...withSid].reverse().find((e) => running.has(e.sessionId))?.sessionId ??
          null;
        const inFlightTarget = withSid.at(-1)?.sessionId ?? null;
        const target = runningTarget ?? inFlightTarget ?? lastThreadAtLoad;
        resumeTarget = target;
        // 每次加载一条回切决策留痕（warn 级别才进 web.log，见 frontend-logging）
        console.warn(
          `[resume] tier=${
            runningTarget ? "running" : inFlightTarget ? "in-flight" : lastThreadAtLoad ? "last-thread" : "none"
          } target=${target ?? "null"} inFlight=${withSid.length} running=${running.size} lastAtLoad=${lastThreadAtLoad ?? "null"} actions=${loadSnapshot.newThreadActions}`,
        );
        if (!target) return;
        // 回切前复查用户意图：tier-3 用的是加载时捕获值，若启动这几拍里用户又
        // 点了新对话（动作清空会计数，写通清空不计数），放弃回切，尊重最新动作。
        if (
          !runningTarget &&
          !inFlightTarget &&
          readNewThreadActionCount() !== loadSnapshot.newThreadActions
        ) {
          console.warn(
            `[resume] skip last-thread switch: new-thread action after load (attempts=${loadSnapshot.newThreadActions})`,
          );
          return;
        }
        await aui.threads.reload();
        await aui.threads.switchToThread(target);
        console.warn(`[resume] switched target=${target}`);
      } catch (err) {
        console.warn(
          `[resume] switch failed target=${resumeTarget ?? "null"}`,
          String(err),
        );
      }
    })();
  }, [aui, loadSnapshot]);

  return null;
}

/**
 * Tauri 桌面端：pi-agent sidecar 作为会话事实源（RemoteThreadList + 持久化 session 文件）。
 * 远程网页端：经隧道直连桌面端 WS 网关（配对码认证），运行时与桌面同构。
 * 构建目标固定、环境互不切换，按 isTauri/远程拆分组件避免条件 hook。
 */
function TauriRuntimeProvider({ children }: { children: React.ReactNode }) {
  // react-pi 迁移阶段 2c：渲染链路切到 usePiRuntime（快照权威 + 降级轮询订阅）。
  // 线程身份 = pi sessionId；旧 AI SDK 链路（PiTransport + createPiThreadListAdapter）
  // 保留未删，仅服务回滚（revert 本 commit 即整体还原）。
  const client = useMemo(() => new TauriPiClient(), []);

  // 运行时操作失败（重新生成/编辑重发/队列/abort 等）必须可见：
  // usePiRuntime 内部把 handler 异常统一收敛到 onError（core 对
  // onReload/onEdit 即发即忘，不允许再抛），不接就等于静默吞错
  const runtime = usePiRuntime({
    client,
    // composer 附件（粘贴/文件选择的 File 路径）与 capabilities.attachments
    // 都由这条 adapter 打开；缺它则 ExternalStoreRuntime 判线程不支持附件，
    // 粘贴文件被闸门静默丢弃（见 pi-attachment-adapter.ts）
    adapters: piRuntimeAdapters,
    onError: (error) => {
      console.error("[pi-runtime]", error);
      toast.error(error instanceof Error ? error.message : String(error));
    },
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

  // 开屏动画由 AppRuntimeProvider 层的 BootSplash 统一播完，
  // 到这里只剩读 localStorage 的一帧空档；此分支仅 web 端会走到（桌面端进
  // TauriRuntimeProvider），透明窗口问题不存在，直接空渲染即可——若在这里再挂
  // 一个 BootSplash，开屏会重复播放一遍，时长翻倍。
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
  // 环境判定 + 最短时长都齐了才交棒（进应用）
  const [splashDone, setSplashDone] = useState(false);
  const splashStartRef = useRef(Date.now());

  useEffect(() => {
    setDesktop(isTauri());
    // 先取版本号：崩溃反馈要带 build 号，而这个值只能异步拿
    primeAppMeta();
    // 桌面端挂载 console.warn/error 与崩溃转发（写 web.log，内部自判环境）
    installFrontendLogging();
    // 主线程卡顿看门狗：卡顿记录进 web.log，冻结时弹一次 toast 让用户知道
    installPerfWatch({
      onFreeze: () => {
        toast.error({
          title: "界面卡住了",
          description: "主线程被长任务占住了几秒，已记进日志。可以先切走别的界面再切回来。",
        });
      },
    });
    // 通知管线：事件总线 → 提示音 + webhook 派发（幂等，桌面/远程网页都装配）
    initNotifyPipeline();
    // 窗口材质透明标记恢复：appearance.ts 的模块级自执行只在设置页 chunk
    // 加载时触发，刷新后若没进过设置，html 缺 data-window-effect 标记，
    // body 被 bg-background 盖住（窗口材质在但被遮成不透明）。这里任何
    // 启动路径（含刷新）都提前补标——趁 BootSplash 期间应用，无闪白。
    void initAppearance();
    const remain = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStartRef.current));
    const timer = setTimeout(() => setSplashMinDone(true), remain);
    return () => {
      clearTimeout(timer);
      uninstallPerfWatch();
    };
  }, []);

  // 开屏结束 + 桌面端：让宿主按当前材质状态翻转 webview 表面透明度。
  // 窗口 transparent:true 时 WebView2 表面带 alpha → ClearType 被禁用，
  // 整窗文字灰度抗锯齿（比浏览器细/虚）；材质关闭时宿主借此恢复不透明
  // 表面拿回 ClearType。开屏期间必须保持透明，所以挂在 splashDone 之后。
  useEffect(() => {
    if (!desktop || !splashDone) return;
    void invoke("sync_webview_surface").catch(() => {});
  }, [desktop, splashDone]);

  // 首帧（含静态导出的预渲染 HTML）恒为 BootSplash，与水合后 effect 翻转前的
  // 客户端首帧一致，避免 hydration mismatch；桌面端水合前窗口由此获得实体内容。
  // 环境判定与最短时长都满足后 splashDone 置真，真正进应用。
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
