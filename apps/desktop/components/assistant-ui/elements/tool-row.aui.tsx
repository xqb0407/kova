"use client";

import dynamic from "next/dynamic";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { t } from "@/lib/i18n";
import { McpAppDialog, type McpAppLaunch } from "./mcp-app-dialog";
import {
  BotIcon,
  BookMarkedIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  Code2Icon,
  Database,
  EyeIcon,
  FileIcon,
  FileSearchCorner,
  FileSearchCornerIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  LoaderCircleIcon,
  LogOutIcon,
  NotebookPen,
  PaletteIcon,
  PencilLineIcon,
  PlugIcon,
  PuzzleIcon,
  SearchCheckIcon,
  SearchIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  SquareTerminalIcon,
  TargetIcon,
  TextSearchIcon,
  XIcon,
} from "lucide-react";
import { openToolCallPanel } from "@/lib/panels/tool-panel";
import {
  RunCodeExpanded,
  RunCodeStatusPips,
  splitRunCodeReceipt,
  stripRunCodeHeader,
  useRunCodeElapsed,
  type PtcDetailsView,
} from "./run-code-card";
import { useCurrentAppMode } from "@/lib/pi/pi-session-app-mode";
import { useIsAskMode } from "@/lib/pi/pi-session-mode";
import { TaskDelegationCard } from "./task-delegation-card.aui";
import { openExternal } from "@/lib/external-link";
import { fileChangeHunks, fileChangeStatsFor } from "@/lib/panels/panel-activity";
import { parseWebSearchResults, type WebSearchItem } from "@/lib/pi/web-search";
import { browserToolLabel, browserToolSummary } from "@/lib/tools/browser-tool-summary";
import { toolCategory, type ToolCategory } from "./tool-category";
import { ImageGeneration } from "@/components/agents/image-generation";
import { PanelFileDiff } from "@/components/code/panel-diff";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  toolCallMetaText,
  toolCallMetaTitle,
  useToolCallMeta,
} from "./tool-call-meta";

/**
 * 消息里的工具调用扁平行（bash/read/edit/write/WebSearch/WebFetch/glob/grep/Submit*）：
 * 整行点击 → 原地展开/收起输出（Collapsible）；终端行运行中自动摊开（实时
 * 输出底部吸附），运行结束自动收回；
 * 定向打开右侧 AgentPanel（lib/tool-panel）挂在行尾悬浮小按钮上，
 * 输出还没流出来时整行即开面板动作。分组/独立渲染同形。
 * read 是唯一不做展开的：整行/标题都是开面板「文件」标签的链接；AGENTS.md /
 * CLAUDE.md 的 read 另走「读取指令」行（书本图标 + 蓝色文件名），与普通查看区分。
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

/** 指令文件按 basename 识别：AGENTS.md / CLAUDE.md（含 .claude/CLAUDE.md、大小写变体） */
const INSTRUCTION_FILE_BASENAMES = new Set(["agents.md", "claude.md"]);

function isInstructionFile(path: string): boolean {
  return INSTRUCTION_FILE_BASENAMES.has(splitPath(path).base.toLowerCase());
}

/** sidecar 失败标记：非零退出码 `[exit code: N]`、超时 `[timeout]`（同 ToolFallback/panel-activity） */
const FAILED_RE = /\[exit code: |\[timeout\]/;

function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  // 错误输出（state=output-error）经 convertMessage 包成 {error: errorText}：
  // 剥出原文展示，避免失败行渲染成 JSON 转储
  if (typeof result === "object" && "error" in result) {
    const err = (result as { error?: unknown }).error;
    if (typeof err === "string") return err;
  }
  return JSON.stringify(result, null, 2);
}

type SandboxInfo = {
  tier?: "workspace";
  backend?: "seatbelt" | "host" | "none";
  network?: "allow" | "deny";
  denied?: "write" | "read" | "network" | "unavailable";
};

/** 工具行沙箱 badge：成功态来自 artifact.sandbox；宿主拒绝时没有 artifact，
 *  由错误文案里的 `sandbox:` 前缀兜底标记。 */
export function SandboxBadge({
  artifact,
  result,
  isError,
}: {
  artifact?: unknown;
  result?: unknown;
  isError?: boolean;
}) {
  const info = (artifact as { sandbox?: SandboxInfo } | undefined)?.sandbox;
  const text = resultText(result);
  const denied =
    info?.denied !== undefined ||
    (isError === true && /\bsandbox:\s/.test(text));
  if (!info && !denied) return null;
  const label = denied
    ? "sandbox denied"
    : info?.backend === "none"
      ? "no OS sandbox"
      : "sandboxed";
  const tone = denied
    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
    : info?.backend === "none"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  return (
    <span
      title={`tier=${info?.tier ?? "workspace"} backend=${info?.backend ?? "none"} network=${info?.network ?? "allow"}`}
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-3xs leading-none",
        tone,
      )}
    >
      {label}
    </span>
  );
}

/**
 * 底部吸附的滚动文本视口（同 ReasoningText 的流式预览逻辑）：
 * 内容增长时自动滚到底；读者往上翻（滚动高度未变时的上移）即解除吸附，
 * 回到底部后重新吸附。
 */
