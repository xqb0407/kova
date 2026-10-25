"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { SelectionToolbar } from "@/components/assistant-ui/elements/quote.aui";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  type AssistantState,
  ThreadPrimitive,
  BranchPickerPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { memo, useEffect, type FC } from "react";

// Import other components
import { ThreadWelcome } from "./thread-welcome";
import { ThreadSuggestions } from "./thread-suggestions";
import { Composer, EditComposer } from "./composer";
import { AssistantMessage, WaitingRow } from "./assistant-message";
import { CompactionDataUI, ManualCompactionTailAfter } from "./compaction-banner";
import { ModelChangeDataUI } from "./model-change-banner";
import { ImageDataUI } from "@/components/assistant-ui/elements/image-data";
import { UserMessage } from "./user-message";
import { BranchPicker } from "./branch-picker";
import { CheckpointTail } from "./checkpoint-card";
import { ShareSelectionToolbar } from "./share/share-selection-bar";
import { ThreadPreviewRail } from "./thread-preview-rail";
import { ThreadFind, highlightMessageBySeq } from "./thread-find";
import {
  isIntentFresh,
  peekThreadNavigateIntent,
  takeThreadNavigateIntent,
} from "@/lib/pi/pi-thread-navigate";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { ThreadViewport } from "./thread-viewport";
import { TurnSlot, TurnTimingRecorder } from "./turn-summary";
import { ViewportScrollManager } from "./viewport-scroll-manager";
import { prewarmShiki } from "@/lib/markdown/prewarm-shiki";
import { RenderProbe } from "@/components/debug/render-probe";
import { noteFact } from "@/components/debug/perf-store";
import { useShareState } from "@/lib/share/share-store";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
export const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
export const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom shadow-md border dark:border-border bg-background dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon className="size-4 shrink-0 text-foreground" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** turn 间隙等待动画：thread 在跑、末条是 user 消息、但 AI 回复消息尚未
 *  创建（新回复首 token 前的空窗）时，消息级 indicator 无处挂载——AI 回复
 *  消息要等首个内容块才创建——这里在列表末尾补点阵动画。 */const ThreadWorkingIndicator: FC = () => {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastRole = useAuiState((s) => s.thread.messages.at(-1)?.role);
  if (lastRole !== "user" || !isRunning) {
    return null;
  }
  return (
    <div
      data-slot="aui-thread-working-indicator"
      // 与回复消息内的等待行/思考触发行同高同左边界（见 WaitingRow 注释）：
      // 这行会被消息级占位原地替换，任何尺寸差都表现为「连接中」上下跳一下
      className="mx-auto flex w-full max-w-(--thread-max-width) items-center px-2"
    >
      <WaitingRow />
    </div>
  );
};

/**
 * memo：Base 的任何状态翻转（侧边栏开合、面板开合/全屏动画的冻结位等）都
 * 不再牵连整棵消息列表重渲染——此前每点一次侧边栏，所有消息组件（含
 * CodeMirror 输入框）都同步 reconcile 一遍，是开合卡顿的主因。会话数据经
 * useAuiState 订阅照常驱动更新，不受 memo 影响。
 */
/** 事实探针：把当前消息条数上报（渲染耗时要配这个数才读得出含义）。 */
const ThreadSizeProbe: FC = () => {
  const count = useAuiState((s) => s.thread.messages.length);
  noteFact("消息条数", count);
  return null;
};

/**
 * 分享选择模式下隐藏输入框（豆包同款：底栏是唯一操作条）。订阅放在这个
 * 槽位组件里，不把整棵 Thread 拖进分享状态的重渲染；卸载即隐藏，草稿在
 * runtime 里，退出选择模式后原样回来。
 */
const ComposerSlot: FC = () => {
  const selecting = useShareState().mode === "selecting";
  if (selecting) return null;
  return <Composer />;
};

/**
 * 全局搜索定位意图的消费端（pi-thread-navigate store → thread 层）：
 * 目标消息不在已加载窗时（分页裁掉/历史仍在到达），消息数每变一次就重试
 * 一次；立即命中则滚动+高亮并消费掉意图。订阅收在槽位组件里，不牵动
 * 整棵 Thread。切换会话时 base 已写入意图，这里随新会话挂载接管。
 */
