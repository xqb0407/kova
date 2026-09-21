"use client";

import { useEffect, useRef, useState, type FC, type RefObject } from "react";
import { ChevronDownIcon, SquareTerminalIcon } from "lucide-react";
import type { TerminalEntry } from "@/lib/panels/panel-activity";
import { scrollIntoScroller } from "@/lib/motion/scroll";
import { cn } from "@/lib/utils";
import { CountPill, PanelSection, StatusDot } from "./section-shell";

/** 命令行展示:多行命令取首行,尾部标 ×N 行数 */
function commandPreview(command: string): { head: string; extraLines: number } {
  const lines = command.split("\n");
  return { head: lines[0] ?? "", extraLines: lines.length - 1 };
}

const TerminalCard: FC<{ entry: TerminalEntry; focused?: boolean }> = ({
  entry,
  focused,
}) => {
  const hasOutput = entry.output !== null && entry.output !== "";
  const [open, setOpen] = useState(false);
  const { head, extraLines } = commandPreview(entry.command);
  const expanded = open && hasOutput;
  const rootRef = useRef<HTMLDivElement>(null);

  // 消息工具行点击定位进来：自动展开该命令并滚到视野中央
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    // 只滚面板自身容器，见 lib/scroll 注释（scrollIntoView 会抬起整页）
    scrollIntoScroller(rootRef.current, "center");
  }, [focused]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "border-border/60  overflow-hidden rounded-xl border",
        focused && "border-ring/40",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        disabled={!hasOutput}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-2 text-left",
          hasOutput && "hover:bg-muted/40",
        )}
      >
        <StatusDot running={entry.running} failed={entry.failed} />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-muted-foreground/60">$ </span>
          <span className="text-foreground/90">{head}</span>
          {extraLines > 0 ? (
            <span className="text-muted-foreground/60"> …+{extraLines}</span>
          ) : null}
        </code>
        {hasOutput ? (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {expanded ? (
        <pre
          className={cn(
            "max-h-64 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
            entry.failed ? "bg-destructive/5 text-destructive" : "text-muted-foreground",
          )}
        >
          {entry.output}
        </pre>
      ) : null}
    </div>
  );
};

export const TerminalSection: FC<{
  entries: TerminalEntry[];
  /** 消息工具行定位进来的 toolCallId：命中卡片自动展开并滚到视野内 */
  focusToolCallId?: string;
  /** 外层滚动容器 ref：PanelSection 吸顶判定（IntersectionObserver root） */
  scrollRoot?: RefObject<HTMLElement | null>;
}> = ({ entries, focusToolCallId, scrollRoot }) => {
  if (entries.length === 0) return null;

  return (
    <PanelSection
      scrollRoot={scrollRoot}
      icon={<SquareTerminalIcon className="size-4" />}
      title="终端"
      trailing={<CountPill>{entries.length}</CountPill>}
    >
      <div className="flex flex-col gap-1.5">
        {entries.map((e) => (
          <TerminalCard
            key={e.toolCallId}
            entry={e}
            focused={focusToolCallId === e.toolCallId}
          />
        ))}
      </div>
    </PanelSection>
  );
};
