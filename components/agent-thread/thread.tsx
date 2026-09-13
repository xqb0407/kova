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
import type { FC } from "react";

// Import other components
import { ThreadWelcome } from "./thread-welcome";
import { ThreadSuggestions } from "./thread-suggestions";
import { Composer, EditComposer } from "./composer";
import { AssistantMessage } from "./assistant-message";
import { CompactionDataUI, ManualCompactionTailAfter } from "./compaction-banner";
import { UserMessage } from "./user-message";
import { BranchPicker } from "./branch-picker";
import { CheckpointBar } from "./checkpoint-bar";
import { ThreadPreviewRail } from "./thread-preview-rail";

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

export const Thread: FC = () => {
  const isEmpty = useAuiState(isNewChatView);

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

      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className={cn(
          "relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4",
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
          <CheckpointBar />
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

      {/* 会话锚点定位：右侧刻度条，悬停预览、点击跳转（内容溢出时出现） */}
      <ThreadPreviewRail />

      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};