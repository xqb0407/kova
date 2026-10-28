"use client";

import dynamic from "next/dynamic";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  FileDiffIcon,
  FileIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitGraphIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  PackageIcon,
  PanelTopIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { isDesktop } from "@/lib/desktop-env";
import { closeQuickView, toggleQuickView, useQuickViewOpen } from "@/lib/quick-view";
import { groupArtifacts, taskDelegations, todoRows } from "@/lib/quick-view-model";
import { fetchTodoState, useThreadTodos } from "@/lib/pi/pi-todo";
import { useIsAskMode } from "@/lib/pi/pi-session-mode";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useGitStatus } from "@/lib/git/git-status";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { useThreadArtifacts } from "@/lib/panels/use-artifacts";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { formatBytes, openModeFor, toFileUrl, type MessageArtifact } from "@/lib/panels/artifacts";
import { resultText } from "@/lib/panels/panel-activity";
import { fsOpen, fsReveal } from "@/lib/workspace/fs";
import {
  openSubagentTab,
  parseDelegationIdFromResult,
  startSubagentRunsWatch,
  subagentElapsedSeconds,
  useSubagentRunsByToolCalls,
  type SubagentRunState,
} from "@/lib/subagent/subagent-runs";
import { GitGraphDialog } from "@/components/agent-thread/agent-panel/git-graph";

/**
 * 快速查看（Header 上的「扫一眼」入口）：不开右侧面板即可查看会话的
 * Git 状态、任务进度、交付物与子智能体委派。
 *
 * 形态是绝对定位的悬浮卡片（不是 Popover）：挂在聊天内容区右上、盖在正文
 * 上方，开合状态在 lib/quick-view（按 threadId 记录，切会话自动收起）；
 * 收起即整卡卸载——不订阅任何数据源、不拉水合，开卡才接上各分区自己的
 * store。各分区数据与右侧面板同源（todo/git/产物/子智能体四个 store 的
 * 只读消费），点击条目跳面板对应标签看细节，浮层自身不做写操作。
 */

/** 彩色文件图标（material-file-icons ~1.5MB）按需加载，别拉进首屏 chunk
 *  （与产物页签同一约定；浮层行更紧凑，兜底图标用小号线性文件图标） */
const FileTypeIcon = dynamic(
  () =>
    import("@/components/agent-thread/agent-panel/file-type-icon").then(
      (m) => m.FileTypeIcon,
    ),
  {
    ssr: false,
    loading: () => <FileIcon className="text-muted-foreground size-4 shrink-0" />,
  },
);

/** 委派终态中文短标签（与 tool-row.aui 的 DELEGATION_STATUS_LABEL 同款镜像；
 *  running 不显示文字，转圈即状态） */
const DELEGATION_STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  truncated: "轮次超限",
  aborted: "已中止",
  stopped: "已停止",
  interrupted: "已中断",
};

/** 面板收起时唤起（与 header 的链路追踪入口同一手法） */
function openAgentPanel(): void {
  window.dispatchEvent(new Event("agent-panel:open"));
}

/* ------------------------------ Header 按钮 ------------------------------ */

/** 快速查看开关：开启时点亮底色（aria-pressed），与终端开关同一套开合反馈。
 *  新对话（无消息）不显示——空会话没有可查看的进度与产物 */
export const QuickViewToggleButton: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0);
  const open = useQuickViewOpen(threadId ?? undefined);
  if (!threadId || isEmptyThread) return null;
  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip="快速查看"
      side="bottom"
      aria-pressed={open}
      onClick={() => toggleQuickView(threadId)}
      className={cn("size-8 shrink-0", open && "bg-muted text-foreground")}
    >
      <PanelTopIcon className="size-4" />
    </TooltipIconButton>
  );
};

/* ------------------------------ 浮层卡片 ------------------------------ */

/** 悬浮滚动条容器：隐藏原生滚动条，自绘一条细浮条（rounded 4px），
 *  只有鼠标悬停整张卡片时淡入——与侧边栏「悬浮才显示」的观感一致。
 *  浮条只做指示、pointer-events-none（滚轮/触控板仍是主操作），
 *  位置/高度按 scrollTop/scrollHeight 实时折算，内容增删经
 *  MutationObserver 跟随（分区展开收起会改变滚动高度）。 */
