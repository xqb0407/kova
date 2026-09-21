"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DotMatrix } from "@/components/ui/dot-matrix";
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
import { useEffect, type FC } from "react";

// Import other components
import { ThreadWelcome } from "./thread-welcome";
import { ThreadSuggestions } from "./thread-suggestions";
import { Composer, EditComposer } from "./composer";
import { AssistantMessage } from "./assistant-message";
import { CompactionDataUI, ManualCompactionTailAfter } from "./compaction-banner";
import { ImageDataUI } from "@/components/assistant-ui/elements/image-data";
import { UserMessage } from "./user-message";
import { BranchPicker } from "./branch-picker";
import { CheckpointTail } from "./checkpoint-card";
import { ThreadPreviewRail } from "./thread-preview-rail";
import { prewarmShiki } from "@/lib/markdown/prewarm-shiki";
import { useThreadPendingTurn } from "@/lib/pi/pi-queue";

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

/** turn 间隙等待动画：列表末尾还不是 AI 回复、但新一轮已在路上时（排队项
 *  激活开跑后的会话准备段、新回复首 token 前的空窗），消息级 indicator 无处
 *  挂载——AI 回复消息要等首个内容块才创建——这里在列表末尾补点阵动画。
 *  两类触发：
 *  - pendingTurn：排队项已开跑（data-queue active）。被立即发送中止的上一轮
 *    流收尾会把 chat status 短暂置回 ready（isRunning=false 的空窗），必须绕过
 *    isRunning 判定，且此刻该轮不存在隐藏排队项（它自己已激活）；
 *  - 常规兜底：thread 在跑、末条是 user 消息、且没有排队项隐藏。 */
const ThreadWorkingIndicator: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastRole = useAuiState((s) => s.thread.messages.at(-1)?.role);
  const pendingTurn = useThreadPendingTurn(threadId);
  if (lastRole !== "user" || !(pendingTurn || isRunning)) {
    return null;
  }
  return (
    <div
      data-slot="aui-thread-working-indicator"
      className="text-muted-foreground mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 px-6 py-2"
    >
      <DotMatrix state="loading" aria-hidden />
      <span className="shimmer shimmer-speed-200 text-foreground/60 text-sm">
        思考中...
      </span>
    </div>
  );
};

export const Thread: FC = () => {
  const isEmpty = useAuiState(isNewChatView);
  // 空闲时预建热点语言的 Shiki 缓存，消掉流式中首个代码块的高亮停顿
  useEffect(() => {
    prewarmShiki();
  }, []);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-transparent relative @container flex h-full flex-col"
      style={{
        // 外观设置「对话宽度」经 html[data-chat-width] 覆写 --chat-width（globals.css）；
        // 回退值 = 默认档（md），改这里即改默认宽度
        ["--thread-max-width" as string]: "var(--chat-width, 60rem)",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
        {/* 注册 data-compaction 渲染器（自身不可见），横幅随对应 assistant 消息出现 */}
        <CompactionDataUI />
        {/* 「已停止」分隔线不走 data UI 注册：part 只做标记，由
            AssistantMessage 检测后渲染在操作栏下方（见 stopped-marker.tsx） */}
      {/* 注册 data-image 渲染器（同法）：工具产出的图片随消息流内联展示 */}
      <ImageDataUI />

      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className={cn(
          // 消息流禁止横向滚动：超长内容（工具行、composer 工具条等）应在各自层
          // 截断成省略号；overflow-x-clip 兜底，漏网溢出不产生底部滚动条
          "relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll scroll-smooth px-4 pt-4",
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
              // 与消息同布局），后续新消息排在其下，重新装载历史后由重建的分隔线接管
              return (
                <ManualCompactionTailAfter messageId={String(message.id)}>
                  {inner}
                </ManualCompactionTailAfter>
              );
            }}
          </ThreadPrimitive.Messages>
          {/* 检查点卡兜底尾：仅渲染锚点未知的条目；正常轮次由消息体内的 MessageCheckpoint 挂载 */}
          <CheckpointTail />
          <ThreadWorkingIndicator />
        </div>
{/*  bg-[color-mix(in_oklab,var(--muted)_55%,var(--background))] */}
        <ThreadPrimitive.ViewportFooter
          className={cn(
            "aui-thread-viewport-footer relative z-10 mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible pb-1 md:pb-1",
            !isEmpty &&
              "sticky bottom-0 mt-auto rounded-t-(--composer-radius) bg-background",
          )}
        >
          <ThreadScrollToBottom />
          <Composer />
          <AuiIf condition={isNewChatView}>
            <div className="aui-thread-welcome-suggestions-shell min-h-19">
              <AuiIf condition={(s) => s.composer.isEmpty}>
                <ThreadSuggestions />
              </AuiIf>
            </div>
          </AuiIf>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>

      {/* 会话锚点定位：左侧刻度条，一轮对话一个刻度，悬停预览、点击跳转（内容溢出时出现） */}
      <ThreadPreviewRail />

      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};