"use client";

import dynamic from "next/dynamic";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  BookOpenIcon,
  BrainIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  Database,
  FileIcon,
  FileSearchCorner,
  FileSearchCornerIcon,
  FileSearchIcon,
  GlobeIcon,
  LoaderCircleIcon,
  LogOutIcon,
  NotebookPen,
  PencilIcon,
  PencilLineIcon,
  SearchCheckIcon,
  SearchIcon,
  SquareArrowOutUpRightIcon,
  SquareTerminalIcon,
  TargetIcon,
  TextSearchIcon,
} from "lucide-react";
import { openToolCallPanel } from "@/lib/tool-panel";
import { openExternal } from "@/lib/external-link";
import { fileChangePair, fileChangeStats } from "@/lib/panel-activity";
import { parseWebSearchResults, type WebSearchItem } from "@/lib/web-search";
import { PanelFileDiff } from "@/components/code/panel-diff";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * 消息里的工具调用扁平行（bash/read/edit/write/WebSearch/WebFetch/glob/grep/Submit*）：
 * 整行点击 → 原地展开/收起输出（Collapsible）；
 * 定向打开右侧 AgentPanel（lib/tool-panel）挂在行尾悬浮小按钮上，
 * 输出还没流出来时整行即开面板动作。分组/独立渲染同形。
 * read 是唯一不做展开的：整行/标题都是开面板「文件」标签的链接。
 */

/** 彩色文件图标（material-file-icons ~1.5MB）按需加载，消息列表主 chunk 不背它 */
const FileTypeIcon = dynamic(
  () =>
    import("@/components/agent-thread/agent-panel/file-type-icon").then(
      (m) => m.FileTypeIcon,
    ),
  {
    ssr: false,
    loading: () => <FileIcon className="size-4 shrink-0" />,
  },
);

