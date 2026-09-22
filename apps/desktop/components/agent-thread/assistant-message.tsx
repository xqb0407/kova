"use client";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { MessageTiming } from "@/components/assistant-ui/elements/message-timing.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { QuestionToolRow } from "./question-tool-row";
import { AGENT_TOOL_UI } from "@/components/assistant-ui/elements/tool-row.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import {
  AuiIf,
  type AssistantState,
  MessagePrimitive,
  ActionBarPrimitive,
  ErrorPrimitive,
  useAuiState,
  ActionBarMorePrimitive,
} from "@assistant-ui/react";
import { RetryMarker, useRetryState } from "./retry-marker";
import { StoppedMarker, isStoppedMessageState } from "./stopped-marker";
import { MessageArtifacts } from "./agent-panel/artifact-card";
import { MessageCheckpoint } from "./checkpoint-card";
import { cn } from "cn";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { FC, ReactNode } from "react";
import { randomLoadingPhrase } from "@/lib/panels/loading";

/**
 * 交互面在别处、消息列表不再渲染的工具：
 * todo 的进度在右侧面板「计划」标签呈现——挂 ToolFallback 只是倾倒原始 JSON 噪音。
 * Question 不在此列：提问当下由 composer 卡片交互（question-card.tsx），
 * 回答后在列表里以折叠条目留痕（question-tool-row.tsx）。
 */
const HIDDEN_TOOL_NAMES = new Set(["todo"]);

/**
 * 工具 → 分组类别（对齐截图的分段标签）：
 * terminal=命令流水、inspect=查阅（读文件/检索）、modify=编辑改动。
 * 未列出的工具仍进通用 group-tool（memory_write 记忆写入是持久化动作，
 * 不与工作区文件编辑混排，归通用组单独成行）。
 */
const TOOL_CATEGORY: Record<string, "terminal" | "inspect" | "modify"> = {
  bash: "terminal",
  read: "inspect",
  glob: "inspect",
  grep: "inspect",
  WebFetch: "inspect",
  WebSearch: "inspect",
  memory_read: "inspect",
  memory_search: "inspect",
  use_skill: "inspect",
  edit: "modify",
  write: "modify",
};

/** 折叠组头图标：与类别代表工具的单行图标同形（bash=终端、检索=放大镜、编辑=铅笔） */
const CATEGORY_ICON: Record<"terminal" | "inspect" | "modify", ReactNode> = {
  terminal: <SquareTerminalIcon className="size-4 shrink-0" />,
  inspect: <SearchIcon className="size-4 shrink-0" />,
  modify: <PencilLineIcon className="size-4 shrink-0" />,
};

/** 工具分组：计数剔除隐藏的工具卡，全组都被隐藏时整组不渲染 */
const ToolGroupSection: FC<{
  indices: readonly number[];
  active: boolean;
  category?: "terminal" | "inspect" | "modify";
  children: ReactNode;
}> = ({ indices, active, category, children }) => {
  // "可见数|文件数|检索数"打包成一个字符串选择器：
  // 值不变时 Object.is 相等，流式期间不会因新对象身份反复重渲
  const summary = useAuiState((s) => {
    let n = 0;
    let files = 0;
    let searches = 0;
    for (const i of indices) {
      const p = s.message.content[i];
      if (!p) continue;
      if (p.type === "tool-call" && HIDDEN_TOOL_NAMES.has(p.toolName)) continue;
      n += 1;
      if (p.type === "tool-call") {
        if (p.toolName === "read") files += 1;
        else if (
          p.toolName === "glob" ||
          p.toolName === "grep" ||
          p.toolName === "WebFetch" ||
          p.toolName === "WebSearch" ||
          p.toolName === "memory_search"
        )
          searches += 1;
      }
    }
    return `${n}|${files}|${searches}`;
  });
  const [count, fileCount, searchCount] = summary.split("|").map(Number);
  if (count === 0) return null;
  // 只有一条时不套折叠组（对齐 Codex：≥2 连续调用才合并）——直接平铺该行，
  // 少一次点击才能看到内容；组标签的计数语义也要求 ≥2 才成立。
  if (count === 1) return <>{children}</>;
  // 类别分组出中文标签；通用分组保持默认 "N tool calls"
  const label =
    category === "terminal"
      ? "终端"
      : category === "modify"
        ? `编辑 · ${count} 文件`
        : category === "inspect"
          ? (() => {
              const seg: string[] = [];
              if (searchCount) seg.push(`${searchCount} 搜索`);
              if (fileCount) seg.push(`${fileCount} 文件`);
              return seg.length ? `查阅 · ${seg.join(", ")}` : "查阅";
            })()
          : undefined;
  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        count={count}
        active={active}
        label={label}
        icon={category ? CATEGORY_ICON[category] : undefined}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

/**
 * §8 错误归因：transport 把 sidecar error chunk 的结构化归因（分类器换算
 * 的 {code, source, retryable, statusCode?}）转成 data-errorAttribution part
 * 落在本条消息上（error chunk 的未知字段可能被 AI SDK 处理时丢弃，part 桥
 * 与 data-retry 同款）。可重试错误（网络/限流/5xx）在错误卡上给「重试」——
 * Reload = 重发末条用户消息，与操作栏重载同源。
 */
function isRetryableErrorState(s: AssistantState): boolean {
  const parts = s.message.content;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === "data" && p.name === "errorAttribution") {
      return (p.data as { retryable?: boolean } | undefined)?.retryable === true;
    }
  }
  return false;
}

