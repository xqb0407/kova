/**
 * 搜索状态编排（视图只消费返回值，不自己管 effect 时序）。
 *
 * 关注点：
 * - **防抖 200ms + 请求序号**：过期响应直接丢弃，快速连打不闪旧结果；
 * - **结果更新走 startTransition**：命中列表是非紧急更新，输入框保持跟手；
 * - **默认页数据**（最近会话/产物/历史）与查询结果分开存，互不覆盖；
 * - **行序列在模型层构建**（buildSearchRows），这里只做状态与派生；
 * - **键盘导航**的 active 下标在结果集收缩时夹回，Enter 不会落在幽灵行。
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  clearSearchHistory,
  fetchSearchDefault,
  searchPiSessions,
} from "@/lib/pi/pi-bridge";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { buildActionCommands, EMPTY_DEFAULT_DATA, EMPTY_RESULT_SET, parseQuery, type ActionCommand, type SearchDefaultData, type SearchHit, type SearchResultSet, type SearchScope } from "./search-models";
import { buildSearchRows } from "./search-rows";
import { openSearchHit } from "./search-open";

/** 查询防抖窗口（打字停顿后才发请求） */
const DEBOUNCE_MS = 200;

export type SearchController = {
  query: string;
  setQuery: (value: string) => void;
  scope: SearchScope;
  setScope: (scope: SearchScope) => void;
  active: number;
  setActive: (index: number) => void;
  /** 渲染序列（组标签 + 命中行，含 selectableIndex） */
  rows: ReturnType<typeof buildSearchRows>;
  /** 可选中行（键盘导航 / Enter 的目标集） */
  selectable: SearchHit[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** 空查询 = 默认页 */
  isEmpty: boolean;
  isAction: boolean;
  showSpinner: boolean;
  noResults: boolean;
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  openHit: (hit: SearchHit | undefined) => void;
  clearHistory: () => void;
};

export function useSearchController(options: {
  open: boolean;
  onClose: () => void;
  onNewThread: () => void;
}): SearchController {
  const { open, onClose, onNewThread } = options;
  const requestSeq = useRef(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [active, setActiveState] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResultSet>(EMPTY_RESULT_SET);
  const [fallback, setFallback] = useState<SearchDefaultData>(EMPTY_DEFAULT_DATA);

  const { isAction, trimmed } = parseQuery(query);

  // ---- 默认页 / 搜索历史 ----
  const reloadDefault = useCallback(() => {
    void fetchSearchDefault(10)
      .then((data) => {
        startTransition(() =>
          setFallback({
            sessions: data.sessions,
            artifacts: data.artifacts,
            history: data.history,
          }),
        );
      })
      .catch(() => {});
  }, []);

  const clearHistory = useCallback(() => {
    void clearSearchHistory()
      .then(reloadDefault)
      .catch(() => {});
  }, [reloadDefault]);

  // 打开即重置 + 拉默认页（挂载即打开时同样走一次；rAF 聚焦由视图负责）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setActiveState(0);
    setResult(EMPTY_RESULT_SET);
    setError(null);
    reloadDefault();
  }, [open, reloadDefault]);

  // ---- 查询：防抖 + 过期响应丢弃 ----
  useEffect(() => {
    if (!open || isAction) return;
    if (!trimmed) {
      setResult(EMPTY_RESULT_SET);
      setLoading(false);
      setError(null);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      // 项目域只在 project/all scope 下跑，带当前工作区 cwd
      const projectCwd =
        scope === "project" || scope === "all" ? (getWorkspace() ?? "") : "";
      searchPiSessions(trimmed, { projectCwd: projectCwd || undefined })
        .then((next) => {
          if (requestSeq.current !== seq) return;
          startTransition(() => {
            setResult(next);
            setError(null);
          });
        })
        .catch((err: unknown) => {
          if (requestSeq.current !== seq) return;
          setResult(EMPTY_RESULT_SET);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, trimmed, isAction, scope]);

  // ---- 命令清单（`>` 前缀）----
  const commands = useMemo<ActionCommand[]>(
    () =>
      buildActionCommands({
        onNewThread,
        onClearHistory: clearHistory,
        close: onClose,
      }),
    [onNewThread, clearHistory, onClose],
  );
  const filteredActions = useMemo(() => {
    if (!isAction) return [];
    const needle = trimmed.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(needle) ||
        cmd.id.toLowerCase().includes(needle),
    );
  }, [isAction, trimmed, commands]);

  // ---- 行序列（模型层构建，含 selectableIndex）----
  const rows = useMemo(
    () =>
      buildSearchRows({
        isAction,
        trimmed,
        scope,
        actions: filteredActions,
        result,
        fallback,
      }),
    [isAction, trimmed, scope, filteredActions, result, fallback],
  );

  /** 可选中命中（按 selectableIndex 序，rows 里已保证连续递增） */
  const selectable = useMemo(
    () =>
      rows.reduce<SearchHit[]>((acc, row) => {
        if (row.type === "hit") acc.push(row.hit);
        return acc;
      }, []),
    [rows],
  );

  // 查询词 / scope 变化回到首行；结果集收缩时夹回，避免 Enter 落在幽灵行
  useEffect(() => {
    setActiveState(0);
  }, [query, scope]);
  useEffect(() => {
    setActiveState((current) => (current >= selectable.length ? 0 : current));
  }, [selectable.length]);

  const setActive = useCallback((index: number) => setActiveState(index), []);

  const openHit = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      if (
        openSearchHit(hit, { query: trimmed, onQueryChange: setQuery }) ===
        "close"
      ) {
        onClose();
      }
    },
    [trimmed, onClose],
  );

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME 组合态放行：中文选字时 Enter 是上屏、↑↓ 是翻候选页，都不该被
      // 搜索导航拦截（isComposing 覆盖主流 IME，keyCode 229 兜 Electron 合成事件）
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (selectable.length === 0) return;
        setActiveState((index) => (index + 1) % selectable.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (selectable.length === 0) return;
        setActiveState(
          (index) => (index - 1 + selectable.length) % selectable.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openHit(selectable[active]);
      }
    },
    [selectable, active, openHit],
  );

  const isEmpty = !query.trim();
  return {
    query,
    setQuery,
    scope,
    setScope,
    active,
    setActive,
    rows,
    selectable,
    loading,
    error,
    truncated: result.truncated,
    isEmpty,
    isAction,
    showSpinner: loading && selectable.length === 0,
    noResults: !isEmpty && !isAction && !loading && selectable.length === 0 && !error,
    onInputKeyDown,
    openHit,
    clearHistory,
  };
}
