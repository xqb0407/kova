"use client";

/**
 * 搜索顶栏：输入行 + scope 页签（monocode 同构的平铺紧凑两行）。
 *
 * 搜索视图挂在主 Header 下方（见 clone-thread-shell），窗口 chrome 让位由
 * 上方的 Header 承担，这里不再自己算红绿灯/三键的左右内边距。
 *
 * 输入框是受控组件，键盘交互（↑↓/Enter/Esc 的语义）由 controller 决定，
 * 这里只透传 onKeyDown。
 */
import { memo, type FC, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SEARCH_SCOPES, type SearchScope } from "@/lib/search/search-models";

export const SearchInputRow: FC<{
  query: string;
  loading: boolean;
  /** 嵌在主 Header 的搜索槽里：去掉行高/下边框，做成顶栏内联输入 */
  inHeader?: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}> = memo(function SearchInputRow({
  query,
  loading,
  inHeader = false,
  inputRef,
  onChange,
  onKeyDown,
}) {
  return (
    <div
      data-drag-region="false"
      className={cn(
        "flex min-w-0 items-center gap-2",
        inHeader
          ? "h-8 flex-1 rounded-md bg-muted/40 px-2"
          : "h-10 shrink-0 border-b border-border/30 px-3",
      )}
    >
      <SearchIcon
        className="size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
      />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索一切…"
        aria-label="全局搜索"
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="go"
        className="min-w-0 flex-1 rounded-none bg-transparent text-sm outline-none selection:bg-primary/25 selection:text-foreground placeholder:text-muted-foreground"
      />
      {query ? (
        <button
          type="button"
          aria-label="清空搜索词"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : loading ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
});

export const SearchScopeTabs: FC<{
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
}> = memo(function SearchScopeTabs({ scope, onScopeChange }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/30 px-3">
      {SEARCH_SCOPES.map((item) => {
        const selected = scope === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onScopeChange(item.id)}
            className={cn(
              "rounded-md px-2 py-1 text-xs transition-colors",
              selected
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
});
