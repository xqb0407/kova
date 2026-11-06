"use client";

/**
 * 全局搜索视图（⌘K / 侧边栏搜索按钮打开）——**只做组合**：
 * 顶栏 + scope 页签 + 结果列表。状态与副作用全在
 * `lib/search/use-search-controller.ts`，模型在 `lib/search/*`。
 *
 * 布局：占据 shell 右侧主区的覆盖层（`children` 保持挂载，见
 * clone-thread-shell 的说明——替换渲染会触发面板重挂的 resize 误判）。
 *
 * Esc 关闭在捕获阶段拦停（preventDefault + stopPropagation）：不让下层
 * 页面的 Esc（如 Ctrl+F 的查找条）跟着响应。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import { useSearchController } from "@/lib/search/use-search-controller";
import { SearchInputRow, SearchScopeTabs } from "./search-header";
import { SearchResultList } from "./search-result-list";

export const GlobalSearchView: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewThread: () => void;
}> = ({ open, onOpenChange, onNewThread }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  /** 主 Header 的搜索槽：搜索输入与资料库/自动化共用同一根顶栏 */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") {
      setHeaderSlot(null);
      return;
    }
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="search-header-slot"]'),
    );
  }, [open]);

  const controller = useSearchController({
    open,
    onClose: () => onOpenChange(false),
    onNewThread,
  });

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // 打开即聚焦（rAF 等 Portal/覆盖层挂载完成；headerSlot 变化后再补一次）
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, headerSlot]);

  // Esc 关闭：捕获级，避免被下层页面（查找条等）消费掉
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // 键盘 Enter / 点击行：下标 → 命中（回调稳定，行组件才能吃到 memo）
  const { openHit, selectable } = controller;
  const openIndex = useCallback(
    (index: number) => openHit(selectable[index]),
    [openHit, selectable],
  );

  if (!open) return null;

  const inputRow = (
    <SearchInputRow
      inHeader={headerSlot !== null}
      query={controller.query}
      loading={controller.loading}
      inputRef={inputRef}
      onChange={controller.setQuery}
      onKeyDown={controller.onInputKeyDown}
    />
  );

  return (
    <>
      {headerSlot ? createPortal(inputRow, headerSlot) : null}
      <div
        role="search"
        aria-label="全局搜索"
        className="flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* 输入行在主 Header 里；取不到槽位时（独立复用/调试）退回行内 */}
        {headerSlot ? null : inputRow}
        <SearchScopeTabs
          scope={controller.scope}
          onScopeChange={controller.setScope}
        />
        <SearchResultList
          rows={controller.rows}
          active={controller.active}
          query={controller.query.trim()}
          isEmpty={controller.isEmpty}
          isAction={controller.isAction}
          hasResults={controller.selectable.length > 0}
          loading={controller.loading}
          error={controller.error}
          truncated={controller.truncated}
          onActivate={controller.setActive}
          onOpenIndex={openIndex}
          onClearHistory={controller.clearHistory}
        />
      </div>
    </>
  );
};