export const ScrollingText: FC<{ className?: string; children: ReactNode }> = ({
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
      // 拖拽调宽期间正文每帧 rewrap：跳过逐帧 scrollHeight/scrollTop 写入，
      // 松手后 resize-settled 补一次
      if (isResizing()) return;
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
    // 容器自身尺寸变化（展开动画期间视口从 0 长到 max-h）也要重新吸附：
    // 只盯内容的话，动画跑完这一刻视口会停在半途，等下一次内容增长才补上
    observer.observe(scrollEl);
    const offSettled = onResizeSettled(pin);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
      offSettled();
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
  /** 行首类别图标（与折叠组头同形：写=铅笔、查看/检索=放大镜…） */
  icon?: ReactNode;
  /** 行内状态 badge（沙箱等） */
  badge?: ReactNode;
  /** 文件类型图标：渲染在 label 文字右侧（写/读行「类别图标+文字+文件类型图标」的排布） */
  fileIcon?: ReactNode;
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
  /** 展开内容顶部的命令行（终端用：`$ 完整命令`），与输出共用一个框 */
  expandedHeader?: ReactNode;
  /** 打开右侧面板；有输出时是行尾悬浮小按钮，无输出时整行即此动作 */
  onOpenPanel?: () => void;
  /** false = 不显示耗时/token 元信息（如 Task 行已有子智能体自己的计时） */
  showMeta?: boolean;
};

export const ToolRow: FC<ToolRowProps> = ({
  label,
  icon,
  badge,
  fileIcon,
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
  onOpenPanel,
  showMeta = true,
}) => {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // 统一由 assistant-message 分发处注入；无 meta 时（独立复用 ToolRow）为 null
  const meta = useToolCallMeta();
  const metaText = toolCallMetaText(meta);
  const metaTitle = toolCallMetaTitle(meta);
  // 两个档位 hook 必须各自无条件调用：写成 `useCurrentAppMode() === "work" || useIsAskMode()`
  // 会让 useIsAskMode 的 hook 数量随档位短路变化，切档（工作 ⇄ 代码/设计）即触发
  // React #310（Rendered more hooks than during the previous render，生产环境直接崩主区）
  const appMode = useCurrentAppMode();
  const askMode = useIsAskMode();
  // 本会话工作模式为「工作」与问答档：过程细节收敛——不渲染行内输出展开/流式预览，
  // 行只剩摘要（保留 ±N 统计与开面板动作）；详情走右侧面板
  const compact = appMode === "work" || askMode;
  const hasOutput = !compact && !!output;
  // 运行中的实时视口（终端）：命令行 + 已在流出的输出即时可看，且底部吸附跟最新
  // 一行；行运行一结束自动收回，结束态另按 hasOutput 展开回看
  const liveOutput =
    !compact && running === true && (!!expandedHeader || !!output);
  // 可展开 = 运行中有实时视口；或结束后有输出/自定义展开区（edit/write 的差异视图）
  const canExpand =
    liveOutput || hasOutput || (!compact && expandedContent != null);
  // 运行中自动摊开：过程进行时把输出视口打开，运行结束自动收回；用户手动开合过
  // 就以用户为准（对齐思考块的 streaming 语义）。
  // autoArmed 是硬跳的解法：挂载即"该展开"（终端行随工具调用出现）时，先以收起
  // 状态落一帧再翻 open——Base UI 对"挂载时就是开着"的面板会抑制高度动画
  // （shouldPreventMountAnimation），直接就位是一帧内的硬跳（消息瞬间拉高）；
  // 晚一帧（layout effect，绘制前完成，看不到收起帧）才拿到 0→内容高度的动画
  const autoOpen = running === true && canExpand;
  const [autoArmed, setAutoArmed] = useState(false);
  useLayoutEffect(() => {
    if (autoOpen && !autoArmed) setAutoArmed(true);
  }, [autoOpen, autoArmed]);
  const open = userOpen ?? (autoOpen && autoArmed);
  // 展开内容顶部已有 `$ 命令` 时，行上的命令文本收起（终端行展开后只剩「终端」+箭头）
  const hideTexts = open && !!expandedHeader;

  const content = (
    <>
      {icon}
      {/* 运行中标签保持静态：同一轮已有分隔线扫光作为运行信号，
          工具行大量并发时不额外堆动画 */}
      <span className="shrink-0">
        {label}
      </span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
      {fileIcon ? (
        <span className="inline-flex shrink-0 items-center">{fileIcon}</span>
      ) : null}
      {!hideTexts && primary ? (
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
      {/* secondary 限宽 45%：长摘要（如技能正文预览、文件行的长目录）不再
          挤掉 primary——主文本优先保位，次文本自己截断 */}
      {!hideTexts && secondary ? (
        <span className="min-w-0 max-w-[45%] truncate text-xs opacity-60">
          {secondary}
        </span>
      ) : null}
      {!hideTexts && stats ? (
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

  // 耗时/用量：独立的行尾列（不放进 content）。展开行有 chevron + 面板按钮、
  // 纯展示行没有，放进 content 时两档行的时间右缘会差一个尾槽位；移到行级
  // 后两档都排在同一个尾槽前，右缘一致。min-w + text-right：没有时间的行
  // 也保留空列，整列对齐（tabular-nums 保证数字宽度稳定）。
  const metaSlot = showMeta ? (
    <span
      title={metaTitle}
      className="text-muted-foreground min-w-14 shrink-0 text-right font-mono text-xs tabular-nums"
    >
      {metaText}
    </span>
  ) : null;

  // 展开框：顶部可选命令行（$ 完整命令）+ 下方输出；样式对齐运行中的滚动
  // 预览（灰底无边框），输出限高折叠（内部滚动），命令行常驻
  const outputBox = (
    <div className="bg-background border rounded-md px-3 py-2 font-mono text-xs leading-relaxed">
      {expandedHeader ? (
        <div className="text-foreground/90 break-all whitespace-pre-wrap">
          {expandedHeader}
        </div>
      ) : null}
      {output ? (
        <pre
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap",
            expandedHeader && "mt-2  pt-2",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {output}
        </pre>
      ) : null}
    </div>
  );

  // 运行中的实时视口：命令行常驻（别被输出滚走——运行中行上不显示命令，这里
  // 是唯一提示），输出区底部吸附跟最新一行；结束后换回可自由回看的静态框
  const liveBox =
    expandedHeader || output ? (
      <div className="bg-background border rounded-md px-3 py-2 font-mono text-xs leading-relaxed">
        {expandedHeader ? (
          <div className="text-foreground/90 break-all whitespace-pre-wrap">
            {expandedHeader}
          </div>
        ) : null}
        {output ? (
          <ScrollingText
            className={cn(
              "max-h-40 whitespace-pre-wrap",
              expandedHeader && "mt-2 pt-2",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {output}
          </ScrollingText>
        ) : null}
      </div>
    ) : null;

  // 展开区内容：运行中走实时视口，结束后是静态输出框（或自定义展开区）
  const expandBody =
    expandedContent ?? (running ? liveBox : hasOutput ? outputBox : null);
  // 自定义展开内容（编辑/写入的 diff、记忆正文、检索命中）走内容侧的 grid 轨道
  // 折叠：diff 是懒加载的（dynamic 组件 + worker 高亮），点开那一刻框里还是空的，
  // 面板的一次性高度目标（--collapsible-panel-height）只能量到空框，会把内容裁到
  // 动画跑完才放出来。轨道折叠动画的是比例（0fr→1fr），目标跟着内容实时长。
  const foldContent = expandedContent != null;

  // 有输出/自定义展开内容/运行中流式预览：整行是展开触发器（Collapsible，
  // 默认收起，运行中自动摊开），开面板动作挪到行尾悬浮小按钮
  if (canExpand)
    return (
      <Collapsible
        data-slot="aui_tool-row"
        className="min-w-0 text-sm"
        open={open}
        onOpenChange={(v) => setUserOpen(v)}
        style={{ "--animation-duration": "350ms" } as CSSProperties}
      >
        <div className="group/row flex min-w-0 items-center">
          {/* 触发器样式对齐 reasoning 的 trigger：灰字 hover 变深、无背景色块、按压微缩放 */}
          <CollapsibleTrigger className="group/trigger text-muted-foreground hover:text-foreground flex min-w-0 flex-1 origin-left cursor-pointer items-center gap-2 py-1.5 text-sm transition-[color,scale] ">
            {content}
            <ChevronDownIcon className="mt-0.5 size-4 shrink-0 transition-[transform,opacity] duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none -rotate-90 opacity-0 group-hover/row:opacity-100 group-focus-visible/trigger:opacity-100 group-data-open/trigger:opacity-100 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0" />
          </CollapsibleTrigger>
          {metaSlot}
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
          ) : (
            // 占位与按钮同盒（p-1 + size-3.5）：没有面板目标的行也要让出这一格，
            // 否则行尾箭头的水平位置在有/无按钮的行之间漂移 ~26px（终端 vs
            // 检索类，2026-11-07 用户观察）
            <span
              aria-hidden
              className="shrink-0 p-1 opacity-0 select-none"
            >
              <SquareArrowOutUpRightIcon className="size-3.5" />
            </span>
          )}
        </div>
        {/* 展开动画与 reasoning/工具组同款：height keyframes + 缓动曲线；
            自定义展开内容（foldContent）只留收起方向——展开由 .tool-row-fold 的
            轨道折叠驱动（目标高度跟着内容实时长，见 globals.css 的注释） */}
        <CollapsibleContent
          className={cn(
            "relative overflow-hidden outline-none",
            "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
            "data-closed:animate-collapsible-up",
            !foldContent && "data-open:animate-collapsible-down",
            "data-closed:fill-mode-forwards",
            "data-closed:pointer-events-none",
            "[--tw-duration:var(--animation-duration)]",
          )}
        >
          {foldContent ? (
            <div className="tool-row-fold">
              <div>{expandBody}</div>
            </div>
          ) : (
            expandBody
          )}
        </CollapsibleContent>
      </Collapsible>
    );

  // 无输出无预览（多为运行中）：有面板目标则整行开面板，否则纯展示行；
  // 视觉同款 reasoning trigger。button 的 width:auto 是 fit-content（不像 div
  // 那样撑满父容器），这里的父级是普通块盒，flex-1 无处生效——长命令会把
  // 按钮撑到列宽之外（compact 档下所有行都走本分支，实测顶破消息列），
  // 必须显式 w-full 锁回容器宽，primary 的 truncate 才有边界可截
  return (
    <div data-slot="aui_tool-row" className="min-w-0 text-sm">
      <div className="group/row flex min-w-0 items-center">
        {onOpenPanel ? (
          <button
            type="button"
            onClick={onOpenPanel}
            className="group/trigger text-muted-foreground hover:text-foreground flex min-w-0 flex-1 origin-left cursor-pointer items-center gap-2 py-1.5 text-sm transition-[color,scale] "
          >
            {content}
          </button>
        ) : (
          <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 py-1.5">
            {content}
          </span>
        )}
        {metaSlot}
        {/* 与展开行的面板按钮同宽占位：两档行的时间列右缘才会对齐 */}
        <span aria-hidden className="shrink-0 p-1 opacity-0 select-none">
          <SquareArrowOutUpRightIcon className="size-3.5" />
        </span>
      </div>
    </div>
  );
};

/** 终端行的命令行（展开区顶部 / 运行中流式预览共用）：`$` 提示符绿色加粗高亮，
 *  命令正文随所在容器的文本色（展开区 foreground/90、预览 muted-foreground）。 */
const TerminalCommandLine: FC<{ command: string }> = ({ command }) => (
  <>
    <span className="font-bold text-emerald-600 dark:text-emerald-400">$</span>{" "}
    {command}
  </>
);

const BashToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  result,
  status,
  isError,
  artifact,
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
      badge={
        <SandboxBadge artifact={artifact} result={result} isError={isError} />
      }
      icon={<SquareTerminalIcon className="size-4 shrink-0" />}
      primary={lines[0]}
      secondary={lines.length > 1 ? `…+${lines.length - 1}` : undefined}
      mono
      running={running}
      failed={isError === true || (!!output && FAILED_RE.test(output))}
      output={output}
      expandedHeader={
        command ? <TerminalCommandLine command={command} /> : undefined
      }
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
  ({ toolCallId, args, result, status, isError, artifact }) => {
    const path = strArg(args, "file_path") ?? "";
    const { dir, base } = splitPath(path);
    const output = resultText(result);
    const failed = isError === true || (!!output && FAILED_RE.test(output));
    // edit/write 成功后的展开区用 @pierre/diffs 视图，old/new 取自
    // panel-activity 的 fileChangeHunks（与面板审查同一份语义）；批量 edit
    // 按成员分块渲染，统计按块求和。失败保留错误输出文本。read 没有展开态——
    // 点行/点标题直接去面板「文件」标签看。
    // change/stats 按 args 引用 memo：流式期间每个 delta 都换新 args 对象，
    // write 正文又可达 MB 级——不 memo 的话每次渲染都重新抽块、数 ± 行
    // （stats 里还有行级 LCS）。args 稳定（收尾后）时整块跳过。
    const change = useMemo(
      () =>
        toolName === "edit" || toolName === "write"
          ? fileChangeHunks(toolName, args)
          : null,
      [toolName, args],
    );
    const stats = useMemo(
      () => (change ? fileChangeStatsFor(change.hunks) : undefined),
      [change],
    );
    const running = status?.type === "running";
    // 大文件运行中不自动展开 diff：ToolRow 的 autoOpen 会在 running 时挂载
    // PanelFileDiff（懒加载 + worker 高亮 + 整棵 diff DOM），几百 KB 的
    // 块展开就是一次秒级长任务；收尾后再按需展开（用户点开不受限）。
    const HUGEDIFF_AUTO_OPEN_LIMIT = 100_000;
    const hugeDiff =
      running &&
      (change?.hunks.some((hunk) => hunk.newText.length > HUGEDIFF_AUTO_OPEN_LIMIT) ?? false);
    const expandedContent =
      !failed && result && change && !hugeDiff ? (
        <div className="bg-white dark:bg-background max-h-96 overflow-auto rounded-md p-2 border">
          {change.hunks.map((hunk, index) => (
            <div
              key={index}
              className={index > 0 ? "border-border/40 mt-2 border-t pt-2" : undefined}
            >
              {/* wrap：窄预览框强制换行，避免长行横向滚动时文本穿过透明 sticky 行号列（见 PanelFileDiff 注释） */}
              <PanelFileDiff name={base} oldText={hunk.oldText} newText={hunk.newText} wrap />
            </div>
          ))}
        </div>
      ) : undefined;
    return (
      <ToolRow
        label={label}
        badge={
          <SandboxBadge artifact={artifact} result={result} isError={isError} />
        }
        // 行首类别图标与折叠组头同形：写类=铅笔、查看=放大镜；文件类型图标
        // 挪到「写入/查看」文字右侧。args 中断/取消可能为 {}（历史 jsonl
        // 写盘工具留空参数），无路径时不渲染文件类型图标。
        icon={
          toolName === "read" ? (
            <SearchIcon className="size-4 shrink-0" />
          ) : (
            <PencilLineIcon className="size-4 shrink-0" />
          )
        }
        fileIcon={path ? <FileTypeIcon path={path} /> : undefined}
        primary={base}
        secondary={dir}
        primaryAsLink
        stats={stats}
        running={running}
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

/**
 * AGENTS.md / CLAUDE.md：内容由 sidecar 自动注入系统提示词，读它们不是普通源码
 * 勘察——书本图标 + 「读取指令」标签 + 蓝色文件名单独成行，和普通「查看」区分。
 * 点行/标题仍开面板「文件」标签；与 read 一样不做行内展开。
 */
const InstructionReadToolUI: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  status,
  isError,
}) => {
  const path = strArg(args, "file_path") ?? "";
  const { dir, base } = splitPath(path);
  return (
    <ToolRow
      label="读取指令"
      icon={<BookMarkedIcon className="size-4 shrink-0" />}
      fileIcon={path ? <FileTypeIcon path={path} /> : undefined}
      primary={<span className="font-medium text-blue-400">{base}</span>}
      secondary={dir}
      primaryAsLink
      primaryTitle={`指令文件 · ${path}`}
      running={status?.type === "running"}
      failed={isError === true}
      onOpenPanel={
        path
          ? () => openToolCallPanel("read", toolCallId, { file_path: path })
          : undefined
      }
    />
  );
};

const FileReadToolUI = fileToolUI("read", "查看");

/** read 分发：指令文件走独立行，其余保持普通「查看」行 */
const ReadToolUI: ToolCallMessagePartComponent = (props) => {
  const path = strArg(props.args, "file_path") ?? "";
  return isInstructionFile(path) ? (
    <InstructionReadToolUI {...props} />
  ) : (
    <FileReadToolUI {...props} />
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
  artifact,
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
      badge={
        <SandboxBadge artifact={artifact} result={result} isError={isError} />
      }
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
  artifact,
}) => {
  const url = strArg(args, "url") ?? "";
  const output = resultText(result);
  return (
    <ToolRow
      label="抓取网页"
      badge={
        <SandboxBadge artifact={artifact} result={result} isError={isError} />
      }
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

/** kb_search：知识检索的紧凑行；展开仍是原始命中文本 */
const KbSearchToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const query = strArg(args, "query") ?? "";
  const scope = strArg(args, "scope");
  return (
    <ToolRow
      label="知识检索"
      icon={<SearchCheckIcon className="size-4 shrink-0" />}
      primary={query}
      secondary={scope && scope !== "all" ? `范围：${scope}` : undefined}
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );
};

/** kb_read：读取单条知识的紧凑行（路径 + 来源/项目根） */
const KbReadToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const source = strArg(args, "source") ?? "";
  const path = strArg(args, "path") ?? "";
  const root = strArg(args, "root");
  const sourceLabel =
    source === "library"
      ? "资料库"
      : source === "project"
        ? "项目"
        : source === "memory"
          ? "记忆"
          : source;
  const rootLabel = root ? (/[\\/]/.test(root) ? splitPath(root).base : root) : "";
  return (
    <ToolRow
      label="读取资料"
      icon={<BookOpenIcon className="size-4 shrink-0" />}
      primary={path}
      secondary={
        [sourceLabel, rootLabel].filter(Boolean).join(" · ") || undefined
      }
      mono
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
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
        <div className="text-muted-foreground line-clamp-1 font-mono text-xs">
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

/** Task 委派行的卡片实现见 task-delegation-card.aui（TOOL_UI 里直接挂 TaskDelegationCard） */

/** 子智能体工具组的非 Task 行（TaskWait / TaskList / TaskStop / SendMessage）：
 *  与 Task 行同族的一行式条目，展开看回执/报告原文。Task 的委派行另开面板，
 *  这里收敛/管理动作没有面板目标，行内展开是唯一出口。 */
const delegationIdsArg = (args: unknown): string[] => {
  const v = (args as { delegationIds?: unknown } | undefined)?.delegationIds;
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
};

/** delegationIds 缺省时 TaskWait/TaskStop 作用于全部运行中的委派 */
const delegationTargets = (args: unknown): string => {
  const ids = delegationIdsArg(args);
  return ids.length ? ids.join(" · ") : "全部";
};

const subagentOpToolUI =
  (
    label: string,
    primaryOf: (args: unknown) => string | undefined = () => undefined,
  ): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => {
    const output = resultText(result);
    return (
      <ToolRow
        label={label}
        icon={<BotIcon className="size-4 shrink-0" />}
        primary={primaryOf(args)}
        mono
        running={status?.type === "running"}
        // 报告正文会拼进子代理自己的 bash 输出：不能拿 [exit code:] 判整行失败，
        // 等待超时也不是失败（sidecar 明确说明未完成的委派继续运行）
        failed={isError === true}
        output={output}
      />
    );
  };

/** 管理面工具（子智能体/技能/插件/设计主题定义的查增删）：动作只回执文本，
 *  行内展开看结果；name/id 参数决定 primary。 */
const mgmtToolUI =
  (
    label: string,
    icon: ReactNode,
    keys: readonly string[],
  ): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => {
    const primary = keys
      .map((k) => strArg(args, k))
      .find((v): v is string => !!v);
    const output = resultText(result);
    return (
      <ToolRow
        label={label}
        icon={icon}
        primary={primary}
        running={status?.type === "running"}
        // 管理面失败以普通文本返回（`错误：…`，isError 不置真），同 SkillToolUI
        failed={isError === true || output.startsWith("错误：")}
        output={output}
      />
    );
  };

/** use_skill：「调用技能 · 名称」行，形态对齐终端——收起态只有名称
 *  （名称后不挂预览文本），整行可点展开看完整回执（Collapsible 输出框，
 *  work 模式与终端一样收敛展开态）；长名悬浮看全；
 *  失败（sidecar 以「错误：」文本返回）行尾红点、展开看错误 */
const SkillToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const name = strArg(args, "name") ?? "";
  const output = resultText(result);
  const failed = isError === true || output.startsWith("错误：");
  return (
    <ToolRow
      label="调用技能"
      icon={<BookOpenIcon className="size-4 shrink-0" />}
      primary={<div className="font-black text-blue-400">
      {name}
      </div>}
      primaryTitle={name}
      mono
      running={status?.type === "running"}
      failed={failed}
      output={output}
    />
  );
};

/** "1024x1024"/"1024×1792" → 宽高；"auto"/缺省 → null */
const parseImageSize = (size: string | null): { w: number; h: number } | null => {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec((size ?? "").trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

/** 预估出图秒数（占位卡 "Estimated ~Xs" 文案）：1792 级及以上更慢；网关排队时
 *  只是估计，取偏保守的档位即可，超时兜底在服务端（GENERATE_TIMEOUT_MS） */
const imageGenEstimateSeconds = (size: string | null): number => {
  const px = parseImageSize(size);
  if (px && px.w * px.h >= 1_500_000) return 60;
  return 45;
};

/**
 * generate_image：生图网关普遍要几十秒，通用行的空转圈等待不好看——运行中
 * 用 ImageGeneration 的 202 占位卡：左对齐定宽瓦片（fluid + 显式宽度，compact
 * 变体是页面展示用的居中样式，消息流里不用），头部「图标 + 生成图片」一行，
 * 瓦片右上角 "Estimated ~Xs" 徽章；状态行与标题重复，showStatus 关掉；
 * animated=false 入场一步到位（消息流里要干脆利落，页面展示才用渐变）。
 * 成图由 data-image part 紧跟卡片之后上屏（投影链路见 docs/image-part-design.md），
 * 结果到达后本行收敛为紧凑结果行。婉拒/失败结果（无图纯文本）同走行，展开看原文。
 */
const GenerateImageToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const size = strArg(args, "size");
  const running = status?.type === "running";
  if (running) {
    const px = parseImageSize(size);
    const portrait = !!px && px.h > px.w;
    return (
      <ImageGeneration
        status="generating"
        title="生成图片"
        titleIcon={<SparklesIcon className="size-4 shrink-0" />}
        showStatus={false}
        animated={false}
        resolution={`Estimated ~${imageGenEstimateSeconds(size)}s`}
        aspectRatio={px ? `${px.w} / ${px.h}` : "1 / 1"}
        size="fluid"
        tileClassName="border"
        className={cn("my-1.5 w-64", portrait && "w-40")}
      />
    );
  }
  const output = resultText(result);
  return (
    <ToolRow
      label="生成图片"
      icon={<SparklesIcon className="size-4 shrink-0" />}
      primary={output.split("\n")[0] || undefined}
      failed={isError === true || (!!output && FAILED_RE.test(output))}
      output={output}
    />
  );
};

/** see_image：视觉辅助工具——纯文本模型按 imageId 调视觉模型看图，结果是一段
 *  文本回答（`[vision model answer | …]` 包裹），行内展开看全文；问题作为
 *  primary，imageId 退居次文本。 */
const SeeImageToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const question = strArg(args, "question");
  const imageId = strArg(args, "imageId");
  return (
    <ToolRow
      label="查看图片"
      icon={<EyeIcon className="size-4 shrink-0" />}
      primary={question || imageId || "最近的图片"}
      secondary={question && imageId ? imageId : undefined}
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );
};

/** screenshot：截取真实屏幕（结果同时带 image part），行本身只回执尺寸/体积 */
const ScreenshotToolUI: ToolCallMessagePartComponent = ({
  result,
  status,
  isError,
}) => {
  const output = resultText(result);
  return (
    <ToolRow
      label="屏幕截图"
      icon={<CameraIcon className="size-4 shrink-0" />}
      running={status?.type === "running"}
      failed={isError === true || (!!output && FAILED_RE.test(output))}
      output={output}
    />
  );
};

/** echo_image：图片投影链路的验收工具（临时注册），回显一张图片 */
const EchoImageToolUI: ToolCallMessagePartComponent = ({
  result,
  status,
  isError,
}) => (
  <ToolRow
    label="图片回显"
    icon={<ImageIcon className="size-4 shrink-0" />}
    running={status?.type === "running"}
    failed={isError === true}
    output={resultText(result)}
  />
);

/** 其余内置小工具（打开文件/插件面板、设计主题、工作模式建议、目标收尾、
 *  后台任务、外部目录检索）：形态统一为「标签 + 主参数 + 可展开回执」 */
const OpenFileToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const path = strArg(args, "path");
  return (
    <ToolRow
      label="打开文件"
      icon={<FileTextIcon className="size-4 shrink-0" />}
      primary={path || undefined}
      mono
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );
};

const OpenPluginPanelToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const plugin = strArg(args, "plugin");
  const panel = strArg(args, "panel");
  return (
    <ToolRow
      label="打开插件面板"
      icon={<PuzzleIcon className="size-4 shrink-0" />}
      primary={plugin ? [plugin, panel].filter(Boolean).join(" / ") : undefined}
      secondary={strArg(args, "path") || undefined}
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );
};

const UseDesignThemeToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => (
  <ToolRow
    label="加载设计主题"
    icon={<PaletteIcon className="size-4 shrink-0" />}
    primary={strArg(args, "name") || "当前主题"}
    running={status?.type === "running"}
    failed={isError === true}
    output={resultText(result)}
  />
);

const AskNeedsWorkToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => (
  <ToolRow
    label="建议切工作模式"
    icon={<SparklesIcon className="size-4 shrink-0" />}
    primary={strArg(args, "reason") || undefined}
    running={status?.type === "running"}
    failed={isError === true}
    output={resultText(result)}
  />
);

const goalToolUI =
  (label: string, key: "summary" | "reason"): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => (
    <ToolRow
      label={label}
      icon={<TargetIcon className="size-4 shrink-0" />}
      primary={strArg(args, key) || undefined}
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );

/** goal_propose_criteria：目标模式的协商出口，提出验收标准清单（确认卡片在
 *  目标条上），消息里留痕——行上给条数，展开看清单/拒绝理由 */
const GoalProposeToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => {
  const criteria = (args as { criteria?: unknown } | undefined)?.criteria;
  const count = Array.isArray(criteria) ? criteria.length : 0;
  return (
    <ToolRow
      label="提出验收标准"
      icon={<ClipboardCheckIcon className="size-4 shrink-0" />}
      primary={count ? `${count} 条标准` : undefined}
      running={status?.type === "running"}
      failed={isError === true}
      output={resultText(result)}
    />
  );
};

const bgTaskToolUI =
  (label: string): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => {
    const output = resultText(result);
    return (
      <ToolRow
        label={label}
        icon={<SquareTerminalIcon className="size-4 shrink-0" />}
        primary={(strArg(args, "taskId") ?? strArg(args, "id")) || undefined}
        mono
        running={status?.type === "running"}
        failed={isError === true || (!!output && FAILED_RE.test(output))}
        output={output}
      />
    );
  };

/** scheduler_*：对话里让 agent 创建/管理自动化任务；参数里 name/taskId 取主文本 */
const schedulerToolUI =
  (label: string): ToolCallMessagePartComponent =>
  ({ args, result, status, isError }) => {
    const output = resultText(result);
    return (
      <ToolRow
        label={label}
        icon={<CalendarClockIcon className="size-4 shrink-0" />}
        primary={(strArg(args, "name") ?? strArg(args, "taskId")) || undefined}
        mono
        running={status?.type === "running"}
        failed={isError === true || (!!output && FAILED_RE.test(output))}
        output={output}
      />
    );
  };

const SearchExternalFilesToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
}) => (
  <ToolRow
    label="外部目录检索"
    icon={<SearchIcon className="size-4 shrink-0" />}
    primary={strArg(args, "pattern") || undefined}
    mono
    running={status?.type === "running"}
    failed={isError === true}
    output={resultText(result)}
  />
);

/** 消息里的工具分组类别：组内浏览器行由组头表达“浏览器”，行标签不再重复 */
const ToolGroupCategoryContext = createContext<ToolCategory | undefined>(undefined);
export const ToolGroupCategoryProvider = ToolGroupCategoryContext.Provider;
export const useToolGroupCategory = () => useContext(ToolGroupCategoryContext);

const BrowserToolUI: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  status,
  isError,
}) => {
  const groupCategory = useToolGroupCategory();
  const action = browserToolLabel(toolName);
  const { primary, secondary } = browserToolSummary(toolName, args);
  const output = resultText(result);
  return (
    <ToolRow
      label={groupCategory === "browser" ? action : `浏览器 · ${action}`}
      icon={<GlobeIcon className="size-4 shrink-0" />}
      primary={primary}
      secondary={secondary}
      mono
      running={status?.type === "running"}
      failed={isError === true || (!!output && FAILED_RE.test(output))}
      output={output}
    />
  );
};

/** mcp 网关工具的动作 → 行标签。MCP 调用统一经过 `mcp` 工具，历史消息里只
 *  留着 args/result，不依赖当前 MCP 清单——服务器被删除后仍按当初的
 *  server__tool 渲染，不会因为配置消失而变成裸 JSON。 */
const MCP_ACTION_LABEL: Record<string, string> = {
  call: "MCP 调用",
  search: "MCP 搜索",
  describe: "MCP 工具",
  status: "MCP 状态",
};

/** 历史 toolResult 可能只有 argsText（流式/旧投影）；能解析就还原因子，解析
 *  失败按空对象走，primary 再退到 argsText 截断——绝不让渲染依赖当前配置。 */
function mcpArgsRecord(
  args: unknown,
  argsText: string | undefined,
): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (argsText) {
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 半截 JSON：保持空对象 */
    }
  }
  return {};
}

