"use client";

/**
 * 资料库查看器的查找条（Ctrl/Cmd+F）：紧凑单行——输入框 + 「N / M」计数 +
 * 上一个/下一个/关闭。视觉对齐 thread-find 的面板行，但不带结果目录：
 * 查看器是全文连读场景，命中直接在正文/编辑器里高亮跳转。
 *
 * 状态（query、命中、当前下标）全部由 TextBody 持有，本组件纯受控；
 * Enter/Shift+Enter 与 ↑↓ 在这里拦（焦点天然在输入框），Esc 交给外层
 * 统一处理（要同时清三端高亮）。
 */

import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  type FC,
} from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export const FindBar: FC<{
  query: string;
  onQueryChange: (query: string) => void;
  /** 命中总数；0 显示「无结果」 */
  count: number;
  /** 当前命中（0-based；-1 = 无） */
  index: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** 打开时聚焦并全选（rAF 等 ref 挂好） */
  focusSignal?: number;
  className?: string;
}> = ({
  query,
  onQueryChange,
  count,
  index,
  onNext,
  onPrev,
  onClose,
  focusSignal,
  className,
}) => {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSignal]);

  return (
    <div
      data-slot="file-viewer-find"
      role="search"
      className={
        "animate-in fade-in slide-in-from-top-2 flex items-center gap-1 overflow-hidden rounded-xl border border-border/60 bg-background/95 p-1.5 shadow-lg backdrop-blur-xl duration-150 " +
        (className ?? "")
      }
    >
      <InputGroup className="min-w-0 flex-1 border-0 shadow-none">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          // 长查询不撑破条：失焦时按省略号截断，聚焦时由输入框自己横向滚动
          className="truncate h-7"
          placeholder={t("library.viewer.findPlaceholder")}
          aria-label={t("library.viewer.findPlaceholder")}
          spellCheck={false}
          onKeyDown={(event) => {
            // IME 组合中（中文选字等）：回车是确认候选词，不是跳转
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onPrev();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onNext();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <span className="text-muted-foreground text-xs tabular-nums">
            {query.trim().length === 0
              ? ""
              : count === 0
                ? t("library.viewer.findNoMatches")
                : index < 0
                  ? `${count}`
                  : `${index + 1} / ${count}`}
          </span>
        </InputGroupAddon>
      </InputGroup>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("library.viewer.findPrevAria")}
        disabled={count === 0}
        onClick={onPrev}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("library.viewer.findNextAria")}
        disabled={count === 0}
        onClick={onNext}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("library.viewer.findCloseAria")}
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
};