export function splitPath(path: string): { dir: string; base: string } {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

/** sidecar 失败标记：非零退出码 `[exit code: N]`、超时 `[timeout]`（同 ToolFallback/panel-activity） */
const FAILED_RE = /\[exit code: |\[timeout\]/;

function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/**
 * 底部吸附的滚动文本视口（同 ReasoningText 的流式预览逻辑）：
 * 内容增长时自动滚到底；读者往上翻（滚动高度未变时的上移）即解除吸附，
 * 回到底部后重新吸附。
 */
const ScrollingText: FC<{ className?: string; children: ReactNode }> = ({
  className,
  children,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => {
      if (!pinned) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true;
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false;
      }
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={scrollRef} className={cn("relative overflow-y-auto", className)}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
};

export type ToolRowProps = {
  label: ReactNode;
  icon?: ReactNode;
  /** 主文本：文件名或命令 */
  primary?: ReactNode;
  /** 次文本：目录等（灰、truncate） */
  secondary?: ReactNode;
  /** primary 呈可点链接（悬浮出链接态；点击开面板、不触发展开收起） */
  primaryAsLink?: boolean;
  /** primary 的悬浮 title（链接态提示完整目标，如记忆文件的 scope/路径） */
  primaryTitle?: string;
  /** edit/write 行尾 ±统计（绿 +N / 红 −M） */
  stats?: { added: number; removed: number };
  mono?: boolean;
  running?: boolean;
  failed?: boolean;
  /** 行内可展开的输出（空则无展开箭头、整行改为开面板） */
  output?: string;
  /** 展开区内容覆写（edit/write 用 @pierre/diffs 视图替掉原始输出文本） */
  expandedContent?: ReactNode;
  /** 运行中（还没有输出）时，行下方显示这个滚动文本预览，行上主/次文本隐去 */
  preview?: ReactNode;
  /** 展开内容顶部的命令行（终端用：`$ 完整命令`），与输出共用一个框 */
  expandedHeader?: ReactNode;
  /** 打开右侧面板；有输出时是行尾悬浮小按钮，无输出时整行即此动作 */
  onOpenPanel?: () => void;
};

export const ToolRow: FC<ToolRowProps> = ({
  label,
  icon,
  primary,
  secondary,
  primaryAsLink,
  primaryTitle,
  stats,
  mono,
  running,
  failed,
  output,
  expandedContent,
  expandedHeader,
  preview,
  onOpenPanel,
}) => {
  const [open, setOpen] = useState(false);
  const hasOutput = !!output;
  const canExpand = hasOutput || expandedContent != null;
  // 展开内容顶部已有 `$ 命令` 时，行上的命令文本收起（终端行展开后只剩「终端」+箭头）
  const hideTexts = open && !!expandedHeader;

  const content = (
    <>
      {running ? (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
      ) : (
        icon
      )}
      <span className="shrink-0">{label}</span>
      {!hideTexts && !preview && primary ? (
        primaryAsLink && onOpenPanel ? (
          // 标题即面板入口：默认观感同普通文本，悬浮出超链接态；
          // 点击截在 span 内（stopPropagation），不触发整行的展开/收起
          <span
            title={primaryTitle}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onOpenPanel();
            }}
            className={cn(
              "min-w-0 cursor-pointer truncate decoration-1 underline-offset-2 hover:text-primary hover:underline",
              mono && "font-mono text-xs",
            )}
          >
            {primary}
          </span>
        ) : (
          <span
            title={primaryTitle}
            className={cn("min-w-0 truncate", mono && "font-mono text-xs")}
          >
            {primary}
          </span>
        )
      ) : null}
      {!hideTexts && !preview && secondary ? (
        <span className="min-w-0 truncate text-xs opacity-60">{secondary}</span>
      ) : null}
      {!hideTexts && !preview && stats ? (
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
          {stats.added > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              +{stats.added}
            </span>
          ) : null}
          {stats.removed > 0 ? (
            <span className="text-rose-500 dark:text-rose-400">
              −{stats.removed}
            </span>
          ) : null}
        </span>
      ) : null}
      {failed ? (
        <span
          aria-hidden
          title="失败"
          className="bg-destructive size-1.5 shrink-0 rounded-full"
        />
      ) : null}
    </>
  );

  // 展开框：顶部可选命令行（$ 完整命令）+ 下方输出；输出独立滚动，命令行常驻
  const outputBox = (
    <div className="bg-background border rounded-md  px-3 py-2 font-mono text-xs leading-relaxed">
      {expandedHeader ? (
        <div className="text-foreground/90 break-all whitespace-pre-wrap">
          {expandedHeader}
        </div>
      ) : null}
      {output ? (
        <pre
          className={cn(
            "max-h-64 overflow-auto whitespace-pre-wrap",
            expandedHeader && "mt-2  pt-2",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {output}
        </pre>
      ) : null}
    </div>
  );

  // 有输出/自定义展开内容：整行是展开触发器（Collapsible），开面板动作挪到行尾悬浮小按钮
  if (canExpand)
    return (
      <Collapsible
        data-slot="aui_tool-row"
        className="text-sm"
        open={open}
        onOpenChange={setOpen}
        style={{ "--animation-duration": "350ms" } as CSSProperties}
      >
        <div className="group/row flex items-center">
          {/* 触发器样式对齐 reasoning 的 trigger：灰字 hover 变深、无背景色块、按压微缩放 */}
          <CollapsibleTrigger className="group/trigger text-muted-foreground hover:text-foreground flex min-w-0 flex-1 origin-left cursor-pointer items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]">
            {content}
            <ChevronDownIcon className="mt-0.5 size-4 shrink-0 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none -rotate-90 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0" />
          </CollapsibleTrigger>
          {onOpenPanel ? (
            <button
              type="button"
              onClick={onOpenPanel}
              aria-label="在面板中打开"
              title="在面板中打开"
              className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded p-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <SquareArrowOutUpRightIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        {/* 展开动画与 reasoning/工具组同款：height keyframes + 缓动曲线 */}
        <CollapsibleContent
          className={cn(
            "relative overflow-hidden outline-none",
            "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
            "data-closed:animate-collapsible-up",
            "data-open:animate-collapsible-down",
            "data-closed:fill-mode-forwards",
            "data-closed:pointer-events-none",
            "[--tw-duration:var(--animation-duration)]",
          )}
        >
          {expandedContent ?? outputBox}
        </CollapsibleContent>
      </Collapsible>
    );

  // 无输出（多为运行中）：有面板目标则整行开面板，否则纯展示行；视觉同款 reasoning trigger
  return (
    <div data-slot="aui_tool-row" className="text-sm">
      {onOpenPanel ? (
        <button
          type="button"
          onClick={onOpenPanel}
          className="group/trigger text-muted-foreground hover:text-foreground flex min-w-0 flex-1 origin-left cursor-pointer items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]"
        >
          {content}
        </button>
      ) : (
        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 py-1.5">
          {content}
        </span>
      )}
      {/* 运行中：命令以滚动文本预览呈现（底部吸附），结束后换回可展开的输出行 */}
      {preview ? (
        <ScrollingText className="bg-muted/30 text-muted-foreground max-h-40 rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {preview}
        </ScrollingText>
      ) : null}
    </div>
  );
};

const BashToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
}) => {
  const command =
    typeof (args as { command?: unknown })?.command === "string"
      ? ((args as { command: string }).command)
      : "";
  const lines = command ? command.split("\n") : [];
  const output = resultText(result);
  const running = status?.type === "running";
  return (
    <ToolRow
      label="终端"
      icon={<SquareTerminalIcon className="size-4 shrink-0" />}
      primary={lines[0]}
      secondary={lines.length > 1 ? `…+${lines.length - 1}` : undefined}
      mono
      running={running}
      failed={isError === true || (!!output && FAILED_RE.test(output))}
      output={output}
      preview={running && command ? `$ ${command}` : undefined}
      expandedHeader={command ? `$ ${command}` : undefined}
      onOpenPanel={
        command
          ? () => openToolCallPanel("bash", toolCallId, { command })
          : undefined
      }
    />
  );
};

function strArg(args: unknown, key: string): string | null {
  const v = (args as Record<string, unknown> | undefined | null)?.[key];
  return typeof v === "string" ? v : null;
}

const fileToolUI =
  (toolName: "read" | "edit" | "write", label: string): ToolCallMessagePartComponent =>
  ({ toolCallId, args, result, status, isError }) => {
    const path = strArg(args, "file_path") ?? "";
    const { dir, base } = splitPath(path);
    const output = resultText(result);
    const failed = isError === true || (!!output && FAILED_RE.test(output));
    // edit/write 成功后的展开区用 @pierre/diffs 视图，old/new 取自
    // panel-activity 的 fileChangePair（与面板审查同一份语义）；
    // 失败保留错误输出文本。read 没有展开态——点行/点标题直接去面板「文件」标签看。
    const pair =
      toolName === "edit" || toolName === "write"
        ? fileChangePair(toolName, args)
        : null;
    const expandedContent =
      !failed && result && pair ? (
        <div className="bg-muted/30 max-h-96 overflow-auto rounded-md">
          <PanelFileDiff
            name={base}
            oldText={pair.oldText}
            newText={pair.newText}
          />
        </div>
      ) : undefined;
    return (
      <ToolRow
        label={label}
        // 会话中断/取消时 args 可能是 {}（历史 jsonl 里写盘工具留下空参数），
        // 没有路径也要有兜底图标：写类用铅笔，读取用文件
        icon={
          path ? (
            <FileTypeIcon path={path} />
          ) : toolName === "read" ? (
            <FileIcon className="size-4 shrink-0" />
          ) : (
            <PencilIcon className="size-4 shrink-0" />
          )
        }
        primary={base}
        secondary={dir}
        primaryAsLink
        stats={
          pair ? fileChangeStats(pair.oldText, pair.newText) : undefined
        }
        running={status?.type === "running"}
        failed={failed}
        // read 不传 output ⇒ 永远不可展开，整行/标题都是去面板「文件」标签的链接
        output={toolName === "read" ? undefined : output}
        expandedContent={expandedContent}
        onOpenPanel={
          path
            ? () => openToolCallPanel(toolName, toolCallId, { file_path: path })
            : undefined
        }
      />
    );
  };

/** WebSearch 失败标记：API 错误以 `WebSearch API error …` 文本返回（不抛异常） */
const WEB_SEARCH_ERR_RE = /^WebSearch API error/;

/**
 * 搜索结果展开区：标题（站点图标 + 外链，悬浮 title 显 href、点击走系统浏览器）
 * + 两行截断的摘要，替代原始文本倾倒；地址不占行，悬浮可见。
 */
const SearchResults: FC<{ items: WebSearchItem[] }> = ({ items }) => (
  <div className="bg-background border flex max-h-96 flex-col gap-3 overflow-auto rounded-md px-3 py-2.5">
    {items.map((r, i) => (
      <div key={i} className="min-w-0">
        {r.url ? (
          <a
            href={r.url}
            // 悬浮显示完整链接地址（webview 没有浏览器状态栏，title 是唯一入口）
            title={r.url}
            onClick={(e) => {
              // 桌面 webview 里 target=_blank 点了没反应，统一走系统浏览器
              e.preventDefault();
              openExternal(r.url!);
            }}
            className="text-foreground hover:text-primary flex min-w-0 items-center gap-1.5 text-sm leading-snug underline-offset-2 decoration-1 hover:underline"
          >
            <SiteIcon url={r.url} />
            <span className="line-clamp-1">{r.title}</span>
          </a>
        ) : (
          <div className="text-foreground line-clamp-1 text-sm leading-snug">
            {r.title}
          </div>
        )}
        {r.snippet ? (
          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
            {r.snippet}
          </div>
        ) : null}
      </div>
    ))}
  </div>
);

const WebSearchToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const query = strArg(args, "query") ?? "";
  const output = resultText(result);
  const failed = isError === true || WEB_SEARCH_ERR_RE.test(output);
  // 结果是 sidecar 装配好的固定格式才结构化渲染；解析不出来（纯文本兜底）
  // 维持原始输出框，不硬凑列表
  const items = !failed && output ? parseWebSearchResults(output) : null;
  return (
    <ToolRow
      label="网络搜索"
      icon={<SearchIcon className="size-4 shrink-0" />}
      primary={query}
      secondary={items ? `${items.length} 条结果` : undefined}
      running={status?.type === "running"}
      failed={failed}
      output={output}
      expandedContent={items ? <SearchResults items={items} /> : undefined}
    />
  );
};

const WebFetchToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
}) => {
  const url = strArg(args, "url") ?? "";
  const output = resultText(result);
  return (
    <ToolRow
      label="抓取网页"
      icon={<GlobeIcon className="size-4 shrink-0" />}
      primary={url}
      mono
      primaryAsLink
      running={status?.type === "running"}
      failed={isError === true}
      output={output}
      onOpenPanel={
        url
          ? () => openToolCallPanel("WebFetch", toolCallId, { url })
          : undefined
      }
    />
  );
};

