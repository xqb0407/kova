"use client";

import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { QuoteBlock } from "@/components/assistant-ui/elements/quote.aui";
import {
  DirectiveText,
  directiveChipVariants,
} from "@/components/assistant-ui/elements/directive-text.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  useAuiState,
  type AssistantState,
} from "@assistant-ui/react";
import { CmComposerInput } from "./cm-composer-input";
import { MessageSelectToggle } from "./share/message-select-toggle";
import { CheckIcon, ChevronDownIcon, PencilIcon } from "lucide-react";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { splitPromptNotices } from "@/lib/pi/prompt-notices";
import type { TextMessagePartComponent } from "@assistant-ui/react";

/**
 * 「已并入当前回复」消息（data-steeredNote part 存在，仅历史重建路径产生）：
 * 并入（steer）的排队项注入即真实 user 消息落转录，直播侧不渲染气泡（排队条
 * 徽标承载），刷新/翻页后的历史重建按哨兵前缀补本标记 part，由气泡上方渲染
 * 徽标（stopped-marker 同款机制，part 本身不就地渲染）。
 */
function isSteeredNoteState(s: AssistantState): boolean {
  return s.message.content.some(
    (p) => p.type === "data" && p.name === "steeredNote",
  );
}

/** 用户气泡的文本渲染：剥掉 sidecar 给模型看的注记行（见 lib/pi/prompt-notices） */
const NoticeStrippedText: TextMessagePartComponent = (props) => (
  <DirectiveText {...props} text={splitPromptNotices(props.text ?? "").text} />
);

/** 气泡下方要告知用户的告警（图片被省略等）；返回字符串，选择器比较稳定 */
const selectOmittedNotices = (s: AssistantState): string =>
  s.message.content
    .filter((p) => p.type === "text")
    .flatMap((p) => splitPromptNotices(p.text).warnings)
    .join("\n");

/** 剥掉注记后的正文；空串 = 这条消息没有可显示的文字（如"只发了一张图"） */
const selectCleanText = (s: AssistantState): string =>
  s.message.content
    .filter((p) => p.type === "text")
    .map((p) => splitPromptNotices(p.text).text)
    .join("\n")
    .trim();

/** 引用块存在 metadata.custom.quote（不占 content），有引用时气泡仍要显示 */
const selectHasQuote = (s: AssistantState): boolean =>
  Boolean(
    (s.message.metadata as { custom?: { quote?: unknown } } | undefined)?.custom
      ?.quote,
  );

export const UserMessage: FC = () => {
  const steered = useAuiState(isSteeredNoteState);
  const omittedNotices = useAuiState(selectOmittedNotices);
  const cleanText = useAuiState(selectCleanText);
  const hasQuote = useAuiState(selectHasQuote);
  // 只发图片/附件时，正文被注记剥离后为空——此时不该留一个空气泡
  const showBubble = cleanText.length > 0 || hasQuote;
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in aui-user-message-root relative mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2"
    >
      <MessageSelectToggle />
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0 text-md">
        {steered && (
          <div className="mb-1 flex items-center gap-1.5 pl-0.5">
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
            <span className="text-muted-foreground/70 text-xs leading-none">
              已并入当前回复
            </span>
          </div>
        )}
        {showBubble && (
          <>
            {/* directiveChipVariants：DirectiveText 渲染的芯片 Badge 默认色与
                bg-muted 气泡几乎同色，需容器显式挂蓝色配色（与 composer 同款） */}
            <div
              className={cn(
                // 大圆角 + 右下角收小 = 会话气泡的「尖」（iMessage 式：指向发送者）
                "aui-user-message-content peer bg-muted text-foreground rounded-xl rounded-br-sm px-4 py-2 wrap-break-word",
                directiveChipVariants,
              )}
            >
              <CollapsibleUserMessageContent>
                <MessagePrimitive.Quote>
                  {(quote) => <QuoteBlock {...quote} />}
                </MessagePrimitive.Quote>
                <MessagePrimitive.Parts
                  components={{ Text: NoticeStrippedText }}
                />
              </CollapsibleUserMessageContent>
            </div>
          </>
        )}
        {/* 注记里的"已省略"是必须让用户知道的：图片没发出去。气泡下方一行小字 */}
        {omittedNotices ? (
          <div className="mt-1 flex flex-col gap-0.5 pl-0.5">
            {omittedNotices.split("\n").map((line, i) => (
              <span
                key={`${i}-${line}`}
                className="text-xs leading-snug text-amber-600 dark:text-amber-400"
              >
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {showBubble && (
          <div className="aui-user-action-bar-wrapper absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2 peer-empty:hidden">
            <UserActionBar />
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
};

const USER_MESSAGE_COLLAPSED_HEIGHT = 144;

const CollapsibleUserMessageContent: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [isLong, setIsLong] = useState(false);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const measure = () => {
      // 拖拽调宽期间正文每帧 rewrap：逐帧 scrollHeight + setState 会让所有
      // 长消息在拖动中反复重渲染；松手后 resize-settled 补一次终态
      if (isResizing()) return;
      const height = element.scrollHeight;
      setContentHeight(height);
      setIsLong(height > USER_MESSAGE_COLLAPSED_HEIGHT);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const offSettled = onResizeSettled(measure);
    return () => {
      observer.disconnect();
      offSettled();
    };
  }, [children]);

  const collapsed = isLong && !expanded;
  const visibleHeight = collapsed
    ? USER_MESSAGE_COLLAPSED_HEIGHT
    : isLong
      ? contentHeight
      : "auto";

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
        style={{ height: visibleHeight }}
      >
        {children}
      </div>
      {isLong && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse message" : "Expand message"}
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "absolute bottom-0 left-1/2 z-10 flex size-8 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground",
          )}
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
      {collapsed && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-muted via-muted/90 to-transparent"
        />
      )}
    </div>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit text-muted-foreground size-5">
          <PencilIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
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