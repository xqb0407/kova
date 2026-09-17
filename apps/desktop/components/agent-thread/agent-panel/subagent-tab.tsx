"use client";

import { useEffect, useRef, useState, type ComponentType, type FC } from "react";
import {
  BookOpenIcon,
  BotIcon,
  ChevronDownIcon,
  FileSearchIcon,
  LoaderCircleIcon,
  NotebookPen,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  ScrollingText,
  ToolRow,
} from "@/components/assistant-ui/elements/tool-row.aui";
import {
  subagentElapsedSeconds,
  useSubagentRun,
  type SubagentBlock,
  type SubagentRunState,
} from "@/lib/subagent-runs";
import type { PanelTab } from "@/lib/panel-tabs";
import { TabEmpty } from "./tab-empty";

/**
 * 子智能体运行过程 tab：Task 委派行唤起的专属视图，流式渲染 delegate 的
 * 内部流水（轮次分隔、思考折叠、工具行、正文段）+ 结算后的报告块。
 * 数据全在 lib/subagent-runs store（活动通知实时进 + 快照水合兜底），
 * tab 只是投影——与 shell tab「标签是入口、状态活在模块 store」同构。
 */

/** 委派终态中文短标签（与消息行 TaskToolUI 同一套词） */
const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  truncated: "轮次超限",
  aborted: "已中止",
  stopped: "已停止",
};

/** 子代理工具行的类别名/图标（对齐主会话 ToolRow 的视觉语言，未命中回退通用扳手） */
const TOOL_META: Record<
  string,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  bash: { label: "终端", icon: SquareTerminalIcon },
  read: { label: "查看", icon: BookOpenIcon },
  edit: { label: "编辑", icon: PencilLineIcon },
  write: { label: "写入", icon: NotebookPen },
  glob: { label: "文件检索", icon: FileSearchIcon },
  grep: { label: "内容检索", icon: SearchIcon },
};

// thinking/text 共用一个 union 变体（kind: "text"|"thinking"），按特征字段提取
type TextishBlock = Extract<SubagentBlock, { id: string }>;

const ThinkingBlockView: FC<{ block: TextishBlock }> = ({ block }) => {
  const [open, setOpen] = useState(!block.done);
  // 用户手动开合过就不再自动收（done 时默认收起对齐主会话思考流的观感）
  const touched = useRef(false);
  useEffect(() => {
    if (block.done && !touched.current) setOpen(false);
  }, [block.done]);
  const seconds =
    block.done && block.endedAt
      ? Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000))
      : undefined;
  return (
    <Collapsible open={open} onOpenChange={(v) => { touched.current = true; setOpen(v); }}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
        {block.done ? (
          <ChevronDownIcon
            className={cnRotate(open)}
          />
        ) : (
          <LoaderCircleIcon className="size-3 animate-spin" />
        )}
        <span>
          {seconds !== undefined ? `思考 · 持续 ${seconds} 秒` : "思考中…"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-muted-foreground mt-1 mb-2 text-xs leading-relaxed whitespace-pre-wrap">
          {block.text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
};

const cnRotate = (open: boolean) =>
  `size-3 transition-transform ${open ? "" : "-rotate-90"}`;

const ToolBlockView: FC<{ block: Extract<SubagentBlock, { toolCallId: string }> }> = ({
  block,
}) => {
  const meta = TOOL_META[block.toolName];
  const Icon = meta?.icon ?? WrenchIcon;
  return (
    <ToolRow
      label={meta?.label ?? block.toolName}
      icon={<Icon className="size-4 shrink-0" />}
      primary={block.argsSummary || block.toolName}
      mono
      secondary={block.done ? block.resultSummary : undefined}
      running={!block.done}
      failed={!!block.failed}
    />
  );
};

const BlockView: FC<{ block: SubagentBlock }> = ({ block }) => {
  switch (block.kind) {
    case "turn":
      // 单轮委派不显示分隔；多轮才标一下（轮次上限前的分段感）
      if (block.n <= 1) return null;
      return (
        <div className="text-muted-foreground/50 py-1 text-center text-[11px]">
          — 第 {block.n} 轮 —
        </div>
      );
    case "thinking":
      return <ThinkingBlockView block={block} />;
    case "text":
      return (
        <div className="text-sm leading-relaxed">
          <MarkdownText text={block.text} />
        </div>
      );
    case "tool":
      return <ToolBlockView block={block} />;
  }
};

const RunHeader: FC<{ run: SubagentRunState }> = ({ run }) => {
  const running = run.status === "running";
  // 运行中每秒一拍刷新用时
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = subagentElapsedSeconds(run);
  const statusSuffix = running
    ? `工作中 ${elapsed} 秒`
    : [
        STATUS_LABEL[run.status] ?? run.status,
        run.startedAt && run.completedAt
          ? `${Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000))} 秒`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <div className="border-b px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <BotIcon className="size-4 shrink-0" />
        <span className="truncate font-mono text-sm">{run.agentName || "子智能体"}</span>
        {running ? (
          <LoaderCircleIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : null}
        <span className="text-muted-foreground ml-auto shrink-0 text-xs">{statusSuffix}</span>
      </div>
      {run.description ? (
        <p className="text-muted-foreground mt-1 truncate text-xs">{run.description}</p>
      ) : null}
      <p className="text-muted-foreground/70 mt-1 text-[11px] tabular-nums">
        {run.turns} 轮 · {run.toolCalls} 工具调用
      </p>
    </div>
  );
};

export const SubagentTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const run = useSubagentRun(tab.delegationId);
  if (!run)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        载入运行过程…
      </div>
    );
  if (run.expired)
    return (
      <TabEmpty
        icon={BotIcon}
        text="运行记录已过期（sidecar 重启或超出保留上限），最终结果见会话中的任务输出"
      />
    );
  return (
    <div className="flex h-full flex-col">
      <RunHeader run={run} />
      <ScrollingText className="flex-1 px-3 py-2">
        <div className="flex flex-col gap-1.5">
          {run.blocks.map((b, i) => (
            <BlockView
              key={
                b.kind === "tool"
                  ? b.toolCallId
                  : b.kind === "turn"
                    ? `turn-${i}`
                    : `${b.kind}-${b.id}`
              }
              block={b}
            />
          ))}
          {run.status === "running" && run.blocks.length === 0 ? (
            <p className="text-muted-foreground/70 py-4 text-center text-xs">
              子智能体已启动，等待活动流…
            </p>
          ) : null}
          {run.status !== "running" && run.report ? (
            <Collapsible className="border-t pt-2">
              <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium">
                <ChevronDownIcon className="size-3" />
                报告
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 text-sm leading-relaxed">
                  <MarkdownText text={run.report} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </ScrollingText>
    </div>
  );
};
