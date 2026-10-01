"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type ReactNode,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  BookOpenIcon,
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
  toolCallIdForDelegation,
  type SubagentBlock,
  type SubagentRunState,
} from "@/lib/subagent/subagent-runs";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import {
  buildSubagentTranscript,
  groupSubagentContent,
  type SubagentContentUnit,
  type SubagentToolBlock,
  type SubagentTranscriptMessage,
} from "@/lib/subagent/subagent-transcript";

/**
 * 子智能体面板的「对话列表」视图：把 delegate 的活动流按会话列表的观感重排。
 * 视觉对齐主会话——派活说明走 user 气泡（右对齐、bg-muted 圆角块），
 * 子智能体的每轮输出与末条报告走 assistant 样式（左对齐、无气泡底、
 * Markdown + 工具行 + 可折叠思考）。数据分段在 subagent-transcript（纯函数）。
 */

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

type TextishBlock = Extract<SubagentBlock, { id: string }>;

const cnRotate = (open: boolean) =>
  `size-3 transition-transform ${open ? "" : "-rotate-90"}`;

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
    <Collapsible
      open={open}
      onOpenChange={(v) => {
        touched.current = true;
        setOpen(v);
      }}
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
        {block.done ? (
          <ChevronDownIcon className={cnRotate(open)} />
        ) : (
          <LoaderCircleIcon className="size-3 animate-spin" />
        )}
        <span>{seconds !== undefined ? `思考 · 持续 ${seconds} 秒` : "思考中…"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-muted-foreground mt-1 mb-2 text-xs leading-relaxed whitespace-pre-wrap">
          {block.text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
};

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

/** 连续工具调用的折叠组（对齐主会话的 ghost 组）：组头是类别名 + 计数，
 *  展开看逐条工具行；单元素不成组，直接平铺那一行 */
const ToolGroupView: FC<{ tools: SubagentToolBlock[] }> = ({ tools }) => {
  // 同类工具用它的类别名/图标；混合则回退通用扳手 + 纯计数
  const names = new Set(tools.map((t) => t.toolName));
  const single = names.size === 1 ? tools[0]!.toolName : undefined;
  const meta = single ? TOOL_META[single] : undefined;
  const Icon = meta?.icon ?? WrenchIcon;
  const label = single
    ? `${meta?.label ?? single} · ${tools.length}`
    : `${tools.length} 个工具调用`;
  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        count={tools.length}
        label={label}
        icon={<Icon className="size-4 shrink-0" />}
        active={tools.some((t) => !t.done)}
      />
      <ToolGroupContent>
        {tools.map((t) => (
          <ToolBlockView key={t.toolCallId} block={t} />
        ))}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
};

/** 段内块渲染（turn 块已被 transcript 吸收为段边界，tool 块走分组单元） */
const BlockView: FC<{ block: SubagentBlock }> = ({ block }) => {
  switch (block.kind) {
    case "thinking":
      return <ThinkingBlockView block={block} />;
    case "text":
      return (
        <div className="text-sm leading-relaxed">
          <MarkdownText text={block.text} />
        </div>
      );
    default:
      return null;
  }
};

const unitKey = (u: SubagentContentUnit, i: number): string =>
  u.kind === "tools" ? `tools-${u.tools[0]?.toolCallId ?? i}` : blockKey(u.block, i);

const ContentUnitView: FC<{ unit: SubagentContentUnit }> = ({ unit }) => {
  if (unit.kind === "block") return <BlockView block={unit.block} />;
  if (unit.tools.length === 1) return <ToolBlockView block={unit.tools[0]!} />;
  return <ToolGroupView tools={unit.tools} />;
};

const blockKey = (b: SubagentBlock, i: number): string =>
  b.kind === "tool" ? b.toolCallId : b.kind === "turn" ? `turn-${i}` : `${b.kind}-${b.id}`;

/** 消息时间戳：HH:MM（本地时区，等宽数字对齐） */
const clock = (ms: number | undefined): string | undefined => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 气泡长内容折叠：超 144px 折叠 + 圆形展开钮 + 底部渐隐（与主会话用户气泡
 *  同款观感；那份是 user-message 私有件，这里就地镜像，避免把面板拖进
 *  CodeMirror 等重依赖） */
const BUBBLE_COLLAPSED_HEIGHT = 144;

const CollapsibleBubbleContent: FC<{ children: ReactNode }> = ({ children }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [isLong, setIsLong] = useState(false);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const height = element.scrollHeight;
      setContentHeight(height);
      setIsLong(height > BUBBLE_COLLAPSED_HEIGHT);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  const collapsed = isLong && !expanded;
  const visibleHeight = collapsed
    ? BUBBLE_COLLAPSED_HEIGHT
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
      {isLong ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "折叠消息" : "展开消息"}
          onClick={() => setExpanded((v) => !v)}
          className="border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground absolute bottom-0 left-1/2 z-10 flex size-8 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border shadow-sm transition-colors"
        >
          <ChevronDownIcon
            className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      ) : null}
      {collapsed ? (
        <div
          aria-hidden="true"
          className="from-muted via-muted/90 pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-t to-transparent"
        />
      ) : null}
    </div>
  );
};

