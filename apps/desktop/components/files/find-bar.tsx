"use client";

/**
 * 文件查看器/面板的查找条（Ctrl/Cmd+F）：紧凑两行——搜索行（输入框 + 「N / M」
 * 计数 + 上一个/下一个/关闭）与可选的替换行（替换输入框 + 替换/全部替换）。
 * 视觉对齐 thread-find 的面板行，但不带结果目录：查看器是全文连读场景，
 * 命中直接在正文/编辑器里高亮跳转。
 *
 * 状态（query、命中、当前下标、替换值）全部由宿主持有，本组件纯受控；
 * Enter/Shift+Enter 与 ↑↓ 在这里拦（焦点天然在输入框），Esc 交给外层
 * 统一处理（要同时清各端高亮）。替换行由宿主按「可编辑的源码态」门控：
 * md 预览是渲染结果、快照回放是只读，都不下发替换 props（只查不替换）。
 */

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ReplaceIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
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
  /** 替换值与触发回调（提供 onReplace + onReplaceChange 才出现替换行） */
  replaceValue?: string;
  onReplaceChange?: (value: string) => void;
  /** 替换当前命中（替换后自动跳到下一处） */
  onReplace?: () => void;
  /** 全部替换 */
  onReplaceAll?: () => void;
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
  replaceValue,
  onReplaceChange,
  onReplace,
  onReplaceAll,
  className,
}) => {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceEnabled =
    onReplace !== undefined && onReplaceChange !== undefined;
  /** 替换动作就绪：有查询且扫到了命中（替换值为空 = 删除命中，允许） */
  const canReplace = query.trim().length > 0 && count > 0;
  /** 替换行开合（VS Code 语义：默认收起，左侧箭头展开；查找条重开归位） */
  const [replaceOpen, setReplaceOpen] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSignal]);

  // 展开替换行即聚焦替换输入框（VS Code 行为）
  useEffect(() => {
    if (!replaceOpen) return;
    const frame = requestAnimationFrame(() => replaceInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [replaceOpen]);

  return (
    <div
      data-slot="file-viewer-find"
      role="search"
      className={
        "animate-in fade-in slide-in-from-top-2 flex flex-col gap-1 overflow-hidden rounded-xl border border-border/60 bg-background/95 p-1.5 shadow-lg backdrop-blur-xl duration-150 " +
        (className ?? "")
      }
    >
      <div className="flex items-center gap-1">
        {replaceEnabled ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("library.viewer.findToggleReplaceAria")}
            aria-expanded={replaceOpen}
            title={t("library.viewer.findToggleReplaceAria")}
            onClick={() => setReplaceOpen((v) => !v)}
          >
            {replaceOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : null}
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
      {replaceEnabled && replaceOpen ? (
        <div className="flex items-center gap-1">
          <InputGroup className="min-w-0 flex-1 border-0 shadow-none">
            <InputGroupAddon>
              <ReplaceIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={replaceInputRef}
              value={replaceValue ?? ""}
              onChange={(event) => onReplaceChange?.(event.target.value)}
              className="truncate h-7"
              placeholder={t("library.viewer.findReplacePlaceholder")}
              aria-label={t("library.viewer.findReplacePlaceholder")}
              spellCheck={false}
              onKeyDown={(event) => {
                // IME 组合中：回车是确认候选词，不是执行替换
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  // Shift+Enter = 全部替换；普通回车 = 替换当前并跳下一处
                  if (event.shiftKey) onReplaceAll?.();
                  else onReplace?.();
                }
              }}
            />
          </InputGroup>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs shrink-0"
            disabled={!canReplace}
            aria-label={t("library.viewer.findReplaceAria")}
            title={t("library.viewer.findReplaceAria")}
            onClick={onReplace}
          >
            {t("library.viewer.findReplace")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs shrink-0"
            disabled={!canReplace}
            aria-label={t("library.viewer.findReplaceAllAria")}
            title={t("library.viewer.findReplaceAllAria")}
            onClick={onReplaceAll}
          >
            {t("library.viewer.findReplaceAll")}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