const McpToolUI: ToolCallMessagePartComponent = ({
  args,
  argsText,
  result,
  status,
  isError,
  artifact,
}) => {
  const record = mcpArgsRecord(args, argsText);
  const action = typeof record.action === "string" ? record.action : "";
  const tool = typeof record.tool === "string" ? record.tool : "";
  const query = typeof record.query === "string" ? record.query : "";
  const input = typeof record.args === "string" ? record.args : "";
  const structured = (artifact as { structuredContent?: unknown } | undefined)
    ?.structuredContent;
  let output = resultText(result);
  if (!output && structured !== undefined && structured !== null) {
    try {
      output = JSON.stringify(structured, null, 2);
    } catch {
      output = String(structured);
    }
  }
  const primary =
    action === "status"
      ? ""
      : tool || query || (argsText ? argsText.slice(0, 120) : "");
  const [appOpen, setAppOpen] = useState(false);
  const app = (artifact as { mcpApp?: McpAppLaunch } | undefined)?.mcpApp;
  return (
    <>
      <ToolRow
        label={MCP_ACTION_LABEL[action] ?? "MCP 调用"}
        icon={<PlugIcon className="size-4 shrink-0" />}
        badge={<SandboxBadge artifact={artifact} result={result} isError={isError} />}
        primary={primary}
        secondary={action === "call" && input ? input : undefined}
        mono
        running={status?.type === "running"}
        failed={isError === true || (!!output && FAILED_RE.test(output))}
        output={output}
        {...(app ? { onOpenPanel: () => setAppOpen(true) } : {})}
      />
      {app && (
        <button
          type="button"
          onClick={() => setAppOpen(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-muted mt-1 ml-6 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
        >
          <PlugIcon className="size-3.5" />
          {t("chat.mcpApp.open")}
        </button>
      )}
      {app && (
        <McpAppDialog app={app} open={appOpen} onOpenChange={setAppOpen} />
      )}
    </>
  );
};

/**
 * PTC（run_code）活卡片：收起态 = 一行标题（模型给的 description）+ elapsed
 * 心跳 + 状态徽标；展开态 = 脚本高亮预览 / 失败子调用 / 输出头尾。设计对齐
 * MiniMax 的信息层级与 Kova Task 卡的实时性；实现细节在 run-code-card.tsx。
 *
 * Beta 阶段不接右侧面板（compact 档下无开面板入口）——有意为之：活动页的内容模型
 * 是「命令→输出」，塞不下「脚本→N 子调用→返回值」；等写类工具放开时子调用会带
 * write/edit，届时按文件聚合进「审查」标签才是结构性接入。若要提前接，复用活动页：
 * panel-activity.ts 加 run_code 分支（读 artifact.ptc）→ tool-panel.ts 的
 * toolPanelTarget/hasToolPanel 加名 → 这里传 onOpenPanel（参照 bash）。
 */
const RunCodeToolUI: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
  isError,
  artifact,
}) => {
  const code = strArg(args, "code") ?? "";
  const description = strArg(args, "description") ?? "运行代码";
  const ptc = (artifact as { ptc?: PtcDetailsView } | undefined)?.ptc;
  const calls = ptc?.calls ?? [];
  const rawOutput = stripRunCodeHeader(resultText(result));
  const { reference, body: output } = splitRunCodeReceipt(rawOutput);
  const running = status?.type === "running";
  const failed = isError === true;
  // 运行中每秒一拍；wallTimeMs 是最近一次 onUpdate 的累计值，跳动即前进
  const elapsed = useRunCodeElapsed(running, ptc?.wallTimeMs);
  return (
    <ToolRow
      label="运行代码"
      icon={<Code2Icon className="size-4 shrink-0" />}
      primary={description}
      secondary={
        running
          ? (elapsed ?? "运行中")
          : calls.length > 0
            ? `${calls.length} 次子调用`
            : undefined
      }
      badge={<RunCodeStatusPips calls={calls} />}
      running={running}
      failed={failed}
      expandedContent={
        <RunCodeExpanded
          code={code}
          calls={calls}
          output={output}
          reference={reference}
          failed={failed}
        />
      }
    />
  );
};