/* ----------------------------- 派活说明（user 消息） ----------------------------- */

type TaskToolPart = { toolCallId?: unknown; args?: unknown; result?: unknown };

function readTaskArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const task = (args as { task?: unknown }).task;
  return typeof task === "string" && task.trim() ? task : undefined;
}

function resultAnnouncesDelegation(result: unknown, shortId: string): boolean {
  const text =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? JSON.stringify(result)
        : "";
  return text.includes(`Delegation ${shortId} started`);
}

/**
 * 派活说明的来源：主会话里那条 Task 工具调用的 args.task。
 * 优先按 binding 的 toolCallId 精确命中（实时委派即刻可得），
 * 否则回退按结果文本里的 "Delegation <8位> started" 认领（刷新/历史重建）。
 * 两者都取不到返回 undefined，由 user 气泡兜底占位。
 */
function useSubagentTaskBrief(delegationId: string | undefined): string | undefined {
  const messages = useAuiState((s) => s.thread.messages);
  return useMemo(() => {
    if (!delegationId) return undefined;
    const boundCallId = toolCallIdForDelegation(delegationId);
    const shortId = delegationId.slice(0, 8);
    let fallback: string | undefined;
    for (const message of messages) {
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolName !== "Task") continue;
        const p = part as TaskToolPart;
        const task = readTaskArg(p.args);
        if (!task) continue;
        if (boundCallId && p.toolCallId === boundCallId) return task;
        if (!fallback && resultAnnouncesDelegation(p.result, shortId)) fallback = task;
      }
    }
    return fallback;
  }, [messages, delegationId]);
}

/* --------------------------------- 消息渲染 --------------------------------- */

const UserMessageView: FC<{
  message: SubagentTranscriptMessage;
  description?: string;
}> = ({ message, description }) => {
  const time = clock(message.at);
  return (
    <div className="flex flex-col items-end gap-1">
      {description ? (
        <span className="text-muted-foreground/60 max-w-[85%] truncate text-[11px] sm:max-w-[75%]">
          {description}
        </span>
      ) : null}
      <div className="bg-muted text-foreground max-w-[85%] rounded-md px-4 py-2 text-sm wrap-break-word sm:max-w-[75%]">
        <CollapsibleBubbleContent>
          {message.text ? (
            <MarkdownText text={message.text} />
          ) : (
            <span className="text-muted-foreground/60">（未能取得任务说明）</span>
          )}
        </CollapsibleBubbleContent>
      </div>
      {time ? (
        <span className="text-muted-foreground/50 text-[11px] tabular-nums">{time}</span>
      ) : null}
    </div>
  );
};

/** AI 消息：不给逐条时间戳（顶部 header 已有总用时，逐条顶到右边很碎），
 *  仅在报告段上方留一个「报告」小标 */
const AssistantMessageView: FC<{
  message: SubagentTranscriptMessage;
}> = ({ message }) => {
  return (
    <div className="flex flex-col gap-2">
      {message.report ? (
        <>
          <span className="text-muted-foreground/60 text-[11px]">报告</span>
          <div className="text-foreground text-sm leading-relaxed wrap-break-word">
            <MarkdownText text={message.text ?? ""} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          {groupSubagentContent(message.blocks ?? []).map((u, i) => (
            <ContentUnitView key={unitKey(u, i)} unit={u} />
          ))}
        </div>
      )}
    </div>
  );
};

/** 面板对话列表：派活说明（user）+ 各轮输出与报告（assistant） */
export const SubagentConversation: FC<{ run: SubagentRunState }> = ({ run }) => {
  const brief = useSubagentTaskBrief(run.delegationId);
  const messages = useMemo(
    () => buildSubagentTranscript(run, brief),
    [run, brief],
  );
  const waiting = run.status === "running" && run.blocks.length === 0;

  return (
    <ScrollingText className="flex-1 px-3 py-2">
      <div className="flex flex-col gap-4">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <UserMessageView key={`u-${i}`} message={m} description={run.description} />
          ) : (
            <AssistantMessageView key={`a-${i}`} message={m} />
          ),
        )}
        {waiting ? (
          <p className="text-muted-foreground/70 py-4 text-center text-xs">
            子智能体已启动，等待活动流…
          </p>
        ) : null}
      </div>
    </ScrollingText>
  );
};