/** glob/grep：中文标签+检索图标的扁平行，展开仍是原始匹配文本 */
const searchToolUI =
  (label: string, icon: ReactNode): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => {
    const pattern = strArg(args, "pattern") ?? "";
    const path = strArg(args, "path");
    const include = strArg(args, "include");
    const output = resultText(result);
    return (
      <ToolRow
        label={label}
        icon={icon}
        primary={pattern}
        secondary={
          [path, include].filter(Boolean).join(" · ") || undefined
        }
        mono
        running={status?.type === "running"}
        failed={isError === true}
        output={output}
      />
    );
  };

/** plan_write / 历史 SubmitPlan/SubmitGoal：无展开态，整行/标题都是去面板「文件」标签看计划 Markdown */
const submitToolUI =
  (
    toolName: string,
    label: string,
    icon: ReactNode,
    fallbackTitle = "",
  ): ToolCallMessagePartComponent =>
  ({ toolCallId, args, status }) => {
    const title = strArg(args, "title") || fallbackTitle;
    return (
      <ToolRow
        label={label}
        icon={icon}
        primary={title}
        primaryAsLink
        running={status?.type === "running"}
        onOpenPanel={() =>
          openToolCallPanel(toolName, toolCallId, { title }
          )
        }
      />
    );
  };