const NavigateIntentSlot: FC = () => {
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  useEffect(() => {
    const intent = peekThreadNavigateIntent();
    if (!intent) return;
    // 会话键归一后比对：mainThreadId 对本会话新建的线程恒为 __LOCALID_ 草稿
    // id（见 pi-thread-adapter 命名空间注释），不经 registry 换算会和意图里
    // 的 pi sessionId 永远对不上
    const threadKey = piSessionIdForThread(mainThreadId) ?? mainThreadId;
    // 会话不匹配不消费：意图属于别的目标会话（用户已切走/还没切到）
    if (intent.sessionKey !== threadKey) return;
    // TTL 过期即废弃：目标消息永远到不了（压缩/截断/加载失败）时自愈，
    // 不残留到用户下一次任意切换
    if (!isIntentFresh(intent)) {
      takeThreadNavigateIntent();
      return;
    }
    if (highlightMessageBySeq(intent.seq, intent.query ?? "")) {
      takeThreadNavigateIntent();
      return;
    }
    // 目标消息不在当前投影里：等历史继续到达（消息数变化驱动下一次 effect）
  }, [messageCount, mainThreadId]);
  return null;
};

export const Thread = memo(function Thread() {
  const isEmpty = useAuiState(isNewChatView);
  // 空闲时预建热点语言的 Shiki 缓存，消掉流式中首个代码块的高亮停顿
  useEffect(() => {
    prewarmShiki();
  }, []);

  return (
    // 渲染耗时自检（仅开发构建）：与右侧面板各挂一个 label，卡顿时看 console 的
    // [perf] 行就能分清贵在消息流还是面板，见 components/debug/render-probe.tsx
    <RenderProbe label="消息流">
      <ThreadSizeProbe />
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-transparent relative @container flex h-full flex-col"
      style={{
        // 外观设置「对话宽度」由 ui-prefs 内联 --chat-width（百分比，100% = 平铺）；
        // 回退值是设置页的默认档 52%，改这里即改默认宽度
        ["--thread-max-width" as string]: "var(--chat-width, 52%)",
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-background) 85%, transparent)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
        {/* 注册 data-compaction 渲染器（自身不可见），横幅随对应 assistant 消息出现 */}
        <CompactionDataUI />
        {/* 全局搜索内容命中的定位+高亮消费端（自身不可见） */}
        <NavigateIntentSlot />
        {/* 注册 data-model-change 渲染器：快照重建的「已切换到 X」分隔线 */}
        <ModelChangeDataUI />
        {/* 「已停止」分隔线不走 data UI 注册：part 只做标记，由
            AssistantMessage 检测后渲染在操作栏下方（见 stopped-marker.tsx） */}
      {/* 注册 data-image 渲染器（同法）：工具产出的图片随消息流内联展示 */}
      <ImageDataUI />

      <ThreadViewport
        // top 锚定（勿改回 "bottom"）：发送后新用户消息钉在视口顶部、更早的历史
        // 滚出上方，回复在其下方流式展开。框架侧连带口径（见
        // useThreadViewportAutoScroll）：autoScroll 随 "top" 默认变 false（不贴底
        // 跟随，定位交给锚点 reserve）；scrollToBottomOnRunStart 对 top 直接空转。
        // reserve 会按需在流式消息后插垫片顶住锚点；但它的置顶是一次性的，
        // 本应用的 isRunning 空窗会把它吃掉，且正文长过视口后框架不再接管——
        // 由 ViewportScrollManager 兜住这两段（重放置顶 + 贴尾跟随）
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className={cn(
          // 消息流禁止横向滚动：超长内容（工具行、composer 工具条等）应在各自层
          // 截断成省略号；overflow-x-clip 兜底，漏网溢出不产生底部滚动条
          // 不加 scroll-smooth：容器级平滑会把 behavior:"auto" 的赋值（回底按钮、
          // 框架内部的落底滚动）也变成动画，连续触发互相打断、看起来像永远追不上；
          // 需要平滑跳转的入口（锚点刻度条、面板定位）自行显式传 "smooth"
          "relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4",
          isEmpty && "justify-center",
        )}
      >
        <AuiIf condition={isNewChatView}>
          <ThreadWelcome />
        </AuiIf>
        <AuiIf condition={isHistoryLoadingView}>
          <ThreadHistorySkeleton />
        </AuiIf>

        <div
          data-slot="aui_message-group"
          className="mb-14 flex flex-col gap-y-6 empty:hidden"
        >
          <ThreadPrimitive.Messages>
            {({ message }) => {
              const inner =
                message.composer.isEditing ? (
                  <EditComposer />
                ) : message.role === "user" ? (
                  <UserMessage />
                ) : (
                  <AssistantMessage />
                );
              // 手动压缩的即时分隔线：按锚点钉在压缩发生时那条消息之后（Messages 内部，
              // 与消息同布局），后续新消息排在其下，重新装载历史后由重建的分隔线接管。
              // 包在 TurnSlot 外层：TurnSlot 的轮末分支不渲染 children（过程/正文
              // 整体重建），包在内层的话锚点消息（= 空闲时的轮末消息）的 banner
              // 永远不会挂载——手动压缩恰发生在空闲边界
              return (
                <ManualCompactionTailAfter messageId={String(message.id)}>
                  <TurnSlot
                    messageId={String(message.id)}
                    isEditing={!!message.composer.isEditing}
                  >
                    {inner}
                  </TurnSlot>
                </ManualCompactionTailAfter>
              );
            }}
          </ThreadPrimitive.Messages>
          {/* 检查点卡兜底尾：仅渲染锚点未知的条目；正常轮次由消息体内的 MessageCheckpoint 挂载 */}
          <CheckpointTail />
          <ThreadWorkingIndicator />
          {/* 直播轮耗时打点（渲染 null），见 turn-summary.tsx */}
          <TurnTimingRecorder />
          {/* 视口滚动管理器（渲染 null）：锚点兜底重放 + 流式贴尾跟随。
              空窗会吃掉框架的一次性置顶，由它补回；正文长过视口后由它接管
              贴尾，见 viewport-scroll-manager.tsx */}
          <ViewportScrollManager />
        </div>
{/*  bg-[color-mix(in_oklab,var(--muted)_55%,var(--background))] */}
        <ThreadPrimitive.ViewportFooter
          className={cn(
            "aui-thread-viewport-footer relative z-10 mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible pb-1 md:pb-1",
            !isEmpty &&
              "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
          )}
        >
          <ThreadScrollToBottom />
          {/* 分享选择模式：composer 上方的全选/生成分享条（空闲时渲染 null） */}
          <ShareSelectionToolbar />
          <ComposerSlot />
          <AuiIf condition={isNewChatView}>
            {/* 推荐常驻（不随 composer 为空/非空起落）：它是"接下来还能做什么"的
                入口，填入提示词后仍要能换个案例；离开新对话页时整块让位 */}
            {/* 占位高度不再由这里兜底：推荐区自身恒定占位（分类行 + 列表满高），
                点选/收起不会改变这块的高度 */}
            <div className="aui-thread-welcome-suggestions-shell">
              <ThreadSuggestions />
            </div>
          </AuiIf>
          {/* AI 生成内容免责声明：仅对话页显示（贴 composer 正下方；新对话页
              还没有生成内容，不出现）。纯文字、不铺底色——整条实色底会在圆角
              聊天卡/壁纸里切出灰色横带；负边距抵消 footer 的 gap-4 保持贴紧 */}
          {!isEmpty && (
            <p
              data-slot="ai-disclaimer"
              className="-mt-1 pb-1 text-center text-xs text-muted-foreground/70"
            >
              内容由AI生成，重要信息请务必核查
            </p>
          )}
        </ThreadPrimitive.ViewportFooter>
      </ThreadViewport>

      {/* 会话锚点定位：左侧刻度条，一轮对话一个刻度，悬停预览、点击跳转（内容溢出时出现） */}
      <ThreadPreviewRail />

      {/* Ctrl/Cmd+F：当前会话正文搜索 + 结果目录，跳转时高亮命中词 */}
      <ThreadFind />

      <SelectionToolbar />
    </ThreadPrimitive.Root>
    </RenderProbe>
  );
});