"use client";

/**
 * 搜索顶栏：输入行 + scope 页签（monocode 同构的平铺紧凑两行）。
 *
 * 输入行负责窗口 chrome 让位（这是它唯一与非搜索页面耦合的地方）：
 * - Windows/Linux：`frame:false` 自绘三键簇（100px 宽）钉在窗口右上，
 *   覆盖层贴窗口右缘，右让位 24 + 100 + 8；
 * - macOS 桌面 + 侧栏折叠：红绿灯探进主区左缘，左让位对齐主 Header 的 md:pl-24。
 *
 * 输入框是受控组件，键盘交互（↑↓/Enter/Esc 的语义）由 controller 决定，
 * 这里只透传 onKeyDown。
 */
import { memo, type FC, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isDesktop, isMacPlatform } from "@/lib/desktop-env";
import { SEARCH_SCOPES, type SearchScope } from "@/lib/search/search-models";

/** Windows 自绘三键簇宽度（与 window-controls.tsx 的 CLUSTER_W 一致） */
const CLUSTER_W = 100;

export const SearchInputRow: FC<{
  query: string;
  loading: boolean;
  collapsed: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}> = memo(function SearchInputRow({
  query,
  loading,
  collapsed,
  inputRef,
  onChange,
  onKeyDown,
}) {
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border/30 px-3"
      style={{
        ...(isDesktop() && isMacPlatform() && collapsed
          ? { paddingLeft: 96 }
          : null),
        ...(isDesktop() && !isMacPlatform()
          ? { paddingRight: 24 + CLUSTER_W + 8 }
          : null),
      }}
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
        className="min-w-0 flex-1 rounded-none bg-transparent text-sm outline-none selection:bg-primary/25 selection:text-foreground placeholder:text-muted-foreground/60"
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