/** 专属扁平行渲染的工具名 → 组件；其余交给 resolveToolUI（browser_* 前缀兜底，最后才落 ToolFallback） */
export const AGENT_TOOL_UI: Record<string, ToolCallMessagePartComponent> = {
  bash: BashToolUI,
  run_code: RunCodeToolUI,
  Task: TaskDelegationCard,
  TaskWait: subagentOpToolUI("等待子智能体", delegationTargets),
  TaskList: subagentOpToolUI("子智能体列表"),
  TaskStop: subagentOpToolUI("停止子智能体", delegationTargets),
  SendMessage: subagentOpToolUI(
    "子智能体消息",
    (args) => strArg(args, "delegationId") || undefined,
  ),
  subagents_list: mgmtToolUI("子智能体列表", <BotIcon className="size-4 shrink-0" />, ["name"]),
  subagents_save: mgmtToolUI("保存子智能体", <BotIcon className="size-4 shrink-0" />, ["name"]),
  subagents_delete: mgmtToolUI("删除子智能体", <BotIcon className="size-4 shrink-0" />, ["name"]),
  use_skill: SkillToolUI,
  skills_list: mgmtToolUI("技能列表", <BookOpenIcon className="size-4 shrink-0" />, ["name"]),
  skills_save: mgmtToolUI("保存技能", <BookOpenIcon className="size-4 shrink-0" />, ["name"]),
  skills_delete: mgmtToolUI("删除技能", <BookOpenIcon className="size-4 shrink-0" />, ["name"]),
  mcp: McpToolUI,
  generate_image: GenerateImageToolUI,
  see_image: SeeImageToolUI,
  screenshot: ScreenshotToolUI,
  echo_image: EchoImageToolUI,
  read: ReadToolUI,
  edit: fileToolUI("edit", "编辑"),
  write: fileToolUI("write", "写入"),
  WebSearch: WebSearchToolUI,
  WebFetch: WebFetchToolUI,
  glob: searchToolUI("文件检索", <SearchIcon className="size-4 shrink-0" />),
  grep: searchToolUI("内容检索", <SearchIcon className="size-4 shrink-0" />),
  search_external_files: SearchExternalFilesToolUI,
  memory_write: MemoryWriteToolUI,
  memory_read: MemoryReadToolUI,
  memory_search: MemorySearchToolUI,
  kb_search: KbSearchToolUI,
  kb_read: KbReadToolUI,
  open_file: OpenFileToolUI,
  open_plugin_panel: OpenPluginPanelToolUI,
  use_design_theme: UseDesignThemeToolUI,
  ask_needs_work: AskNeedsWorkToolUI,
  goal_propose_criteria: GoalProposeToolUI,
  goal_complete: goalToolUI("完成目标", "summary"),
  goal_blocked: goalToolUI("目标受阻", "reason"),
  task_output: bgTaskToolUI("后台任务输出"),
  taskOutput: bgTaskToolUI("后台任务输出"),
  task_stop: bgTaskToolUI("停止后台任务"),
  scheduler_create: schedulerToolUI("创建自动化任务"),
  scheduler_list: schedulerToolUI("自动化任务列表"),
  scheduler_get: schedulerToolUI("查看自动化任务"),
  scheduler_update: schedulerToolUI("更新自动化任务"),
  scheduler_delete: schedulerToolUI("删除自动化任务"),
  scheduler_run_now: schedulerToolUI("立即运行自动化任务"),
  plugins_list: mgmtToolUI("插件列表", <PuzzleIcon className="size-4 shrink-0" />, ["name", "id"]),
  plugins_install: mgmtToolUI("安装插件", <PuzzleIcon className="size-4 shrink-0" />, ["name", "id", "path"]),
  plugins_scaffold: mgmtToolUI("创建插件", <PuzzleIcon className="size-4 shrink-0" />, ["name", "id"]),
  design_themes_list: mgmtToolUI("设计主题列表", <PaletteIcon className="size-4 shrink-0" />, ["name", "id"]),
  design_theme_save: mgmtToolUI("保存设计主题", <PaletteIcon className="size-4 shrink-0" />, ["name", "id"]),
  design_theme_delete: mgmtToolUI("删除设计主题", <PaletteIcon className="size-4 shrink-0" />, ["name", "id"]),
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

/** 工具名 → 渲染组件：专属 UI 优先；browser_* 按前缀兜底（新增动作无需再登记） */
export function resolveToolUI(
  toolName: string,
): ToolCallMessagePartComponent | undefined {
  return (
    AGENT_TOOL_UI[toolName] ??
    (toolCategory(toolName) === "browser" ? BrowserToolUI : undefined)
  );
}