/** plan_enter / plan_exit：纯展示行（模式动作，无展开输出）；plan_exit 运行中 = 正挂起等批准 */
const modeSwitchToolUI =
  (label: string, icon: ReactNode, showRationale = false): ToolCallMessagePartComponent =>
  ({ args, status }) => (
    <ToolRow
      label={label}
      icon={icon}
      primary={showRationale ? strArg(args, "rationale") : undefined}
      running={status?.type === "running"}
    />
  );

/** 记忆作用域中文标签（sidecar 侧 scope 取值只有 global/workspace） */
const MEMORY_SCOPE_LABEL: Record<string, string> = {
  global: "全局",
  workspace: "工作区",
};

const scopeLabel = (args: unknown): string => {
  const scope = strArg(args, "scope") ?? "global";
  return MEMORY_SCOPE_LABEL[scope] ?? scope;
};

/** memory_write：展开区展示写入的记忆内容（Markdown），失败时展开看错误输出；
 * 文件名可点 → 面板「文件」标签回放写入快照（悬浮 title 显 scope/文件） */
const MemoryWriteToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
}) => {
  const file = strArg(args, "file") || "MEMORY.md";
  const mode = strArg(args, "mode") === "overwrite" ? "覆写" : "追加";
  const content = strArg(args, "content") ?? "";
  const output = resultText(result);
  const failed =
    isError === true || output.startsWith("memory_write failed");
  const scope = scopeLabel(args);
  return (
    <ToolRow
      label="记忆写入"
      icon={<PencilLineIcon className="size-4 shrink-0" />}
      primary={file}
      secondary={[scope, mode].join(" · ")}
      mono
      primaryAsLink
      primaryTitle={`记忆文件 · ${scope} / ${file}`}
      running={status?.type === "running"}
      failed={failed}
      output={failed ? output : undefined}
      expandedContent={
        !failed && content ? (
          <div className="bg-background border max-h-64 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {content}
          </div>
        ) : undefined
      }
      onOpenPanel={() =>
        openToolCallPanel("memory_write", toolCallId, {
          file: strArg(args, "file") ?? "",
        })
      }
    />
  );
};

