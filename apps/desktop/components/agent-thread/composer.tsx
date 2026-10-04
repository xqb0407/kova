"use client";

import { ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { GroupedTriggerPopover } from "@/components/agent-thread/composer-grouped-popover";
import {
  useComposerSlashMenu,
  useSubagentMention,
} from "@/components/agent-thread/composer-commands";
import {
  CmComposerInput,
  focusComposer,
} from "@/components/agent-thread/cm-composer-input";
import { PromptOptimizeOverlay } from "@/components/agent-thread/prompt-optimize-overlay";
import { toast } from "@/components/ui/toast";
import { directiveChipVariants } from "@/components/assistant-ui/elements/directive-text.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  notifyNoModelSelected,
  useModelGate,
} from "@/lib/pi/pi-model-gate";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { ThinkingPicker } from "@/components/agent-thread/thinking-picker";
import {
  CapabilityModeChip,
  ModePicker,
} from "@/components/agent-thread/mode-picker";
import { GoalStrip } from "@/components/agent-thread/goal-strip";
import { ComposerPlusMenu } from "@/components/agent-thread/composer-plus-menu";
import { DesignThemePicker } from "@/components/agent-thread/design-theme-picker";
import { ContextButton } from "@/components/agent-thread/context-button";
import { setSessionMode, useSessionMode } from "@/lib/pi/pi-session-mode";
import {
  clearAskNeedsWork,
  useAskNeedsWork,
} from "@/lib/pi/pi-ask-needs-work";
import { PromptQueueBar } from "@/components/agent-thread/prompt-queue-bar";
import { usePiQueue } from "@/lib/pi/pi-runtime";
import { addSteeredBadge } from "@/lib/pi/pi-steer-intent";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { cancelOptimize, optimizePrompt } from "@/lib/pi/pi-prompt-optimize";
import { ToolApprovalCard } from "@/components/agent-thread/tool-approval-card";
import { QuestionCard } from "@/components/agent-thread/question-card";
import { usePendingQuestions } from "@/lib/pi/pi-question";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import { Button } from "@/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  matchesShortcut,
  resolveComposerSubmitMode,
  useShortcuts,
  type ShortcutConfig,
} from "@/lib/shortcuts";
import {
  ArrowRightLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitGraphIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { isTauri } from "@/lib/tauri";
import {
  clearWorkspace,
  openWorkspacePicker,
  pathBasename,
  setWorkspace,
  useWorkspace,
  useWorkspaceRecents,
  useWorkspaceSource,
} from "@/lib/workspace/workspace-store";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "../ui/input";
import { cn } from "cn";
import { useGitStatus } from "@/lib/git/git-status";
import { gitBranches, gitCheckout, type GitBranches } from "@/lib/git/git";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import { openPanelTab } from "@/lib/panels/panel-tabs";

const ModelPicker: FC = () => {
  return <PiModelPicker />;
};

/**
 * 输入框键盘守卫：
 * 1) 输入法回车守卫——WKWebView 下回车确认候选词的 keydown 常带 isComposing=false
 *    （或紧随 compositionend 之后送达），库内建的 composing 检查拦不住，导致误发送。
 *    display:contents 包装层上以捕获阶段监听：组合中的 Enter 记入「以 Enter 提交」
 *    标记并只拦传递（候选词确认走默认）；组合结束后 120ms 内的 Enter 仅当该标记
 *    在（= 确实是 Enter 提交的回声）才拦下。无差别时间窗会把「空格/数字选词后
 *    快速按回车发送」的真实按键一并吞掉——按两下才发出去的根源。
 * 2) 自定义发送——「发送消息」被绑成非 Enter 组合时（submitMode="none"），库不会在
 *    Enter 提交，这里捕获命中绑定即 aui.composer.send({ steer: false })（运行中
 *    = 排队）；Enter 落回库默认→换行。
 * 3) 模型不可用闸门——noModel 时有内容的发送组合不提交（toast 说明原因）；
 *    空草稿照旧放行，让 Enter 保持换行语义。
 * 用原生 DOM 而非 lexical 命令：app 与库解析到的 @lexical/react 是两份模块实例，
 * useLexicalComposerContext 拿不到库内的 Composer 上下文。
 */
const ImeEnterGuard: FC<{
  children: ReactNode;
  send: ShortcutConfig;
  interceptSend: boolean;
  noModel: boolean;
  noModelHint: string | null;
  /** 优化进行中：Enter/Escape 全吞，自定义发送组合只拦键不发送 */
  blocked?: boolean;
}> = ({ children, send, interceptSend, noModel, noModelHint, blocked = false }) => {
  const ref = useRef<HTMLDivElement>(null);
  const aui = useAui();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let compositionEndedAt = 0;
    let composingEnterSeen = false;
    const onCompositionStart = () => {
      composingEnterSeen = false;
    };
    const onCompositionEnd = () => {
      compositionEndedAt = performance.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const composing = event.isComposing || event.keyCode === 229;
      if (composing) {
        if (event.key === "Enter") composingEnterSeen = true;
        // 组合中的 Enter 只拦传递（preventDefault 可能拦掉候选词提交，候选词
        // 确认仍走默认）
        event.stopPropagation();
        return;
      }
      // 外部锁定态（提示词优化进行中）：Enter/Escape 连默认行为一起吞
      if (blocked && (event.key === "Enter" || event.key === "Escape")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.key === "Enter" &&
        composingEnterSeen &&
        performance.now() - compositionEndedAt <= 120
      ) {
        // 组合刚结束的回声 Enter 已是普通按键，浏览器默认行为
        // 就是往 contenteditable 插一个换行——必须连默认行为一起吞掉，
        // 否则字确认了、行也白换
        composingEnterSeen = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // 自定义发送组合（如 ⌘Enter 之外的绑定）：组合态不劫持，交由 IME 逻辑处理
      if (interceptSend && !composing && matchesShortcut(event, send)) {
        event.preventDefault();
        event.stopPropagation();
        // 锁定态：自定义发送组合只拦键，不发送
        if (blocked) return;
        // 模型不可用：有草稿才拦（空草稿本就没得发，组合键等价于无操作）
        if (noModel && noModelHint && aui.composer.getState().canSend) {
          notifyNoModelSelected(noModelHint);
          return;
        }
        // 显式排队车道：store 暴露 queue adapter 后，运行中不带 steer 选项的
        // 发送会被 core 默认路由成并入当前轮（append 里 message.steer ??
        // isRunning），自定义绑定语义（普通发送）必须显式声明 followUp
        aui.composer.send({ steer: false });
      }
    };
    el.addEventListener("keydown", onKeyDown, true);
    el.addEventListener("compositionstart", onCompositionStart, true);
    el.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("compositionstart", onCompositionStart, true);
      el.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, [aui, interceptSend, noModel, noModelHint, send, blocked]);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

export const Composer: FC = () => {
  // / 指令菜单（命令/技能/MCP 工具三分类）与 @ 子智能体提及，数据聚合见 composer-commands.ts
  const mention = useSubagentMention();
  const slash = useComposerSlashMenu();
  // 提问卡片与输入框互斥：Question 工具挂起期间整条 composer 让位给卡片
  // （作答/跳过 → question_answer 结算 → finish chunk 清空，composer 复原）
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 查询键必须是 sessionId：本会话新建的线程 mainThreadId 是 __LOCALID_ 草稿
  // id，拿它查挂起台账永远 miss（卡片不上屏），见 pi-interaction-session
  const interactionSessionId = useInteractionSessionId();
  const questions = usePendingQuestions(interactionSessionId);
  // 发送键：Enter / ⌘Enter 交库原生提交；其余组合 submitMode="none"，由守卫拦截
  const { sendMessage } = useShortcuts();
  const submitMode = resolveComposerSubmitMode(sendMessage);
  const interceptSend = submitMode === "none";
  // 模型不可用（没选 / 选的那个已被删）：发送入口整体关停，占位文案同步指向
  // 模型选择器（见 pi-model-gate）
  const gate = useModelGate();
  const noModel = !gate.usable;

  // 提示词优化：当前草稿交给会话模型做独立 one-shot 改写（芯片保护在
  // sidecar 表驱动还原），进行中全锁、结果回填、toast 可撤销（⌘Z 同效）
  const aui = useAui();
  const [optimizing, setOptimizing] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const prevTextRef = useRef<string | null>(null);
  const draftHasText = useAuiState((s) => s.composer.text.trim().length > 0);

  const handleOptimize = async () => {
    const draft = aui.composer.getState().text;
    if (!draft.trim() || jobIdRef.current) return;
    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    prevTextRef.current = draft;
    setOptimizing(true);
    // UI 线程 id ≠ 会话 id：本会话内新建的线程 id 恒为草稿 id（__LOCALID_…），
    // 只有刷新恢复后才相等。sidecar 要用真会话 id 才能读到会话模型真值——
    // 传草稿 id 会查不到会话、回落到全局默认模型（界面显示 A、优化却跑 B 的根因）。
    const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
    try {
      const res = await optimizePrompt({
        threadId: threadId ?? "default",
        ...(sessionId ? { sessionId } : {}),
        // 界面当前显示的模型：草稿期（会话行还不存在）sidecar 取不到会话模型，
        // 这份 hint 是让「看到的模型 = 优化用的模型」成立的唯一通道
        ...(gate.selected ? { model: gate.selected } : {}),
        jobId,
        text: draft,
      });
      // jobId 失配 = 已本地取消或被覆盖，晚到的应答作废、不回填
      if (res === "cancelled" || jobIdRef.current !== jobId) return;
      aui.composer.setText(res.text);
      focusComposer();
      toast.success({
        title: `提示词已优化`,
        // description: res.chipCount > 0 ? `${res.chipCount} 个芯片保持原样` : undefined,
        duration: 6000,
        action: {
          label: "撤销",
          onClick: () => {
            aui.composer.setText(prevTextRef.current ?? draft);
            focusComposer();
          },
        },
      });
    } catch (err) {
      if (jobIdRef.current === jobId) {
        toast.error(
          `提示词优化失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (jobIdRef.current === jobId) {
        jobIdRef.current = null;
        setOptimizing(false);
      }
    }
  };

  const handleCancelOptimize = () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    // 先作废 jobId 再解锁：后续任何应答帧都在 try 的失配检查里被丢弃
    jobIdRef.current = null;
    setOptimizing(false);
    void cancelOptimize(jobId);
  };

  if (interactionSessionId && questions.length > 0) return <QuestionCard />;

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        {/* 输入框上方四条悬浮条的间距约定：各自带
            mb-2，满宽不缩边，与输入框同宽对齐。不给父级 gap——队列条是常驻挂载、
            靠 grid-template-rows 0fr↔1fr 折叠的容器，父级 gap 会在它折叠时留下
            幽灵间距。新加悬浮条请沿用 mb-2，别再引出第三种间距 */}
        <PromptQueueBar />
        <ToolApprovalCard />
        {/* 问答档的切档提议（模型调 ask_needs_work）：与审批卡同一族——都是
            「模型在等你拍板」，所以放在同一层、用同一套卡壳与按钮样式 */}
        <AskNeedsWorkCard />
        {/* 目标常驻条：排在审批卡之后、输入区之前——它讲的是「这一轮跑得怎么样」，
            审批卡讲的是「这一轮卡在哪等你」，两者同时在场时目标态在更下面一层，
            视线自然先落在阻塞上 */}
        <GoalStrip />
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            data-optimizing={optimizing ? "true" : undefined}
           className="
    relative
    border-border/50
    focus-within:border-border/60
    dark:focus-within:border-muted-foreground/25
    data-[dragging=true]:border-ring
    flex w-full cursor-text flex-col gap-2
    rounded-(--composer-radius) border
    bg-(--composer-bg)/85
    p-(--composer-padding)
    shadow-[0_1px_8px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.03)]
    dark:shadow-[0_1px_8px_rgb(0_0_0/0.16)]
    backdrop-blur-sm backdrop-saturate-110
    transition-[border-color,background-color]
    data-[dragging=true]:border-dashed
    data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_25%,var(--color-background))]
  "
          >
            {/* 优化进行中的卡内多色晕染（三个模糊光团各自漂移，样式见 globals.css）：
                必须是 shell 首个子节点——它绝对定位垫底，后面的输入区/底栏都是
                relative 定位元素、按 DOM 顺序盖在它上面，正文因此完全不被染色 */}
            {optimizing && (
              <div aria-hidden className="aui-optimize-flow">
                <div className="aui-optimize-blob aui-optimize-blob-1" />
                <div className="aui-optimize-blob aui-optimize-blob-2" />
                <div className="aui-optimize-blob aui-optimize-blob-3" />
              </div>
            )}
            <ComposerQuotePreview />
            <ComposerAttachments />
            <ImeEnterGuard send={sendMessage} interceptSend={interceptSend} noModel={noModel} noModelHint={gate.hint} blocked={optimizing}>
            <CmComposerInput
              submitMode={submitMode}
              blocked={optimizing}
              placeholder={
                gate.hint ?? "输入任务指令 @选择智能体，/打开指令菜单"
              }
              className={`aui-composer-input relative min-h-10 w-full px-2.5 py-1 text-base leading-6 [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-editor]:max-h-48 [&_.cm-scroller]:overscroll-contain [&_.cm-scroller]:overflow-y-auto [&_.cm-placeholder]:text-sm [&_.cm-placeholder]:text-muted-foreground/60 [&_.cm-placeholder]:pointer-events-none [&_.cm-placeholder]:truncate ${directiveChipVariants}`}
            />
            </ImeEnterGuard>
            <ComposerAction
              optimizing={optimizing}
              canOptimize={draftHasText && !noModel && !optimizing}
              onOptimize={handleOptimize}
            />
            {optimizing && <PromptOptimizeOverlay onCancel={handleCancelOptimize} />}
          </div>
        </ComposerPrimitive.AttachmentDropzone>

       <div className="my-1 flex w-full items-center gap-1 px-2">
         {/* workspace 选择：仅开始对话前显示，位于输入框下方灰色条内；
             右侧为所选目录的 git 分支胶囊（非仓库静默隐藏）；
             有消息后前两者让位，改为只读工作目录胶囊
             （WorkspaceSessionPill，点击滑盖展开完整路径） */}
        <WorkspacePill />
        <WorkspaceBranchPill />
        {/* <WorkspaceSessionPill /> */}
       </div>

        <GroupedTriggerPopover
          char="@"
          {...mention}
          emptyLabel="暂无子智能体"
        />

        <GroupedTriggerPopover
          char="/"
          {...slash}
          emptyLabel="无匹配项"
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/** Codex 风格 workspace 胶囊：显示当前工作目录。
 *  点击弹出最近选择列表（最多 5 个）+ 添加按钮；悬浮显示 × 取消选中。
 *  仅空会话（尚未产生消息）时显示——产品决策（2026-09-27）：对话历史里
 *  模型引用的绝对路径按当时的目录烘焙，有消息后中途换/清目录极易把项目
 *  对话换跑偏，故不提供入口（换目录请开新对话），只读展示交给
 *  WorkspaceSessionPill。sidecar 的
 *  set_session_cwd 命令与前端换绑通道保留，若日后要放开只需去掉此门控。
 *  × 必须与菜单触发按钮**同级**：base-ui 的 Menu 在 mousedown 即打开，
 *  嵌在触发按钮里的 × 靠 click 冒泡 stopPropagation 拦不住，点"清除"
 *  会先弹出最近列表、极易误点原目录把它选回去。 */
const WorkspacePill: FC = () => {
  const workspace = useWorkspace();
  const workspaceSource = useWorkspaceSource();
  const recents = useWorkspaceRecents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);

  if (!isTauri() || hasMessages) return null;

  const clear = () => {
    clearWorkspace();
  };

  const add = async () => {
    setBusy(true);
    try {
      await openWorkspacePicker();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* 胶囊视觉在外层容器；主按钮（弹最近列表）与 ×（清除）为同级按钮 */}
      <div
        data-slot="aui-composer-workspace"
        className={cn(
          "group/pill inline-flex h-7 items-center rounded-full pr-1 text-sm transition-colors",
          workspace ? "bg-muted/50" : "bg-transparent",
          "hover:bg-muted",
        )}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              title={
                workspace
                  ? workspaceSource === "session"
                    ? `${workspace}\n跟随当前会话的工作目录（切换会话时自动同步）`
                    : workspace
                  : "选择工作目录"
              }
              aria-label="Select workspace directory"
              className="inline-flex h-full items-center gap-1 rounded-l-full pl-2.5 hover:text-foreground"
            >
              {busy ? (
                <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <FolderOpenIcon className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {workspace ? pathBasename(workspace) : "选择目录"}
              </span>
              {workspace && workspaceSource === "session" && (
                <span
                  data-slot="aui-composer-workspace-following"
                  className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground"
                >
                  跟随
                </span>
              )}
            </button>
          }
        />
        {/* × 常驻占位（display 切换会在 hover 瞬间撑宽胶囊、且无过渡）：
            平时透明缩着且不接指针，hover/键盘聚焦时淡入放大回位 */}
        {workspace && (
          <button
            type="button"
            aria-label="Clear workspace"
            title="取消选择当前目录"
            onClick={clear}
            className="hover:text-destructive pointer-events-none flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 scale-90 transition-[opacity,scale] duration-150 ease-out group-hover/pill:pointer-events-auto group-hover/pill:opacity-100 group-hover/pill:scale-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:scale-100"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <DropdownMenuContent align="start" sideOffset={0} className="w-64 p-0">
        <DropdownMenuGroup className={"p-0"}>
          {/* <DropdownMenuItem>最近使用</DropdownMenuItem> */}
          <Input className="border-0 ring-0 bg-transparent focus-visible:outline-none focus-visible:ring-0 " placeholder="搜索" />
          <DropdownMenuSeparator className={"mt-0"} />
          {/* <DropdownMenuLabel>最近使用</DropdownMenuLabel> */}
          <div className="px-1">
            {recents.length > 0 ? (
            recents.map((dir) => (
              <DropdownMenuCheckboxItem
                key={dir}
                checked={dir === workspace}
                onCheckedChange={(checked) => {
                  if (checked) setWorkspace(dir);
                }}
                // base-ui 条目只认 onClick（无 Radix 的 onSelect），选中后保持
                // 菜单展开要靠 closeOnClick=false——目录是多选式速切，收起反打断
                closeOnClick={false}
                title={dir}
              >
                <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{pathBasename(dir)}</span>
              </DropdownMenuCheckboxItem>
            ))
          ) : (
            <div className="text-muted-foreground px-2 py-3 text-center text-xs">
              暂无记录
            </div>
          )}
          </div>
        </DropdownMenuGroup>
         <DropdownMenuSeparator  />
       <div className="px-1 pb-1">
         {workspace && (
          <DropdownMenuItem onClick={clear}>
            <XIcon className="text-muted-foreground size-3.5 shrink-0" />
            取消选择
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={add} disabled={busy}>
          {busy ? (
            <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
          ) : (
            <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          添加目录…
        </DropdownMenuItem>
       </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * 有消息对话的只读工作目录胶囊（产品决策 2026-09-27）：对话开始后不提供
 * 换/清目录入口（见上方 WorkspacePill 注释），但仍需看到"这个对话在哪个
 * 目录跑"。样式贴 composer 主题：白底圆角胶囊浮在输入框下方灰条上（与
 * 截图里 ai-teamspace 胶囊同形态），点击像滑盖一样向下展开完整路径
 * （monospace 代码块质感小盒），再点收起。纯展示，无其他操作；
 * 未选目录（会话跑在任务工作区）时不显示。
 */
const WorkspaceSessionPill: FC = () => {
  const workspace = useWorkspace();
  const workspaceSource = useWorkspaceSource();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [expanded, setExpanded] = useState(false);

  if (!isTauri() || !hasMessages || !workspace) return null;

  return (
    <div
      data-slot="aui-composer-workspace-session"
      title={workspace}
      className="min-w-0 max-w-[16rem] self-start"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "bg-composer-inner hover:text-foreground text-muted-foreground",
          "inline-flex h-7 max-w-full cursor-pointer items-center gap-1",
          "rounded-full border shadow-sm transition-colors pl-2.5 pr-2 text-sm",
        )}
      >
        <FolderOpenIcon className="size-3.5 shrink-0" />
        <span className="truncate">{pathBasename(workspace)}</span>
        {workspaceSource === "session" && (
          <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
            跟随
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {/* 滑盖：向下展开完整路径（grid 行高 0fr↔1fr 过渡） */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="bg-composer-inner text-muted-foreground mt-1 break-all rounded-md border px-2.5 py-1.5 font-mono text-xs">
            {workspace}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * 所选工作目录的 git 分支胶囊（目录选择后自动读取该目录的仓库/分支）：
 * 点开为分支菜单——搜索、分支列表（当前分支带勾选与"未提交的更改：N 个文件"）、
 * 切换/创建检出、Git 图谱（展开右侧面板的 Git 标签）。
 * 非 Tauri / 非 git 仓库 / 已开始对话 / 本会话工作模式为工作时静默不渲染（与
 * WorkspacePill 同步让位；工作模式下 Git 管理整体隐藏，见顶栏模式切换器）。
 */
const WorkspaceBranchPill: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时拉分支列表（菜单低频操作，惰性加载即可）
  useEffect(() => {
    if (!open || !workspace) return;
    let alive = true;
    gitBranches(workspace)
      .then((b) => {
        if (alive && b) setBranches(b);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, workspace]);

  if (!isTauri() || appMode !== "code" || hasMessages || !workspace || !status) return null;

  const close = () => {
    setOpen(false);
    setCreating(false);
    setQuery("");
    setError(null);
  };

  const checkout = async (target: string, create: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await gitCheckout(workspace, target, create);
      close();
    } catch (err) {
      setError(`切换失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openGraph = () => {
    openPanelTab("git");
    // 面板开合是 Base 的本地态，经事件请求展开（见 base.tsx）
    window.dispatchEvent(new Event("agent-panel:open"));
    close();
  };

  const q = query.trim().toLowerCase();
  const list = (branches?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));

  return (
    <DropdownMenu open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-branch"
            title={`${workspace}\n${status.branch}${status.dirty > 0 ? ` · ${status.dirty} 个未提交变更` : ""}`}
            aria-label="Git 分支"
            className={cn(
              "bg-muted/50 hover:bg-muted hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm transition-colors",
            )}
          >
            <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="max-w-[10rem] truncate">{status.branch}</span>
            {status.dirty > 0 ? (
              <span className="bg-muted-foreground/15 shrink-0 rounded-full px-1.5 text-xs leading-4 tabular-nums">
                {status.dirty}
              </span>
            ) : null}
            <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-72 p-0">
        <div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索分支"
            className="border-0 bg-transparent text-sm focus-visible:outline-none focus-visible:ring-0"
          />
        </div>
        <DropdownMenuSeparator className={"mt-0"} />
        <DropdownMenuGroup className="p-0">
          <DropdownMenuLabel>分支</DropdownMenuLabel>
          <div className="h-52 overscroll-contain overflow-y-auto px-1">
            {list.length === 0 ? (
              <div className="text-muted-foreground px-2 py-2 text-xs">
                {branches && branches.branches.length === 0 ? "暂无分支" : "无匹配分支"}
              </div>
            ) : (
              list.map((b) => (
                <DropdownMenuItem
                  key={b.name}
                  disabled={busy || b.current}
                  onClick={() => void checkout(b.name, false)}
                  className="items-start"
                >
                  <GitBranchIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{b.name}</span>
                    {b.current && status.dirty > 0 ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        未提交的更改：{status.dirty} 个文件
                      </span>
                    ) : null}
                  </span>
                  {b.current ? (
                    <CheckIcon className="mt-1 size-3.5 shrink-0" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-1 pb-1">
          {creating ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="新分支名"
                className="h-7 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) void checkout(newName.trim(), true);
                  if (e.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={busy || !newName.trim()}
                onClick={() => void checkout(newName.trim(), true)}
              >
                检出
              </Button>
            </div>
          ) : (
            <DropdownMenuItem
              // 点开后菜单要留在原地（就地切换到分支名输入行）：base-ui 用
              // closeOnClick=false，onSelect+preventDefault 的 Radix 写法无效
              closeOnClick={false}
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
            >
              <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
              创建并检出新分支…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={openGraph}>
            <GitGraphIcon className="text-muted-foreground size-3.5 shrink-0" />
            Git 图谱
          </DropdownMenuItem>
          {error ? (
            <div className="text-destructive px-2.5 py-1.5 text-xs leading-relaxed">{error}</div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 发送/停止/撤队共用按钮（单按钮四态，同一槽位，方块⇄箭头随输入切换）：
 *  - 空闲且模型不可用：↑ 禁用（悬停说明原因，见 pi-model-gate）；
 *  - 空闲：↑ 发送（库原生 Send，沿用其禁用谓词）；
 *  - 运行中输入为空且队列有排队的消息：■ 点击=删除最近入队的一条（撤销上次
 *    发送；多条逐条删），⌥/Alt+点击=停止生成；
 *  - 运行中输入为空且队列为空：■ 停止生成；
 *  - 运行中输入有内容：↑ 点击=进发送队列（sidecar 当前轮结束后自动执行），
 *    ⌥/Alt+点击=并入当前轮（steer：注入活跃轮，不排队不中止）；
 *    键盘 Enter/⌘Enter 同提交语义，Shift+⌘/Ctrl+Enter=并入。
 *  运行中走手动 aui.composer.send({ steer }) 绕开 ComposerPrimitive.Send 的
 *  isRunning 禁用谓词；车道必须显式传（core 默认运行中并入当前轮，本应用
 *  语义相反：普通发送=排队，Alt/Shift+⌘Enter=并入） */
const AdaptiveSendButton: FC<{ blocked?: boolean }> = ({ blocked = false }) => {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const canSend = useAuiState((s) => s.composer.canSend);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const gate = useModelGate();
  const noModel = !gate.usable;
  const gateHint = gate.hint;
  // 改动（4a）：队列数据源换 react-pi state.queue（条目 id = 真实 reqId）
  const { queue, cancel: queueCancel } = usePiQueue();
  const queueItems = queue.followUp;
  // 删除请求在途标记：queue_update 回程内连点不重复发 queue_cancel
  const cancellingRef = useRef<string | null>(null);

  // 优化进行中（在遮罩之下仍渲染禁用态，透模糊可辨）：任何状态下都不发送
  if (blocked) {
    return (
      <span tabIndex={-1} className="inline-flex" aria-label="正在优化提示词">
        <button
          type="button"
          disabled
          className="aui-composer-send inline-flex size-7 items-center justify-center rounded-full bg-primary! opacity-50"
        >
          <ArrowUpIcon className="aui-composer-send-icon size-4 text-primary-foreground!" />
        </button>
      </span>
    );
  }
  if (isRunning && !canSend) {
    // 排队非空（且输入为空）：■ = 删除最近入队的排队项（撤销上次发送）
    const last = queueItems[queueItems.length - 1];
    if (last) {
      return (
        <TooltipIconButton
          tooltip={
            queueItems.length > 1
              ? `删除最近排队的消息（共 ${queueItems.length} 条）· ⌥/Alt 点击停止生成`
              : "删除排队的消息 · ⌥/Alt 点击停止生成"
          }
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="aui-composer-cancel size-7 bg-primary rounded-full hover:bg-primary/80"
          aria-label="Delete queued message"
          onClick={(e) => {
            if (e.altKey) {
              aui.composer.cancel();
              return;
            }
            if (cancellingRef.current) return;
            cancellingRef.current = last.id;
            void queueCancel(last.id).finally(() => {
              if (cancellingRef.current === last.id) cancellingRef.current = null;
            });
          }}
        >
          <div className="size-3 fill-current bg-white " />
        </TooltipIconButton>
      );
    }
    return (
      <ComposerPrimitive.Cancel asChild>
        <TooltipIconButton
          tooltip="停止生成"
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="aui-composer-cancel size-7 bg-primary rounded-full hover:bg-primary/80"
          aria-label="Stop generating"
        >
          <div className="size-3 fill-current bg-white " />
        </TooltipIconButton>
      </ComposerPrimitive.Cancel>
    );
  }
  if (isRunning) {
    return (
      <TooltipIconButton
        tooltip="发送（当前回复完成后自动排队）· ⌥/Alt 点击并入当前回复"
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full bg-primary!"
        aria-label="Send message"
        onClick={(e) => {
          // 显式车道（steer 选项）：store 暴露 queue adapter 后，不带选项的
          // 运行中发送会被 core 默认并入当前轮（message.steer ?? isRunning），
          // 排队语义必须显式声明 followUp 才能进队列、出排队条
          if (e.altKey && threadId) {
            // 已并入徽标（迁移 4a）：steer 发送即时本地记账，宿主轮流
            // 收尾时由队列栏清空（新链路 sidecar 不回传 data-steered 信号）
            const text = aui.composer.getState().text;
            if (text.trim()) addSteeredBadge(threadId, text);
            aui.composer.send({ steer: true });
            return;
          }
          aui.composer.send({ steer: false });
        }}
      >
        <ArrowUpIcon className="size-4 text-primary-foreground!" />
      </TooltipIconButton>
    );
  }
  // 空闲且模型不可用：整键禁用。禁用按钮收不到指针事件，tooltip 挂到外层可聚焦
  // span 上（不用 TooltipIconButton——它自带一层 Tooltip，嵌进来会弹两层同文案）
  if (noModel) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span tabIndex={0} className="inline-flex" aria-label={gateHint ?? undefined}>
              <button
                type="button"
                disabled
                className="aui-composer-send inline-flex size-7 items-center justify-center rounded-full bg-primary! opacity-50"
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4 text-primary-foreground!" />
              </button>
            </span>
          }
        />
        <TooltipContent side="bottom">
          <p>{gateHint}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton
        tooltip="发送消息"
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full bg-primary!"
        aria-label="Send message"
      >
        <ArrowUpIcon className="aui-composer-send-icon size-4 text-primary-foreground!" />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
  );
};


/**
 * 问答档的切档提议：模型调 ask_needs_work 后冒一条，不弹窗、不自动切。
 * 用户点「切到编码」才发 set_mode；点「忽略」只是收起提示，本轮照常继续。
 *
 * 视觉与位置都对齐审批卡（ToolApprovalCard）：两者是同一族交互——模型卡住了、
 * 要用户拍一下板才能继续。此前这条是插在输入框内部的琥珀色小条，与审批卡
 * 一个在框外一个在框内、按钮一个实心一个描边，同一种事长得像两个物种。
 */
const AskNeedsWorkCard: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const view = useAskNeedsWork(threadId);
  if (!threadId || !view) return null;

  const go = () => {
    if (!threadId) return;
    clearAskNeedsWork(threadId);
    void setSessionMode(threadId, "agent", "ask").catch((err) =>
      console.error("set_mode failed:", err),
    );
  };

  const dismiss = () => clearAskNeedsWork(threadId);

  return (
    <div
      data-slot="aui-ask-needs-work-card"
      className="border-border/60 mb-2 bg-card overflow-hidden rounded-2xl border shadow-sm"
    >
      <div className="flex items-start gap-2.5 px-4 py-2.5">
        <span className="mt-0.5 shrink-0 text-amber-500 [&_svg]:size-4">
          <ArrowRightLeftIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">这题可能要动项目</p>
          {view.reason && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              {view.reason}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3.5"
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
            忽略
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-full px-3.5"
            onClick={go}
          >
            <ArrowRightLeftIcon className="size-3.5" />
            切到编码
          </Button>
        </div>
      </div>
    </div>
  );
};

const ComposerAction: FC<{
  /** 提示词优化进行中（发送键进禁用态，全锁的视觉一部分） */
  optimizing: boolean;
  /** 优化按钮可用谓词（有草稿 && 有模型 && 不在优化中） */
  canOptimize: boolean;
  onOptimize: () => void;
}> = ({ optimizing, canOptimize, onOptimize }) => {
  // 问答档的底栏收敛：思考档与上下文用量是编码档的调参旋钮，问答场景没有
  // "这次思考强度调多少"的决策，只留模型选择器。切档即时生效，无需重启会话。
  const inAskMode = useSessionMode(useAuiState((s) => s.threads.mainThreadId)).mode === "ask";
  return (
    // flex-wrap：窄对话列（小窗口 + 右面板展开）时两组按钮各自成行，
    // 避免固有宽度撑破消息流（超长内容一律走截断，不靠横向滚动）
    // @container：本行自任容器——收成纯图标态的判据是「这条工具栏还剩多宽」，
    // 而栏宽随右面板开合/对话宽度档变化，跟窗口宽不是一回事，视口断点会判错；
    // 各按钮的文字在这个容器 < 42rem 时隐藏（@max-2xl:hidden），只留图标
    <div className="aui-composer-action-wrapper @container relative flex flex-wrap items-center justify-between gap-y-1.5">
      <div className="flex items-center gap-1">
        {/* 「+」菜单：添加文件 / 模式 / 专家 / 技能 / 连接器（左栏分类 + 右栏条目） */}
        <ComposerPlusMenu />
        <ModePicker />
        {/* 能力模式胶囊（问答/计划/目标）：非能力档不渲染，连竖线一起消失 */}
        <CapabilityModeChip />
        {/* design 档独有的会话级主题胶囊（内部自判模式，非 design 不渲染） */}
        <DesignThemePicker />
      </div>
      <div className="flex items-center gap-1.5">
        {/* 提示词优化：草稿交给会话模型 one-shot 改写后回填（技能/子智能体
            芯片原文不动，保护在 sidecar）；空草稿/无模型/进行中禁用 */}
        <TooltipIconButton
          tooltip="优化提示词（保留技能/智能体芯片）"
          side="bottom"
          type="button"
          variant="ghost"
          size="icon"
          className="aui-composer-optimize text-muted-foreground hover:text-foreground size-7 rounded-full"
          aria-label="Optimize prompt"
          disabled={!canOptimize}
          onClick={() => void onOptimize()}
        >
          <SparklesIcon className="aui-composer-optimize-icon size-4" />
        </TooltipIconButton>
        <ModelPicker />
        {/* 深度思考档位选择：模型右侧、发送按钮左侧，点开下拉选强度 */}
        {!inAskMode && <ThinkingPicker />}
        {!inAskMode && <ContextButton />}
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AdaptiveSendButton blocked={optimizing} />
      </div>
    </div>
  );
};

export const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2"
    >
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ml-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) backdrop-blur-xl">
          <CmComposerInput
            autoFocus
            className={`aui-edit-composer-input min-h-14 w-full px-4 pt-3 pb-1 text-foreground text-base outline-none [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-scroller]:overscroll-contain ${directiveChipVariants}`}
          />
          <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
            <ComposerPrimitive.Cancel asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              >
                Cancel
              </Button>
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild>
              <Button size="sm" className="h-8 rounded-full px-3.5">
                Update
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </MessagePrimitive.Root>
  );
};