const MessageError: FC = () => {
  const retryable = useAuiState(isRetryableErrorState);
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md  p-2 text-sm dark:text-red-200">
        <div className="flex items-center justify-between gap-2">
          <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2 min-w-0" />
          {retryable && (
            <ActionBarPrimitive.Reload asChild>
              <button
                type="button"
                className="hover:bg-destructive/15 inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-xs transition-colors"
              >
                <RefreshCwIcon size="1em" />
                重试
              </button>
            </ActionBarPrimitive.Reload>
          )}
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantWorkingIndicator: FC = () => {
  const isEmpty = useAuiState((s) => s.message.content.length === 0);
  // 重试进行中时不显示（RetryMarker 顶替这条状态行，参照示例 base.tsx）
  if (useRetryState()) return null;
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      className="text-muted-foreground inline-flex items-center gap-2 align-middle"
    >
      {/* 等待动画：内容为空=连接中；已有内容但模型/工具间隙=加载态点阵 */}
      <DotMatrix state={isEmpty ? "connecting" : "loading"} aria-hidden />
      <span className="shimmer shimmer-speed-200 text-foreground/60 text-sm">
        {isEmpty ? "连接中..." : randomLoadingPhrase()}
      </span>
    </span>
  );
};

export const AssistantMessage: FC = () => {
  // 「已停止」消息（data-stopped part 存在，直播/历史重建同构）：分隔线渲染
  // 在操作栏之下（ActionBar 外面），part 本身不就地渲染
  const stopped = useAuiState(isStoppedMessageState);
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        {/* 重试状态行：只渲染一次，attempt 原地更新（data part 本身就地不渲染） */}
        <MessagePrimitive.GroupedParts
          groupBy={(part) => {
            if (part.type === "reasoning")
              return ["group-chainOfThought", "group-reasoning"];
            if (part.type === "tool-call") {
              // Task 委派行独立成行，不并入工具折叠组（并行多个各一行）
              if (part.toolName === "Task") return [];
              const cat = TOOL_CATEGORY[part.toolName];
              return [
                "group-chainOfThought",
                cat ? `group-tool-${cat}` : "group-tool",
              ];
            }
            return [];
          }}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
              case "group-tool-terminal":
              case "group-tool-inspect":
              case "group-tool-modify":
                return (
                  <ToolGroupSection
                    indices={part.indices}
                    active={part.status.type === "running"}
                    category={
                      part.type === "group-tool-terminal"
                        ? "terminal"
                        : part.type === "group-tool-inspect"
                          ? "inspect"
                          : part.type === "group-tool-modify"
                            ? "modify"
                            : undefined
                    }
                  >
                    {children}
                  </ToolGroupSection>
                );
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot variant="ghost" defaultOpen={running} >
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call": {
                // todo 不渲染；Question 已答以折叠条目留痕（提问中归 composer 卡片）
                if (part.toolName === "Question") return <QuestionToolRow {...part} />;
                if (HIDDEN_TOOL_NAMES.has(part.toolName)) return null;
                // 内置四类工具走扁平行（点开面板）；其余保留注册 UI / 回退卡
                const Row = AGENT_TOOL_UI[part.toolName];
                return Row ? (
                  <Row {...part} />
                ) : (
                  part.toolUI ?? <ToolFallback {...part} />
                );
              }
              case "indicator":
                return <AssistantWorkingIndicator />;
              case "data":
                return part.dataRendererUI;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {/* 消息尾部产物卡：agent 用 write 产出的交付文件（HTML 报告/文档等） */}
        <MessageArtifacts />
        {/* 检查点卡：本轮 git 改动的汇总与撤销入口，隶属消息本体（操作栏之上） */}
        <MessageCheckpoint />
        <MessageError />
        <RetryMarker />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn(
          "relative ml-2 min-h-7.5 overflow-visible",
          // 常态：操作栏悬浮在消息间隙（负 margin 折叠占位）；被停止的消息
          // 要给它留出真实高度，分隔线才能排到操作栏下方
          !stopped && "h-7.5 -mb-7.5",
        )}
      >
        <div className="absolute inset-x-0 top-0 flex h-7.5 items-center pt-1.5">
          <AssistantActionBar />
        </div>
      </div>
      {stopped && (
        <div className="ml-2">
          <StoppedMarker />
        </div>
      )}
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  // 纯分隔线消息（如历史重建的压缩分隔线）：不展示复制/重载等操作
  const dividerOnly = useAuiState(
    (s) =>
      s.message.content.length > 0 &&
      s.message.content.every((p) => p.type === "data"),
  );
  // 只隐藏「本条消息还在流式输出」的操作栏；其他 turn 在跑不影响已完成
  // 消息的 ActionBar（排队/并行场景下每条已结束的对话都是独立可操作的）
  const selfRunning = useAuiState((s) => s.message.status?.type === "running");
  // 一轮回复会被拆成多条 assistant 消息（每次工具调用后继续生成都是新的
  // 一条），autohide 只认「线程最后一条」——中间消息 hover 时仍各自冒出
  // 操作栏。这里收紧为：仅「本轮收尾」的消息（下一条不再是 assistant）
  // 才挂操作栏，一轮只有一个
  const isTurnEnd = useAuiState((s) => {
    const msgs = s.thread.messages;
    const idx = msgs.findIndex((m) => m.id === s.message.id);
    return idx === -1 || msgs[idx + 1]?.role !== "assistant";
  });
  if (dividerOnly || selfRunning || !isTurnEnd) return null;
  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ml-1 my-4 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon
              size="1em"
              className="animate-in zoom-in-50 fade-in duration-200 ease-out"
            />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon
              size="1em"
              className=" animate-in zoom-in-75 fade-in duration-150"
            />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon size="1em" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon size="1em" />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon size="1em" className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      {/* <MessageTiming /> */}
    </ActionBarPrimitive.Root>
  );
};