/** memory_read：无 file 时是列出全部记忆文件，展开区是文件列表/文件内容原文；
 * 文件名可点 → 面板「文件」标签回放读取结果快照 */
const MemoryReadToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
}) => {
  const file = strArg(args, "file");
  const output = resultText(result);
  const scope = scopeLabel(args);
  return (
    <ToolRow
      label="记忆读取"
      icon={<Database className="size-4 shrink-0" />}
      primary={file ?? "文件列表"}
      secondary={scope}
      mono
      primaryAsLink
      primaryTitle={
        file ? `记忆文件 · ${scope} / ${file}` : `记忆文件列表 · ${scope}`
      }
      running={status?.type === "running"}
      failed={isError === true}
      output={output}
      onOpenPanel={() =>
        openToolCallPanel("memory_read", toolCallId, {
          file: strArg(args, "file") ?? "",
        })
      }
    />
  );
};

/** memory_search 命中行解析：sidecar 返回 `scope/rel:line: text` 每行一条 */
const parseMemoryHits = (
  output: string,
): { loc: string; text: string }[] =>
  output
    .split("\n")
    .map((line) => {
      const m = /^(.+?):(\d+): (.*)$/.exec(line);
      return m ? { loc: `${m[1]}:${m[2]}`, text: m[3] } : null;
    })
    .filter((h): h is { loc: string; text: string } => h !== null);

const MemoryHits: FC<{ hits: { loc: string; text: string }[] }> = ({
  hits,
}) => (
  <div className="bg-background border max-h-96 overflow-auto rounded-md px-3 py-2.5">
    {hits.map((h, i) => (
      <div key={i} className="min-w-0">
        <div className="text-muted-foreground line-clamp-1 font-mono text-[11px]">
          {h.loc}
        </div>
        <div className="text-foreground line-clamp-2 text-sm leading-snug">
          {h.text}
        </div>
      </div>
    ))}
  </div>
);

const MemorySearchToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const query = strArg(args, "query") ?? "";
  const output = resultText(result);
  // 只有逐行 `path:line: text` 格式才结构化渲染；「No matches…」等保持原始输出
  const hits = !isError && output ? parseMemoryHits(output) : [];
  const structured = hits.length > 0;
  return (
    <ToolRow
      label="记忆检索"
      icon={<SearchCheckIcon className="size-4 shrink-0" />}
      primary={query}
      secondary={structured ? `${hits.length} 条命中` : undefined}
      mono
      running={status?.type === "running"}
      failed={isError === true}
      output={structured ? undefined : output}
      expandedContent={structured ? <MemoryHits hits={hits} /> : undefined}
    />
  );
};

/** 有专属扁平行渲染的工具名 → 组件；其余走 ToolFallback */
export const AGENT_TOOL_UI: Record<string, ToolCallMessagePartComponent> = {
  bash: BashToolUI,
  read: fileToolUI("read", "读取"),
  edit: fileToolUI("edit", "编辑"),
  write: fileToolUI("write", "写入"),
  WebSearch: WebSearchToolUI,
  WebFetch: WebFetchToolUI,
  glob: searchToolUI("文件检索", <SearchIcon className="size-4 shrink-0" />),
  grep: searchToolUI("内容检索", <SearchIcon className="size-4 shrink-0" />),
  memory_write: MemoryWriteToolUI,
  memory_read: MemoryReadToolUI,
  memory_search: MemorySearchToolUI,
  plan_enter: modeSwitchToolUI("进入计划模式", <ClipboardListIcon className="size-4 shrink-0" />),
  plan_write: submitToolUI(
    "plan_write",
    "写计划",
    <ClipboardCheckIcon className="size-4 shrink-0" />,
    "计划",
  ),
  plan_exit: modeSwitchToolUI("申请批准计划", <LogOutIcon className="size-4 shrink-0" />, true),
  // 历史转录兼容：旧模式工具（已退役，点击仍可在面板里看当时的提案快照）
  SubmitPlan: submitToolUI("SubmitPlan", "计划", <ClipboardListIcon className="size-4 shrink-0" />),
  SubmitGoal: submitToolUI("SubmitGoal", "目标", <TargetIcon className="size-4 shrink-0" />),
};