const QuickViewScroller: FC<{
  /** 悬停由外层 group/qv 驱动（整卡 hover 才显浮条） */
  children: ReactNode;
}> = ({ children }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight + 1) {
        setThumb((prev) => (prev === null ? prev : null));
        return;
      }
      const height = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
      const top =
        (scrollTop / (scrollHeight - clientHeight)) *
        Math.max(0, clientHeight - height);
      setThumb((prev) =>
        prev && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { top, height },
      );
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // 分区展开/收起、行内容变化（如委派状态词）都改 scrollHeight，
    // 子树变更即重算（反馈环不会成环：只读几何、写的是浮条样式）
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        // 滚动容器必须是 flex 子项（flex-1 + min-h-0）而不是 h-full：
        // max-height 钳制的卡片里，百分比高度对 flex 增长出的父高不解析，
        // h-full 会退化成内容高、把卡片撑出可视区（实测 564 > 384）。
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto p-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className="bg-muted-foreground/30 pointer-events-none absolute right-1 w-1.5 rounded-full opacity-0 transition-opacity duration-150 group-hover/qv:opacity-100"
        style={thumb ? { top: thumb.top, height: thumb.height } : { display: "none" }}
      />
    </div>
  );
};

export const QuickViewCard: FC<{ threadId: string | null }> = ({ threadId }) => {
  const open = useQuickViewOpen(threadId ?? undefined);
  // ESC 收起：浮层是临时视图，键盘逃逸与按钮同语义；不 preventDefault，
  // 别处（输入框等）对 ESC 的处理不受影响
  useEffect(() => {
    if (!open || !threadId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        closeQuickView(threadId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, threadId]);

  if (!open || !threadId) return null;
  return (
    <aside
      aria-label="快速查看"
      data-slot="quick-view-card"
      // group/qv：整卡悬停驱动自绘滚动条淡入（QuickViewScroller 里消费）
      className="group/qv bg-popover text-popover-foreground ring-foreground/10 absolute top-3 right-3 z-20 flex max-h-[min(64dvh,32rem)] w-[21rem] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border shadow-md"
    >
      {/* 唯一滚动容器（分区不再各自滚）：一条悬浮浮条 + 本层兜底滚动，
          多分区展开时后续分区标题始终可达 */}
      <QuickViewScroller>
        <GitSection />
        <TodoSection threadId={threadId} />
        <ArtifactsSection />
        <SubagentsSection />
      </QuickViewScroller>
    </aside>
  );
};

/* ------------------------------ 分区壳 ------------------------------ */

/** 可折叠分区：图标块 + 标题 + 计数胶囊（展开/收起都显示）+ 内容。
 *  内容做成内嵌浅色块（产物行同款 bg-muted/40）：卡片里再分层，
 *  是 kova 自己的卡片流语言，而不是 ZCode 那种一条到底的平板列表 */
const QuickSection: FC<{
  title: string;
  /** 分区图标：小圆角底块里的一枚线性图标 */
  icon: FC<{ className?: string }>;
  /** 标题右缘的计数胶囊（如 3/8、N 个运行） */
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}> = ({ title, icon: Icon, trailing, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 flex-none">
      <CollapsibleTrigger className="group hover:bg-muted/40 flex h-9 w-full min-w-0 shrink-0 items-center gap-2 rounded-xl px-1.5 text-left transition-colors">
        <span className="bg-muted/70 text-muted-foreground group-hover:text-foreground grid size-5.5 shrink-0 place-items-center rounded-lg transition-colors">
          <Icon className="size-3.5" />
        </span>
        <span className="text-foreground/85 group-hover:text-foreground truncate text-sm">
          {title}
        </span>
        {trailing != null ? (
          <span className="bg-muted/70 text-muted-foreground ml-auto shrink-0 rounded-full px-1.5 py-px text-[11px] leading-4 tabular-nums">
            {trailing}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform duration-150",
            trailing == null && "ml-auto",
            !open && "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/40 mt-1 rounded-xl p-1.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** 分区内容的空态提示行（落在内嵌块里） */
const SectionHint: FC<{ text: string }> = ({ text }) => (
  <p className="text-muted-foreground px-1.5 py-1 text-sm">{text}</p>
);

/* ------------------------------ 环境信息 ------------------------------ */

/** Git 环境信息：分支行 + 三个入口（变更 / 提交或推送 / 变更图谱）。
 *  显隐与右侧 Git 面板入口同源：编码模式 + git 仓库 + 非问答档，否则整区
 *  隐藏（问答档不碰工程，同 tab-registry 的过滤口径） */
const GitSection: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  const ask = useIsAskMode();
  const [graphOpen, setGraphOpen] = useState(false);

  if (appMode !== "code" || ask || !workspace || !status) return null;
  const dirty = status.dirty;

  const actions: {
    icon: FC<{ className?: string }>;
    label: string;
    onClick: () => void;
  }[] = [
    {
      icon: FileDiffIcon,
      label: "变更",
      onClick: () => {
        focusPanelTab("review");
        openAgentPanel();
      },
    },
    {
      icon: GitCommitHorizontalIcon,
      label: "提交或推送",
      onClick: () => {
        focusPanelTab("git");
        openAgentPanel();
      },
    },
    { icon: GitGraphIcon, label: "变更图谱", onClick: () => setGraphOpen(true) },
  ];

  return (
    <>
      <QuickSection
        title="环境信息"
        icon={GitBranchIcon}
        trailing={dirty > 0 ? dirty : undefined}
      >
        <div className="flex flex-col gap-0.5">
          {/* 分支胶囊（header 的 workspace 徽章同款语言）：底块里再嵌一枚
              背景色药丸，比裸行更像 kova 的 tag 体系 */}
          <div
            className="bg-background/70 mb-0.5 flex h-7 min-w-0 items-center gap-2 rounded-full px-2.5 text-sm"
            title={`${status.branch}${dirty > 0 ? ` · ${dirty} 个未提交变更` : ""}`}
          >
            <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{status.branch}</span>
            {dirty > 0 ? (
              <span className="bg-muted-foreground/15 rounded-full px-1.5 text-[11px] tabular-nums">
                {dirty}
              </span>
            ) : null}
          </div>
          {actions.map(({ icon: Icon, label, onClick }) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              className="hover:bg-muted/70 flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-foreground/90 transition-colors hover:text-foreground"
            >
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          ))}
        </div>
      </QuickSection>
      {/* 图谱弹窗独立挂载（composer 同款）：不依赖右侧面板，浮层里直达 */}
      <GitGraphDialog
        cwd={workspace}
        branch={status.branch}
        open={graphOpen}
        onOpenChange={setGraphOpen}
      />
    </>
  );
};

/* ------------------------------ 进度 ------------------------------ */

/** 任务进度：todo 快照渲染。完成 = 勾圈 + 删除线淡化；进行中 = 序号徽标；
 *  待办 = 空心圈。点条目跳面板的计划标签。空清单保留分区（副标题提示） */
const TodoSection: FC<{ threadId: string }> = ({ threadId }) => {
  const snap = useThreadTodos(threadId);
  // 开卡水合（浮层收起时不挂载、不发请求）
  useEffect(() => {
    fetchTodoState(threadId);
  }, [threadId]);
  const rows = useMemo(() => todoRows(snap.tasks), [snap.tasks]);
  const doneCount = rows.filter((r) => r.state === "done").length;

  return (
    <QuickSection
      title="进度"
      icon={ListTodoIcon}
      trailing={rows.length > 0 ? `${doneCount}/${rows.length}` : undefined}
    >
      {rows.length === 0 ? (
        <SectionHint text="跟踪较长任务的进度" />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  focusPanelTab("plan");
                  openAgentPanel();
                }}
                className="hover:bg-muted/70 flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-sm transition-colors"
                title={row.text}
              >
                {row.state === "done" ? (
                  // 完成 = 计划面板同款绿实心圆白勾；进行中 = 环形数字
                  // （描边圈而不是 ZCode 的实心深色数字）；待办 = 虚线空心圈
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
                    <CheckIcon className="size-2.5" strokeWidth={3} />
                  </span>
                ) : row.state === "active" ? (
                  <span className="border-foreground/60 text-foreground grid size-4 shrink-0 place-items-center rounded-full border-2 text-[9px] leading-none font-semibold tabular-nums">
                    {row.badge}
                  </span>
                ) : (
                  <CircleDashedIcon className="text-muted-foreground/55 size-4 shrink-0" />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    row.state === "done" && "text-muted-foreground/60 line-through",
                  )}
                >
                  {row.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </QuickSection>
  );
};

/* ------------------------------ 交付物 ------------------------------ */

/** 会话交付文件：按「preview（可浏览器预览）」「workspace（其余）」分组，
 *  行点击复用产物页签的打开语义（预览标签 / 文件标签 / 系统打开） */
const ArtifactsSection: FC = () => {
  const messages = useAuiState((s) => s.thread.messages);
  const cwd = usePanelCwd();
  const { artifacts, settled } = useThreadArtifacts(messages, cwd);
  const groups = useMemo(
    () => groupArtifacts(artifacts, { canPreview: isDesktop() }),
    [artifacts],
  );
  // stat 未回来前不渲染（避免列表先闪一批再被替换——产物页签同款）
  if (!settled) return null;
  const total = groups.preview.length + groups.workspace.length;

  return (
    <QuickSection
      title="交付物"
      icon={PackageIcon}
      trailing={total > 0 ? total : undefined}
    >
      {total === 0 ? (
        <SectionHint text="agent 写出交付文件后会汇总在这里" />
      ) : (
        <div className="flex flex-col">
          {groups.preview.length > 0 ? (
            <ArtifactGroup label="preview" artifacts={groups.preview} cwd={cwd} />
          ) : null}
          {groups.workspace.length > 0 ? (
            <ArtifactGroup label="workspace" artifacts={groups.workspace} cwd={cwd} />
          ) : null}
        </div>
      )}
    </QuickSection>
  );
};

const ArtifactGroup: FC<{
  label: string;
  artifacts: MessageArtifact[];
  cwd: string | null;
}> = ({ label, artifacts, cwd }) => (
  <div className="pb-1">
    <div className="text-muted-foreground/80 px-1.5 pt-1 pb-0.5 text-[11px]">{label}</div>
    <ul>
      {artifacts.map((artifact) => (
        <ArtifactRowItem key={artifact.toolCallId} artifact={artifact} cwd={cwd} />
      ))}
    </ul>
  </div>
);

/** 行点击的打开语义（产物页签 ArtifactRow 的精简镜像）：
 *  browser → 预览标签；file → 磁盘实时优先、write 快照兜底；system → 系统打开 */
function openArtifact(artifact: MessageArtifact, cwd: string | null): void {
  const mode = artifact.openMode ?? openModeFor(artifact.path);
  const relPath = artifact.relPath ?? artifact.path;
  if (mode === "browser" && isDesktop() && cwd) {
    focusPanelTab("browser", { url: toFileUrl(cwd, relPath), title: artifact.base });
    openAgentPanel();
    return;
  }
  if (mode === "system" || (!cwd && artifact.relPath == null)) {
    void (async () => {
      const error = await fsOpen(cwd ?? "", artifact.path);
      if (error && cwd) await fsReveal(cwd, relPath);
    })();
    return;
  }
  if (cwd && artifact.relPath != null) {
    focusPanelTab("file", { cwd, path: artifact.relPath, title: artifact.base });
  } else if (
    artifact.source === "write" &&
    !artifact.toolCallId.startsWith("artifact:")
  ) {
    focusPanelTab("file", { focus: artifact.toolCallId, title: artifact.base });
  } else {
    void (async () => {
      const error = await fsOpen(cwd ?? "", artifact.path);
      if (error && cwd) await fsReveal(cwd, relPath);
    })();
    return;
  }
  openAgentPanel();
}

const ArtifactRowItem: FC<{ artifact: MessageArtifact; cwd: string | null }> = ({
  artifact,
  cwd,
}) => (
  <li>
    <button
      type="button"
      onClick={() => openArtifact(artifact, cwd)}
      className="hover:bg-muted/70 flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm transition-colors"
      title={artifact.path}
    >
      <FileTypeIcon path={artifact.path} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{artifact.base}</span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatBytes(artifact.size)}
      </span>
    </button>
  </li>
);

/* ------------------------------ 子智能体 ------------------------------ */

/** Task 委派运行列表：默认收起，标题旁显示运行数。行 = 图标 + 名称/描述 +
 *  状态（运行中转圈计时 / 终态标签）。点击打开该委派的子智能体标签
 *  （openSubagentTab 自带唤起面板）。无委派整区隐藏 */
const SubagentsSection: FC = () => {
  const messages = useAuiState((s) => s.thread.messages);
  const running = useAuiState((s) => s.thread.isRunning);
  // 流式期间 messages 每个 token 换身份；委派列表用进入运行前的快照，
  // run 结束后再整体重算一次（与产物页签同一手法，避免逐 token 全量重扫）
  const scanRef = useRef(messages);
  useEffect(() => {
    if (!running) scanRef.current = messages;
  }, [messages, running]);
  const scanMessages = running ? scanRef.current : messages;
  const delegations = useMemo(() => taskDelegations(scanMessages), [scanMessages]);
  const toolCallIds = useMemo(
    () => delegations.map((row) => row.toolCallId),
    [delegations],
  );

  useEffect(() => {
    startSubagentRunsWatch();
  }, []);
  // 单次订阅取全部委派条目（run store 的活动广播驱动重渲：状态翻转/计时源）
  const runs = useSubagentRunsByToolCalls(toolCallIds);
  const runningCount = [...runs.values()].filter(
    (run) => run?.status === "running" && !run.expired,
  ).length;

  if (delegations.length === 0) return null;

  return (
    <QuickSection
      title="子智能体"
      icon={BotIcon}
      defaultOpen={false}
      trailing={runningCount > 0 ? runningCount : delegations.length}
    >
      <ul className="flex flex-col gap-0.5">
        {delegations.map((row) => (
          <SubagentRowItem
            key={row.toolCallId}
            row={row}
            run={runs.get(row.toolCallId)}
          />
        ))}
      </ul>
    </QuickSection>
  );
};

const SubagentRowItem: FC<{
  row: { toolCallId: string; agentName: string; description: string; result: unknown };
  run: SubagentRunState | undefined;
}> = ({ row, run }) => {
  const isRunning = run?.status === "running" && !run.expired;
  // 运行中每秒一拍刷新用时，条目结算后自动停（Task 工具行同款；
  // run store 的广播只按活动来，不按秒来）
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);
  // 历史重建（无绑定 chunk）：从结果文本兜底解析短 id（Task 行同款）
  const delegationId =
    run?.delegationId ?? parseDelegationIdFromResult(resultText(row.result) ?? "");
  const elapsed = isRunning && run ? subagentElapsedSeconds(run) : 0;

  let statusNode: ReactNode;
  if (run?.expired) {
    statusNode = <span className="text-muted-foreground text-xs">记录不可用</span>;
  } else if (isRunning) {
    statusNode = (
      <>
        <LoaderCircleIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
        {elapsed > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">{elapsed}s</span>
        ) : null}
      </>
    );
  } else if (run) {
    const label = DELEGATION_STATUS_LABEL[run.status] ?? run.status;
    statusNode = (
      <span
        className={cn(
          "text-xs",
          run.status === "completed"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground",
        )}
      >
        {label}
        {run.completedAt && run.startedAt
          ? ` ${Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000))}s`
          : ""}
      </span>
    );
  } else {
    statusNode = (
      <span className="text-muted-foreground text-xs">
        {delegationId ? "已结束" : "未启动"}
      </span>
    );
  }

  return (
    <li>
      <button
        type="button"
        disabled={!delegationId}
        onClick={() => delegationId && openSubagentTab(delegationId, row.description || row.agentName)}
        className={cn(
          "flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-sm transition-colors",
          delegationId && "hover:bg-muted/70 cursor-pointer",
        )}
      >
        <BotIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {row.agentName || "委派"}
          {row.description ? (
            <span className="text-muted-foreground"> · {row.description}</span>
          ) : null}
        </span>
        {statusNode}
      </button>
    </li>
  );
};

/** memo：浮层开合只影响挂载与否，卡片内容在开启期间不随 Header 的其它
 *  状态变化重渲染（threadId 不变时 props 恒定） */
export default memo(QuickViewCard);
