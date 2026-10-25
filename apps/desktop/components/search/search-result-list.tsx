"use client";

/**
 * 结果列表：把模型层构建好的 rows 序列渲染成行（组标题 + 命中行交错）。
 *
 * 性能要点：
 * - rows 自带 selectableIndex，渲染不再回数 label（原实现 O(n²)）；
 * - 行组件全部 memo，回调是稳定引用（传给行的是 index，不是闭包），
 *   键盘上下移动只重渲染两行；
 * - 滚动定位按 `data-hit-index` 找当前行，不依赖行内 ref。
 */
import { memo, useCallback, useEffect, useRef, type FC } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import type { SearchHit, SearchRow } from "@/lib/search/search-models";
import {
  ActionRow,
  ArtifactRow,
  HistoryRow,
  MessageRow,
  ProjectContentRow,
  ProjectFileRow,
  SessionRow,
} from "./search-hit-rows";
import { GroupLabel } from "./search-primitives";
import { SearchEmptyState, SearchNoResults } from "./search-empty-state";

export const SearchResultList: FC<{
  rows: SearchRow[];
  active: number;
  query: string;
  isEmpty: boolean;
  isAction: boolean;
  hasResults: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  onActivate: (index: number) => void;
  onOpenIndex: (index: number) => void;
  onClearHistory: () => void;
}> = ({
  rows,
  active,
  query,
  isEmpty,
  isAction,
  hasResults,
  loading,
  error,
  truncated,
  onActivate,
  onOpenIndex,
  onClearHistory,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航跟随滚动（找当前高亮行；行不在视口时浏览器只滚最小距离）
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-hit-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = useCallback((index: number) => onOpenIndex(index), [onOpenIndex]);

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {isAction && !hasResults ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          没有匹配的操作
        </p>
      ) : !hasResults && error ? (
        <p className="px-2 py-1.5 text-sm text-destructive">{error}</p>
      ) : !hasResults ? (
        // 空查询 = 默认页缺省；有查询无命中 = 没有找到
        isEmpty && !loading ? (
          <SearchEmptyState />
        ) : (
          <SearchNoResults query={query} />
        )
      ) : (
        <>
          {truncated ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              结果较多，仅显示部分匹配
            </p>
          ) : null}
          {rows.map((row) => {
            if (row.type === "label") {
              return (
                <GroupLabel
                  key={`l:${row.label}`}
                  label={row.label}
                  action={row.action}
                  onClearHistory={onClearHistory}
                />
              );
            }
            return (
              <HitRow
                key={rowKey(row)}
                hit={row.hit}
                index={row.selectableIndex}
                active={active === row.selectableIndex}
                query={query}
                onActivate={onActivate}
                onOpen={open}
              />
            );
          })}
          <p className="flex items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
            <CornerDownLeftIcon className="size-3" />
            打开选中结果
          </p>
        </>
      )}
    </div>
  );
};

/** 命中行的稳定 key（各来源的天然标识，不含查询词） */
function rowKey(row: Extract<SearchRow, { type: "hit" }>): string {
  const { hit } = row;
  switch (hit.kind) {
    case "session":
      return `s:${hit.hit.sessionId}`;
    case "message":
      return `m:${hit.hit.sessionId}:${hit.hit.seq}`;
    case "artifact":
      return `a:${hit.hit.sessionId}:${hit.hit.rel}`;
    case "projectFile":
      return `pf:${hit.hit.rel}`;
    case "projectContent":
      return `pc:${hit.hit.rel}:${hit.hit.line}`;
    case "history":
      return `h:${hit.hit.query}`;
    case "action":
      return hit.hit.id;
  }
}

/** 按 kind 分发到 memo 过的行组件（query 只在文本行需要，历史/文件行不传） */
const HitRow: FC<{
  hit: SearchHit;
  index: number;
  active: boolean;
  query: string;
  onActivate: (index: number) => void;
  onOpen: (index: number) => void;
}> = ({ hit, index, active, query, onActivate, onOpen }) => {
  const common = { index, active, onActivate, onOpen };
  switch (hit.kind) {
    case "session":
      return <SessionRow {...common} hit={hit.hit} query={query} />;
    case "message":
      return <MessageRow {...common} hit={hit.hit} query={query} />;
    case "artifact":
      return <ArtifactRow {...common} hit={hit.hit} query={query} />;
    case "projectFile":
      return <ProjectFileRow {...common} hit={hit.hit} />;
    case "projectContent":
      return <ProjectContentRow {...common} hit={hit.hit} query={query} />;
    case "history":
      return <HistoryRow {...common} query={hit.hit.query} />;
    case "action":
      return <ActionRow {...common} command={hit.hit} />;
  }
};
