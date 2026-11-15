"use client";

import { ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { GroupedTriggerPopover } from "@/components/agent-thread/composer-grouped-popover";
import { MissingReferencesBar } from "@/components/agent-thread/missing-references-bar";
import { LibraryAutoHintsBar } from "@/components/agent-thread/library-auto-hints-bar";
import {
  useComposerSlashMenu,
  useComposerMention,
} from "@/components/agent-thread/composer-commands";
import {
  CmComposerInput,
  focusComposer,
} from "@/components/agent-thread/cm-composer-input";
import { PromptOptimizeOverlay } from "@/components/agent-thread/prompt-optimize-overlay";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { directiveChipVariants } from "@/components/assistant-ui/elements/directive-text.aui";
import { ElementRefDialogHost } from "./element-ref-dialog";
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
import { useImageSupportGate } from "@/lib/pi/pi-image-gate";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import {
  CapabilityModeChip,
  ModePicker,
} from "@/components/agent-thread/mode-picker";
import { GoalStrip } from "@/components/agent-thread/goal-strip";
import { ComposerPlusMenu } from "@/components/agent-thread/composer-plus-menu";
import { DesignThemePicker } from "@/components/agent-thread/design-theme-picker";
import { ContextButton } from "@/components/agent-thread/context-button";
import { setSessionMode } from "@/lib/pi/pi-session-mode";
import {
  clearAskNeedsWork,
  useAskNeedsWork,
} from "@/lib/pi/pi-ask-needs-work";
import { PromptQueueBar } from "@/components/agent-thread/prompt-queue-bar";
import { usePiQueue } from "@/lib/pi/pi-runtime";
import { blockSendIfQueueFull } from "@/lib/pi/pi-queue-limit";
import {
  piSessionIdForThread,
} from "@/lib/pi/pi-thread-adapter";
import { cancelOptimize, optimizePrompt } from "@/lib/pi/pi-prompt-optimize";
import {
  useLibraryRefGuard,
  useMissingLibraryRefs,
} from "@/lib/workspace/library-ref-guard";
import { isRemoteWorkspace, useRemoteProjects } from "@/lib/workspace/remote-projects";
import { ToolApprovalCard } from "@/components/agent-thread/tool-approval-card";
import { QuestionCard } from "@/components/agent-thread/question-card";
import { usePendingQuestions } from "@/lib/pi/pi-question";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import { useSideChatScope } from "@/lib/side-chat/scope";
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
  FolderClosedIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitGraphIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  ServerIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { isDesktop } from "@/lib/desktop-env";
import {
  projectLabelFor,
  useProjectLabel,
} from "@/lib/projects/project-display-name";
import {
  projectDisplayName,
  projectHasPath,
  projectPrimaryPath,
  sameProjectPath,
  useProjectEntityLabel,
  useProjectRegistry,
  useProjectWorkspaceDir,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import {
  clearWorkspace,
  pathBasename,
  setWorkspace,
  useWorkspace,
  useWorkspaceProjectId,
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
import {
  addCommitToComposer,
  GitGraphDialog,
} from "@/components/agent-thread/agent-panel/git-graph";
import type { GitGraphEntry } from "@/lib/git/git";

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
  /** 当前线程草稿里有失效的资料库引用：任何发送路径都拦下 */
  hasMissingRefs: boolean;
  /** 优化进行中：Enter/Escape 全吞，自定义发送组合只拦键不发送 */
  blocked?: boolean;
  /** 排队条当前条数：队列容量守卫用（见 pi-queue-limit） */
  queueCount: number;
}> = ({
  children,
  send,
  interceptSend,
  noModel,
  noModelHint,
  hasMissingRefs,
  blocked = false,
  queueCount,
}) => {
  const t = useT();
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
        // 资料库引用失效守卫：有失效引用就不发（与 Enter / 发送按钮同一口径）
        if (aui.composer.getState().canSend && hasMissingRefs) {
          toast.error(t("chat.composer.staleRef"));
          return;
        }
        // 队列容量守卫（见 pi-queue-limit）：显式 followUp 车道会进排队，
        // 排队已满则拦下提示——sidecar 静默拒绝 + 草稿已清 = 丢一条消息。
        // 自定义绑定无 steer 分支，不涉及不占队列的并入车道
        if (
          aui.composer.getState().canSend &&
          blockSendIfQueueFull(
            aui.thread.getState().isRunning || queueCount > 0,
            queueCount,
          )
        ) {
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
  }, [aui, interceptSend, noModel, noModelHint, hasMissingRefs, send, blocked, queueCount, t]);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

export const Composer: FC = () => {
  // 划词辅助会话：composer 收敛成「输入 + 发送」——workspace/附件入口/模式与
  // 模型等选择器全部让位（模型与目录随创建继承自父会话），见 SideChatScope。
  const sideChat = useSideChatScope() != null;
  // / 指令菜单（命令/技能/MCP 工具三分类）与 @ 提及（子智能体 + 资料库），
  // 数据聚合见 composer-commands.ts
  const mention = useComposerMention();
  const slash = useComposerSlashMenu();
  // 提问卡片与输入框互斥：Question 工具挂起期间整条 composer 让位给卡片
  // （作答/跳过 → question_answer 结算 → finish chunk 清空，composer 复原）
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 队列容量守卫的数据源：排队条已满时拦截发送（ImeEnterGuard 同口径）
  const { queue: queueState } = usePiQueue();
  // 资料库引用失效守卫：草稿变化/聚焦/watcher 变更时校验，缺失引用会在
  // 输入框上方出琥珀条并拦截发送（见 library-ref-guard / MissingReferencesBar）
  const draftText = useAuiState((s) => s.composer.text);
  useLibraryRefGuard(threadId, draftText);
  // 发送拦截只看当前线程：旧线程残留的失效状态不阻塞当前对话
  const missingRefs = useMissingLibraryRefs(threadId).length > 0;
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
  // 纯文本输入模型：图片附件入口整体关停（多模态降级闭环第③道，见
  // pi-image-gate）；同步侧 validatePromptFile 同口径拒收粘贴/文件选择
  const imageGate = useImageSupportGate();

  // 提示词优化：当前草稿交给会话模型做独立 one-shot 改写（芯片保护在
  // sidecar 表驱动还原），进行中全锁、结果回填、toast 可撤销（⌘Z 同效）
  const aui = useAui();
  const t = useT();
  const [optimizing, setOptimizing] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const prevTextRef = useRef<string | null>(null);
  const draftHasText = useAuiState((s) => s.composer.text.trim().length > 0);
  // 新对话页的 @// 弹层固定向上：下方是推荐入口，向下弹会把它整块盖住；
  // 对话页保持 auto（输入框贴底时本来就只会向上翻，小窗也还有向下兜底）
  const isNewChat = useAuiState((s) => s.thread.messages.length === 0);

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
        title: t("chat.composer.optimizedToast"),
        // description: res.chipCount > 0 ? `${res.chipCount} 个芯片保持原样` : undefined,
        duration: 6000,
        action: {
          label: t("chat.composer.undo"),
          onClick: () => {
            aui.composer.setText(prevTextRef.current ?? draft);
            focusComposer();
          },
        },
      });
    } catch (err) {
      if (jobIdRef.current === jobId) {
        toast.error(
          t("chat.composer.optimizeFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
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
      {/* 元素引用详情 Dialog 宿主：浏览器面板「选择元素」插入的芯片被点击时，
          由它弹出元素详情（截图/选择器/HTML，见 lib/element-refs） */}
      <ElementRefDialogHost />
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        {/* 输入框上方四条悬浮条的间距约定：各自带
            mb-2，满宽不缩边，与输入框同宽对齐。不给父级 gap——队列条是常驻挂载、
            靠 grid-template-rows 0fr↔1fr 折叠的容器，父级 gap 会在它折叠时留下
            幽灵间距。新加悬浮条请沿用 mb-2，别再引出第三种间距。
            层级约定：根元素必须 relative z-10——队列条的连体灰背板是定位元素，
            非定位的兄弟条会被它盖住顶边（composer 卡同样 z-10） */}
        <PromptQueueBar />
        <MissingReferencesBar />
        <ToolApprovalCard />
        {/* 问答档的切档提议（模型调 ask_needs_work）：与审批卡同一族——都是
            「模型在等你拍板」，所以放在同一层、用同一套卡壳与按钮样式 */}
        <AskNeedsWorkCard />
        {/* 目标常驻条：排在审批卡之后、输入区之前——它讲的是「这一轮跑得怎么样」，
            审批卡讲的是「这一轮卡在哪等你」，两者同时在场时目标态在更下面一层，
            视线自然先落在阻塞上 */}
        <GoalStrip />
        <ComposerPrimitive.AttachmentDropzone
          asChild
          disabled={!imageGate.canAttachImages}
        >
          {/* 单层玻璃卡（全态同款）：border + --composer-bg/85 + 毛玻璃，欢迎页
              （空会话）与有消息后不再分两套皮。卡底透出下面的内容才是对的，
              实心面板/灰壳会把消息流与问候区切出一条硬边。
              拖拽/聚焦的描边反馈都落在这张卡上 */}
          <div
            data-slot="aui_composer-shell"
            data-optimizing={optimizing ? "true" : undefined}
            className={cn(
              // z-10：底栏灰带向上垫到卡片圆角后面（见下方 footer 的 -mt），
              // 卡片必须盖在灰带上，圆角缺口里透出的才是灰而不是被灰盖住
              "relative z-10 flex w-full cursor-text flex-col rounded-(--composer-radius) transition-[border-color,background-color,box-shadow]",
              "shadow-[0_1px_8px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.03)] dark:shadow-[0_1px_8px_rgb(0_0_0/0.16)]",
              "gap-2 border border-border/50 bg-(--composer-bg)/85 p-(--composer-padding) backdrop-blur-sm backdrop-saturate-110 focus-within:border-border/60 dark:focus-within:border-muted-foreground/25 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_25%,var(--color-background))]",
            )}
          >
            {/* 内层面板：display:contents，盒子不生成，正文照旧归外壳的 flex/gap 排。
                但圆角要留着：优化遮罩与光团是 border-radius: inherit，从面板取，取到 0
                会在卡片圆角处切出直角 */}
            <div
              data-slot="aui_composer-panel"
              className="contents rounded-(--composer-radius)"
            >
              {/* 优化进行中的卡内多色晕染（三个模糊光团各自漂移，样式见 globals.css）：
                  必须是面板首个子节点——它绝对定位垫底，后面的输入区/底栏都是
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
              <LibraryAutoHintsBar hidden={optimizing} />
              <ImeEnterGuard
                send={sendMessage}
                interceptSend={interceptSend}
                noModel={noModel}
                noModelHint={gate.hint}
                hasMissingRefs={missingRefs}
                blocked={optimizing}
                queueCount={queueState.followUp.length}
              >
              <CmComposerInput
                submitMode={submitMode}
                blocked={optimizing}
                queueGuard
                recallHistory
                placeholder={
                  sideChat
                    ? t("chat.composer.followUpPlaceholder")
                    : (gate.hint ?? t("chat.composer.mainPlaceholder"))
                }
                className={`aui-composer-input relative min-h-10 w-full px-2.5 py-1 text-base leading-6 [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-editor]:max-h-48 [&_.cm-scroller]:overscroll-contain [&_.cm-scroller]:overflow-y-auto [&_.cm-placeholder]:text-sm [&_.cm-placeholder]:text-muted-foreground [&_.cm-placeholder]:pointer-events-none [&_.cm-placeholder]:truncate ${directiveChipVariants}`}
              />
              </ImeEnterGuard>
              <ComposerAction
                optimizing={optimizing}
                canOptimize={draftHasText && !noModel && !optimizing}
                onOptimize={handleOptimize}
              />
              {optimizing && <PromptOptimizeOverlay onCancel={handleCancelOptimize} />}
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
        {/* 工作目录 / 分支底栏：卡片正下方的一条同宽浅灰带，下缘跟卡片同圆角
            （参考设计：白输入卡 + 灰底「选择文件夹」条）。谁在哪个目录里跑是
            这一轮的运行上下文、不是输入内容，所以仍挂在卡片外面，只是视觉上
            贴成一张卡的下沿。-mt-6 把灰带顶端垫进卡片底部 24px（= 卡片圆角），
            卡片 z-10 盖在上面，圆角缺口里透出灰带而不是白底；pt-8 里除这 24px
            外还留 8px 的空隙，目录行不贴着卡片底边。empty:hidden：两个胶囊都
            让位时（已有消息 / 网页端）整条灰带连高度一起消失，不给 composer
            留幽灵空隙。目录与分支都只在开聊前的空会话显示；对话页整条不出现 */}
        {sideChat ? null : (
          <div
            data-slot="aui-composer-footer"
            className={cn(
              "empty:hidden relative -mt-4 flex w-full items-center gap-1",
              "rounded-b-(--composer-radius) bg-muted/55 px-3 pt-6 pb-2.5",
              "transition-colors",
            )}
          >
            <WorkspacePill />
            <WorkspaceBranchPill />
            {/* 开聊后底栏整条让位（WorkspaceSessionPill 只作备用实现保留） */}
            {/* <WorkspaceSessionPill /> */}
          </div>
        )}

        {/* 触发弹层与输入卡同宽：它挂在整张卡下沿，窄于卡片会像飘出来的
            悬浮块，而不是输入框的延伸 */}
        <GroupedTriggerPopover
          char="@"
          {...mention}
          emptyLabel={t("chat.composer.agentEmpty")}
          placement={isNewChat ? "up" : "auto"}
          className="w-full"
        />

        <GroupedTriggerPopover
          char="/"
          {...slash}
          emptyLabel={t("chat.composer.noMatch")}
          placement={isNewChat ? "up" : "auto"}
          className="w-full"
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
  const t = useT();
  const aui = useAui();
  const workspace = useWorkspace();
  const workspaceSource = useWorkspaceSource();
  const workspaceLabel = useProjectLabel(workspace);
  // 胶囊标签：项目实体名优先（附加目录里的会话 cwd 不是 primary，
  // 只按 cwd 查 localStorage 会显示成子目录名）
  const workspaceProjectId = useWorkspaceProjectId();
  const entityLabel = useProjectEntityLabel(workspaceProjectId);
  const registryProjects = useProjectRegistry();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 远程项目显式入口：本地工作区只列项目主目录，远程项目按名单列
  const { projects: remoteProjects } = useRemoteProjects();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);

  if (!isDesktop() || hasMessages) return null;

  // 列出全部工作区（项目主目录），不再是"最近用过的最多 5 条"：
  // 搜索框在下方菜单里对名称/路径做过滤，项目再多也能直接定位。
  // 已从侧栏移除的项目不再出现在选择器里；但当前正在用的项目要保留一行，
  // 否则胶囊会退回成裸目录、无法识别自己属于哪个工作区。
  const activeProjects = registryProjects.filter(
    (project) =>
      !project.archived &&
      (!project.hiddenFromSidebar || project.id === workspaceProjectId),
  );
  const findProjectForDir = (dir: string) => {
    const byPrimary = activeProjects.find((project) =>
      sameProjectPath(projectPrimaryPath(project), dir),
    );
    if (byPrimary) return byPrimary;
    const hits = activeProjects.filter((project) =>
      projectHasPath(project, dir),
    );
    return hits.length === 1 ? hits[0] : undefined;
  };
  const entryFor = (
    dir: string,
    projectOverride?: ProjectRecord,
  ): {
    key: string;
    path: string;
    projectId?: string;
    label: string;
    hint: string;
  } => {
    const project = projectOverride ?? findProjectForDir(dir);
    const isPrimary = project
      ? sameProjectPath(projectPrimaryPath(project), dir)
      : false;
    return {
      key: `${project?.id ?? "dir"}:${dir}`,
      path: dir,
      ...(project ? { projectId: project.id } : {}),
      // 附加目录：显示目录自己的名字，右侧标所属项目；主目录：显示项目名，
      // 右侧标父目录/文件夹。避免两条历史都显示成同一个项目名。
      label: project
        ? isPrimary
          ? projectDisplayName(project)
          : pathBasename(dir)
        : projectLabelFor(dir),
      hint:
        project && !isPrimary
          ? projectDisplayName(project)
          : dir.split(/[\\/]/u).filter(Boolean).slice(-2).join("/"),
    };
  };
  // 全部工作区 = 每个项目的主目录一行（附加目录归在同一项目下，不单列）
  const workspaceEntries = activeProjects.map((project) =>
    entryFor(projectPrimaryPath(project), project),
  );
  // 当前工作区可能来自会话同步或历史目录（不属于任何项目）：补在顶部，
  // 保证菜单里有勾选行
  if (
    workspace &&
    !workspaceEntries.some((entry) => sameProjectPath(entry.path, workspace))
  ) {
    const currentProject = workspaceProjectId
      ? activeProjects.find((project) => project.id === workspaceProjectId)
      : undefined;
    workspaceEntries.unshift(entryFor(workspace, currentProject));
  }
  const needle = query.trim().toLocaleLowerCase();
  const matchesQuery = (label: string, path: string): boolean =>
    !needle ||
    label.toLocaleLowerCase().includes(needle) ||
    path.toLocaleLowerCase().includes(needle);
  const visibleWorkspaces = workspaceEntries.filter((entry) =>
    matchesQuery(entry.label, entry.path),
  );
  // 远程项目并入同一列表：远程行带 SSH 徽标，不再单独分组（顶部独立分组
  // 会把搜索框顶到中间，且「远程/本地」两段清单重复渲染同一个项目名）。
  const visibleRemoteProjects = remoteProjects.filter((project) =>
    matchesQuery(project.name, project.remotePath),
  );

  const clear = () => {
    clearWorkspace();
  };

  const add = () => {
    setOpen(false);
    setCreateOpen(true);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      {/* 胶囊视觉在外层容器；主按钮（弹最近列表）与 ×（清除）为同级按钮。
          hover 时 × 直接顶到文件夹图标的位置（图标让位、文字不动），不把叉
          吊在名字后面：目录名长短不一时叉会跟着名字飘，还容易被读成名字的
          一部分；钉在图标格上位置恒定，也顺手把「这是可清除的目录」落在同一处 */}
      <div
        data-slot="aui-composer-workspace"
        className={cn(
          // 灰底栏里不再套自己的胶囊底：整条 footer 就是底，这里只是一行
          // 「图标 + 目录名」的点击区，hover 用极淡的前景叠加
          "group/pill relative inline-flex h-6 items-center rounded-lg pl-1.5 pr-1 text-sm text-foreground/90 transition-colors",
          "hover:bg-foreground/[0.04]",
        )}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              title={
                workspace
                  ? workspaceSource === "session"
                    ? `${workspace}\n${t("chat.composer.workspaceFollow")}`
                    : workspace
                  : t("chat.composer.pickWorkspace")
              }
              aria-label={t("chat.composer.pickWorkspace")}
              className="inline-flex h-full items-center gap-2 rounded-l-lg pl-0 hover:text-foreground"
            >
              <FolderClosedIcon
                className={cn(
                  "size-3.5 shrink-0",
                  workspace && "group-hover/pill:invisible",
                )}
              />
              <span className="truncate">
                {workspace
                  ? (entityLabel ?? workspaceLabel ?? pathBasename(workspace))
                  : t("chat.composer.pickDirectory")}
              </span>
              {workspace && isRemoteWorkspace(workspace) && (
                <span
                  data-slot="aui-composer-workspace-remote"
                  className="rounded bg-emerald-500/10 px-1 text-2xs text-emerald-600 dark:text-emerald-400"
                >
                  {t("chat.composer.remote")}
                </span>
              )}
              {workspace && workspaceSource === "session" && (
                <span
                  data-slot="aui-composer-workspace-following"
                  className="rounded bg-muted px-1 text-2xs text-muted-foreground"
                >
                  {t("chat.composer.follow")}
                </span>
              )}
            </button>
          }
        />
        {/* × 占住文件夹图标那一格（参考设计：浅灰圆形徽标 + 灰叉）：绝对定位
            在图标中心，图标只做 visibility 隐藏，行内宽度不变，悬停时文字不跳。
            平时不接指针，免得看不见的叉吃掉「点图标打开最近目录」的那一下 */}
        {workspace && (
          <button
            type="button"
            aria-label={t("chat.composer.clearWorkspace")}
            title={t("chat.composer.clearWorkspaceTitle")}
            onClick={clear}
            className="bg-muted-foreground/15 text-muted-foreground/70 hover:bg-muted-foreground/25 hover:text-foreground pointer-events-none absolute left-1 top-1/2 z-10 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full opacity-0 transition-[opacity,background-color,color] duration-150 ease-out group-hover/pill:pointer-events-auto group-hover/pill:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
      <DropdownMenuContent align="start" sideOffset={0} className="w-[21rem] p-0">
        <DropdownMenuGroup className={"p-0"}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-0 ring-0 bg-transparent focus-visible:outline-none focus-visible:ring-0 "
            placeholder={t("chat.composer.search")}
          />
          <DropdownMenuSeparator className={"mt-0"} />
          <div className="px-1">
            {visibleWorkspaces.length > 0 || visibleRemoteProjects.length > 0 ? (
              visibleWorkspaces.map((entry) => {
                const active = sameProjectPath(entry.path, workspace ?? "");
                return (
                  <DropdownMenuItem
                    key={entry.key}
                    // base-ui 条目只认 onClick（无 Radix 的 onSelect），选中后保持
                    // 菜单展开要靠 closeOnClick=false——工作空间是多选式速切，收起反打断
                    closeOnClick={false}
                    title={entry.path}
                    onClick={() =>
                      setWorkspace(
                        entry.path,
                        "user",
                        entry.projectId ?? null,
                      )
                    }
                    // 用普通菜单项而不是 CheckboxItem：后者给右侧勾选标记固定
                    // 预留 pr-8，没勾时右侧永远空一块。这里把当前项的勾画在
                    // 文字前，路径列自然铺满。
                    className="gap-2 pe-2"
                  >
                    {active ? (
                      <CheckIcon className="text-primary size-3.5 shrink-0" />
                    ) : (
                      <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {entry.label}
                    </span>
                    <span className="text-muted-foreground max-w-40 min-w-0 shrink-0 truncate text-end font-mono text-3xs">
                      {entry.hint}
                    </span>
                  </DropdownMenuItem>
                );
              })
            ) : visibleRemoteProjects.length === 0 ? (
              <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                {t("chat.composer.noHistory")}
              </div>
            ) : null}
            {/* 远程项目并入同一列表（顶部不再单列「远程项目」分组）：远程行用
            Server 图标 + SSH 徽标区分，语义与本地项目一致（点击切工作区）。
            右侧列远端路径，与本地行的父目录提示同列对齐。 */}
            {visibleRemoteProjects.map((project) => {
              const active = sameProjectPath(project.remotePath, workspace ?? "");
              return (
                <DropdownMenuItem
                  key={project.id}
                  closeOnClick={false}
                  title={project.remotePath}
                  onClick={() => setWorkspace(project.remotePath)}
                  className="gap-2 pe-2"
                >
                  {active ? (
                    <CheckIcon className="text-primary size-3.5 shrink-0" />
                  ) : (
                    <ServerIcon className="size-3.5 shrink-0 text-emerald-600" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="rounded bg-emerald-500/10 px-1 text-2xs text-emerald-600 dark:text-emerald-400">
                    {t("chat.composer.remote")}
                  </span>
                  <span className="text-muted-foreground max-w-40 min-w-0 shrink-0 truncate text-end font-mono text-3xs">
                    {project.remotePath}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </div>
        </DropdownMenuGroup>
         <DropdownMenuSeparator  />
       <div className="px-1 pb-1">
         {workspace && (
          <DropdownMenuItem onClick={clear}>
            <XIcon className="text-muted-foreground size-3.5 shrink-0" />
            {t("chat.composer.deselect")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={add}>
          <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
          {t("chat.composer.newWorkspace")}
        </DropdownMenuItem>
       </div>
      </DropdownMenuContent>
      <WorkspaceCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        // 主目录被占用时的快捷入口：切到占用工作空间后立即开新对话
        //（createThread 会带 projectId，sidecar 侧同时唤回移除/归档的项目）
        onOpenExistingProject={() => {
          void aui.threads.switchToNewThread();
        }}
      />
    </DropdownMenu>
  );
};

/**
 * 有消息对话的只读工作目录胶囊（产品决策 2026-09-27）：对话开始后不提供
 * 换/清目录入口（见上方 WorkspacePill 注释），但仍需看到"这个对话在哪个
 * 目录跑"。视觉与 WorkspacePill 同一套：灰底栏里一行「图标 + 目录名」，
 * 不再套自己的白底/描边胶囊；点击像滑盖一样向下展开完整路径
 * （monospace 代码块质感小盒），再点收起。纯展示，无其他操作；
 * 未选目录（会话跑在任务工作区）时不显示。
 */
const WorkspaceSessionPill: FC = () => {
  const workspace = useWorkspace();
  const workspaceSource = useWorkspaceSource();
  const workspaceLabel = useProjectLabel(workspace);
  const workspaceProjectId = useWorkspaceProjectId();
  const entityLabel = useProjectEntityLabel(workspaceProjectId);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [expanded, setExpanded] = useState(false);

  if (!isDesktop() || !hasMessages || !workspace) return null;

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
          "text-foreground/90 hover:bg-foreground/5 hover:text-foreground",
          "inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5",
          "rounded-lg pl-0 pr-1 text-sm transition-colors",
        )}
      >
        <FolderOpenIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {entityLabel ?? workspaceLabel ?? pathBasename(workspace)}
        </span>
        {isRemoteWorkspace(workspace) && (
          <span className="rounded bg-emerald-500/10 px-1 text-2xs text-emerald-600 dark:text-emerald-400">
            远程
          </span>
        )}
        {workspaceSource === "session" && (
          <span className="rounded bg-muted px-1 text-2xs text-muted-foreground">
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
          <div className="bg-background/70 text-muted-foreground border-border/40 mt-1 break-all rounded-md border px-2.5 py-1.5 font-mono text-xs">
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
 * 切换/创建检出、Git 图谱（就地弹窗查看提交图谱，不开右侧面板）。
 * 非 桌面壳 / 非 git 仓库 / 已开始对话 / 非编码模式时静默不渲染：Git 管理
 * 其他入口（面板 Git 标签、检查点卡、标题栏分支徽章）都只在编码档开放，
 * 这里跟着同一口径，避免设计/工作模式下点开一个进不去的分支菜单。
 * 底栏本身只在开聊前的空会话显示，对话页不占位。
 */
const WorkspaceBranchPill: FC = () => {
  const t = useT();
  // 分支属于项目主目录：会话 cwd 在附加目录时，分支胶囊仍读主目录，
  // 避免“工作区显示项目名、分支却按附加目录消失”的不一致。
  const workspace = useProjectWorkspaceDir();
  const { status } = useGitStatus(workspace);
  const appMode = useCurrentAppMode();
  const aui = useAui();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Git 图谱就地弹窗：新对话里只为看一眼提交图，不值得把整块右侧面板拉开
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphPending, setGraphPending] = useState(false);

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

  if (!isDesktop() || appMode !== "code" || hasMessages || !workspace || !status) return null;

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
      setError(t("chat.composer.switchFailed", { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const openGraph = () => {
    setGraphPending(true);
    close();
  };

  /** 把选中的提交以引用芯片插进输入框（发送时展开成一行提交描述） */
  const addCommitToContext = (entry: GitGraphEntry) =>
    addCommitToComposer(aui, entry);

  const q = query.trim().toLowerCase();
  const list = (branches?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : close())}
      // 菜单完全收起（含焦点归还）后再开弹窗：否则菜单关闭时会把焦点抢回触发器
      onOpenChangeComplete={(o) => {
        if (!o && graphPending) {
          setGraphPending(false);
          setGraphOpen(true);
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-branch"
            title={`${workspace}\n${status.branch}${status.dirty > 0 ? ` · ${t("chat.composer.uncommittedChanges", { count: status.dirty })}` : ""}`}
            aria-label={t("chat.composer.branch")}
            className={cn(
              // 紧跟在目录胶囊右边（不要 ml-auto：分支是目录的属性，不是
              // 底栏另一端的信息；一左一右会让人以为两者没关系）
              "bg-muted/50 hover:bg-foreground/[0.04] hover:text-foreground inline-flex h-6 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm transition-colors",
            )}
          >
            <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="max-w-[10rem] truncate">{status.branch}</span>
            {status.dirty > 0 ? (
              <span className="bg-muted-foreground/15 shrink-0 rounded-lg px-1.5 text-xs leading-4 tabular-nums">
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
            placeholder={t("chat.composer.searchBranches")}
            className="border-0 bg-transparent text-sm focus-visible:outline-none focus-visible:ring-0"
          />
        </div>
        <DropdownMenuSeparator className={"mt-0"} />
        <DropdownMenuGroup className="p-0">
          <DropdownMenuLabel>{t("chat.composer.branchLabel")}</DropdownMenuLabel>
          <div className="h-52 overscroll-contain overflow-y-auto px-1">
            {list.length === 0 ? (
              <div className="text-muted-foreground px-2 py-2 text-xs">
                {branches && branches.branches.length === 0
                  ? t("chat.composer.noBranches")
                  : t("chat.composer.noBranchMatch")}
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
                        {t("chat.composer.dirtyFiles", { count: status.dirty })}
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
                placeholder={t("chat.composer.newBranchPlaceholder")}
                className="h-7 text-sm"
                onKeyDown={(e) => {
                  // IME 组合中：回车是确认候选词，不是提交
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
                {t("chat.composer.checkout")}
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
            {t("chat.composer.gitGraph")}
          </DropdownMenuItem>
          {error ? (
            <div className="text-destructive px-2.5 py-1.5 text-xs leading-relaxed">{error}</div>
          ) : null}
        </div>
      </DropdownMenuContent>

      {/* 图谱弹窗：菜单只负责入口，图谱在独立窗口里看（表格式列表 + 选中提交详情） */}
      <GitGraphDialog
        cwd={workspace}
        branch={status.branch}
        open={graphOpen}
        onOpenChange={setGraphOpen}
        onAddToContext={addCommitToContext}
      />
    </DropdownMenu>
  );
};

/** 发送/停止/撤队共用按钮（单按钮四态，同一槽位，方块⇄箭头随输入切换）：
 *  - 空闲且模型不可用：↑ 禁用（悬停说明原因，见 pi-model-gate）；
 *  - 空闲：↑ 发送（库原生 Send，沿用其禁用谓词）；
 *  - 运行中输入为空：■ 停止生成——**永远**是停止，不再按队列是否非空改语义。
 *    停止 = 中止本轮；排队项保留并暂停自动派发（2026-11-13 对齐 ZCode：
 *    sidecar 收尾置 pauseReason="stopped"，见 usePiRuntime.onCancel），用户
 *    点队列条的「继续排队发送」再派发。这里不再兼职「删除最近入队的消息」：队列
 *    非空时把 ■ 变成删除键，用户按"暂停"只会把排队消息悄悄丢掉、还得
 *    再点一次才真停（2026-10-05 反馈）；丢弃单条走队列条上的 ✕（逐项
 *    删除），语义各自单一；
 *  - 运行中输入有内容：↑ 点击=进发送队列（sidecar 当前轮结束后自动执行），
 *    ⌥/Alt+点击=并入当前轮（steer：注入活跃轮，不排队不中止）；
 *    键盘 Enter/⌘Enter 同提交语义，Shift+⌘/Ctrl+Enter=并入。
 *  运行中走手动 aui.composer.send({ steer }) 绕开 ComposerPrimitive.Send 的
 *  isRunning 禁用谓词；车道必须显式传（core 默认运行中并入当前轮，本应用
 *  语义相反：普通发送=排队，Alt/Shift+⌘Enter=并入） */
const AdaptiveSendButton: FC<{ blocked?: boolean }> = ({ blocked = false }) => {
  const aui = useAui();
  const t = useT();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const canSend = useAuiState((s) => s.composer.canSend);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const gate = useModelGate();
  const noModel = !gate.usable;
  const gateHint = gate.hint;
  // 资料库引用失效守卫：有失效引用（上方琥珀条）就拦下点击，bar 里一键移除
  const missingRefs = useMissingLibraryRefs(threadId);
  const hasMissingRefs = missingRefs.length > 0;
  // 改动（4a）：队列数据源换 react-pi state.queue（条目 id = 真实 reqId）
  const { queue } = usePiQueue();
  const queueItems = queue.followUp;

  // 优化进行中（在遮罩之下仍渲染禁用态，透模糊可辨）：任何状态下都不发送
  if (blocked) {
    return (
      <span tabIndex={-1} className="inline-flex" aria-label={t("chat.composer.optimizingAria")}>
        <button
          type="button"
          disabled
          className="aui-composer-send inline-flex size-8 items-center justify-center rounded-lg bg-primary! opacity-50"
        >
          <ArrowUpIcon className="aui-composer-send-icon size-4 text-primary-foreground!" />
        </button>
      </span>
    );
  }
  if (isRunning && !canSend) {
    return (
      <ComposerPrimitive.Cancel asChild>
        <TooltipIconButton
          tooltip={
            queueItems.length > 0
              ? t("chat.composer.stopWithQueue")
              : t("chat.composer.stop")
          }
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="aui-composer-cancel size-8 bg-primary rounded-lg hover:bg-primary/80"
          aria-label={t("chat.composer.stop")}
        >
          <div className="size-3 fill-current bg-white " />
        </TooltipIconButton>
      </ComposerPrimitive.Cancel>
    );
  }
  if (isRunning) {
    return (
      <TooltipIconButton
        tooltip={t("chat.composer.sendQueued")}
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-8 rounded-lg bg-primary!"
        aria-label={t("chat.composer.send")}
        onClick={(e) => {
          // 资料库引用失效守卫：有失效引用就不发（与 Enter 路径同一口径）
          if (hasMissingRefs) {
            toast.error(t("chat.composer.staleRef"));
            return;
          }
          // 显式车道（steer 选项）：store 暴露 queue adapter 后，不带选项的
          // 运行中发送会被 core 默认并入当前轮（message.steer ?? isRunning），
          // 排队语义必须显式声明 followUp 才能进队列、出排队条
          if (e.altKey && threadId) {
            // 显式 steer 车道（v3.1 清理：并入成功的反馈由队列条目消失承担，
            // 「已并入」徽标记账已随 pi-steer-intent 模块删除）；
            // 并入不占队列容量——但仅当真有活跃轮可并入（运行中）。空闲时
            // Alt+点击会落回普通排队路径（sidecar steer 落空降级排队），
            // 队列已满同样静默丢，一并守卫
            if (
              blockSendIfQueueFull(
                !isRunning && queueItems.length > 0,
                queueItems.length,
              )
            ) {
              return;
            }
            aui.composer.send({ steer: true });
            return;
          }
          // 队列容量守卫（见 pi-queue-limit）：运行中点击 = 进排队车道，
          // 排队已满则拦下提示（sidecar 静默拒绝 + 草稿已清 = 丢一条消息）
          if (blockSendIfQueueFull(true, queueItems.length)) {
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
                className="aui-composer-send inline-flex size-8 items-center justify-center rounded-lg bg-primary! opacity-50"
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
    // 空闲分支：库原生 Send。排队区非空（暂停/孤儿队列）时此刻发送会进
    // 排队车道——已满则 preventDefault 拦下（Radix composeEventHandlers 先跑
    // 消费者 onClick 并检查 defaultPrevented，命中即跳过库的 send 回调），
    // 草稿保留
    <ComposerPrimitive.Send
      asChild
      onClick={(e) => {
        if (blockSendIfQueueFull(queueItems.length > 0, queueItems.length)) {
          e.preventDefault();
        }
      }}
    >
      <TooltipIconButton
        tooltip={hasMissingRefs ? t("chat.composer.staleRef") : t("chat.composer.send")}
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        disabled={hasMissingRefs}
        className="aui-composer-send size-8 rounded-lg bg-primary!"
        aria-label={t("chat.composer.send")}
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
  const t = useT();
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
      className="border-border/60 relative z-10 mb-2 bg-card overflow-hidden rounded-2xl border shadow-sm"
    >
      <div className="flex items-start gap-2.5 px-4 py-2.5">
        <span className="mt-0.5 shrink-0 text-amber-500 [&_svg]:size-4">
          <ArrowRightLeftIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("chat.composer.questionTitle")}</p>
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
            className="h-8 rounded-lg px-3.5"
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
            {t("chat.composer.ignore")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-lg px-3.5"
            onClick={go}
          >
            <ArrowRightLeftIcon className="size-3.5" />
            {t("chat.composer.switchToCode")}
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
  const t = useT();
  // 问答档底栏保持模型/思考档全量：档位与模式正交（sidecar 切档只换
  // system/tools，不改 thinkingLevel），隐藏入口只会让用户以为不能调。
  // 划词辅助会话：目录/附件入口让位（随创建继承）；权限胶囊与模型/思考/上下文
  // 读数保留——E 副屏同款。ModePicker 的下拉只含权限五档（能力模式不在
  // 其中），切档发 set_mode{mode:当前档, approvalLevel}，副屏守卫（仅 agent/ask）
  // 天然放行；plan/goal 的入口仍不存在，服务端守卫兜底。
  const sideChat = useSideChatScope() != null;
  return (
    // flex-wrap：窄对话列（小窗口 + 右面板展开）时两组按钮各自成行，
    // 避免固有宽度撑破消息流（超长内容一律走截断，不靠横向滚动）
    // @container：本行自任容器——收成纯图标态的判据是「这条工具栏还剩多宽」，
    // 而栏宽随右面板开合/对话宽度档变化，跟窗口宽不是一回事，视口断点会判错；
    // 各按钮的文字在这个容器 < 42rem 时隐藏（@max-2xl:hidden），只留图标
    <div className="aui-composer-action-wrapper @container relative flex flex-wrap items-center justify-between gap-y-1.5">
      <div className="flex items-center gap-1">
        {sideChat ? (
          // 副屏：只留权限胶囊（变更前确认～完全访问）——下拉只有权限五档，
          // 能力模式（问答/计划/目标）不在其中，切档对副屏就是改「问不问」；
          // 全局 Shift+Tab 循环关闭：主会话同一监听也在跑，双实例会互相串台
          <ModePicker enableCycleShortcut={false} />
        ) : (
          <>
            {/* 「+」菜单：添加文件 / 优化提示词 / 模式 / 专家 / 技能 / 连接器
                （左栏分类 + 右栏条目；优化是直接动作，与附件同组） */}
            <ComposerPlusMenu
              canOptimize={canOptimize}
              optimizing={optimizing}
              onOptimize={onOptimize}
            />
            <ModePicker />
            {/* 能力模式胶囊（问答/计划/目标）：非能力档不渲染，连竖线一起消失 */}
            <CapabilityModeChip />
            {/* design 档独有的会话级主题胶囊（内部自判模式，非 design 不渲染） */}
            <DesignThemePicker />
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {/* 上下文占用读数：副屏保留——它回答的就是「这份继承上下文还剩多少」 */}
        <ContextButton />
        {/* 模型在副屏可见可切：创建时继承父会话的选择，切档定靶只落子会话。
            思考强度已并入模型选择面板底部（两级菜单，对齐 ZCode 的合并选择器）；
            各能力档都显示（档位与模式正交，见上方注释） */}
        <ModelPicker />
        {sideChat ? null : (
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-8 rounded-lg"
                aria-label={t("chat.composer.voiceInput")}
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
                className="aui-composer-stop-dictation text-destructive size-8 rounded-lg"
                aria-label={t("chat.composer.stopVoiceInput")}
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        )}
        <AdaptiveSendButton blocked={optimizing} />
      </div>
    </div>
  );
};

export const EditComposer: FC = () => {
  const t = useT();
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
                className="h-8 rounded-lg px-3.5"
              >
                {t("common.action.cancel")}
              </Button>
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild>
              <Button size="sm" className="h-8 rounded-lg px-3.5">
                {t("common.action.save")}
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </MessagePrimitive.Root>
  );
};