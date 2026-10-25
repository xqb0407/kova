"use client";

/**
 * 全局搜索视图（⌘K / 侧边栏搜索按钮打开，§search）：
 *
 * 默认页（monocode 式，空查询即有内容可点）：最近会话 + 最近产物 + 搜索历史
 * 三段，打开面板立即拉取（search_default 单次往返）；历史行可点击回填、可清空。
 *
 * scope 页签：全部 / 会话 / 内容 / 产物 / 资料库 / 项目。「全部」聚合各域
 *（每域取头部若干条）；其余页签单域全量。项目域随查询并行跑（带当前工作区
 * cwd，git grep 优先）。
 *
 * 操作命中（query 以 > 开头）：新对话 / 关闭搜索 / 清空历史 等命令直呼，
 * monocode「Search everywhere」与编辑器命令面板的折中——不另设命令面板。
 *
 * 键盘：↑↓ 导航（跨分组合并序）、Enter 打开、Esc 关闭；防抖 200ms +
 * 请求 id 丢弃过期响应。布局占 shell 右侧主区，左侧栏保持可见。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  WrenchIcon,
  SparklesIcon,
  ChevronRightIcon,
  ClockIcon,
  CornerDownLeftIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  SearchXIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { APP_MODE_META } from "@/lib/pi/app-mode-meta";
import {
  useSessionAppMode,
} from "@/lib/pi/pi-session-app-mode";
import {
  clearSearchHistory,
  fetchSearchDefault,
  recordSearchHistory,
  searchPiSessions,
  type PiProjectSearchResult,
  type PiSearchArtifactHit,
  type PiSearchMessageHit,
  type PiSearchSessionHit,
} from "@/lib/pi/pi-bridge";
import { requestOpenSession } from "@/lib/pi/open-session";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { fsOpen } from "@/lib/workspace/fs";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";

type ActionCommand = {
  id: string;
  label: string;
  hint: string;
  icon: typeof PlusIcon;
  run: () => void;
};

type SearchHit =
  | { kind: "session"; hit: PiSearchSessionHit }
  | { kind: "message"; hit: PiSearchMessageHit }
  | { kind: "artifact"; hit: PiSearchArtifactHit }
  | { kind: "projectFile"; hit: { rel: string; name: string } }
  | { kind: "projectContent"; hit: { rel: string; name: string; line: number; preview: string } }
  | { kind: "history"; hit: { query: string } }
  | { kind: "action"; hit: ActionCommand };

type Scope = "all" | "conversations" | "content" | "artifacts" | "library" | "project";

/** 渲染序列条目：组标签行（不可选中）或命中行 */
type SearchRow =
  | { type: "label"; label: string; action?: React.ReactNode }
  | { type: "hit"; hit: SearchHit };

const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "conversations", label: "会话" },
  { id: "content", label: "内容" },
  { id: "artifacts", label: "产物" },
  { id: "library", label: "资料库" },
  { id: "project", label: "项目" },
];

/** 「全部」页各域配额（monocode ALL_LIMITS 同思路：聚合视图每域有界） */
const ALL_LIMITS = {
  sessions: 6,
  messages: 6,
  artifacts: 6,
  projectFiles: 4,
  projectContents: 6,
};

/** 操作命中：query 以 > 开头时按前缀过滤的命令清单 */
function actionCommands(
  onNewThread: () => void,
  onClearHistory: () => void,
  close: () => void,
): ActionCommand[] {
  return [
    {
      id: "action:new-thread",
      label: "新对话",
      hint: "开始一个新会话",
      icon: PlusIcon,
      run: () => {
        close();
        onNewThread();
      },
    },
    {
      id: "action:close",
      label: "关闭搜索",
      hint: "Esc",
      icon: CornerDownLeftIcon,
      run: close,
    },
    {
      id: "action:clear-history",
      label: "清空搜索历史",
      hint: "删除全部历史记录",
      icon: Trash2Icon,
      run: onClearHistory,
    },
  ];
}

/** 与 thread-list.aui 同款相对时间（formatElapsed 口径） */
function formatElapsed(at: string | number): string | null {
  const ts = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const total = Math.floor((Date.now() - ts) / 1000);
  if (total < 60) return "刚刚";
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}天前`;
  const date = new Date(ts);
  const now = Date.now();
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function projectNameOf(cwd: string): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "";
}

/** 命中子串高亮（大小写不敏感首次命中；不中则原文） */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.replace(/^[>\s]+/, "").trim();
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{text}</>;
  const end = index + needle.length;
  return (
    <>
      {text.slice(0, index)}
      <span className="text-primary">{text.slice(index, end)}</span>
      {text.slice(end)}
    </>
  );
}

export const GlobalSearchView: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewThread: () => void;
}> = ({ open, onOpenChange, onNewThread }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionHits, setSessionHits] = useState<PiSearchSessionHit[]>([]);
  const [messageHits, setMessageHits] = useState<PiSearchMessageHit[]>([]);
  const [artifactHits, setArtifactHits] = useState<PiSearchArtifactHit[]>([]);
  const [project, setProject] = useState<PiProjectSearchResult>({
    files: [], contents: [], truncated: false,
  });
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(0);
  // 默认页数据（最近会话/最近产物/搜索历史）
  const [defaultSessions, setDefaultSessions] = useState<PiSearchSessionHit[]>([]);
  const [defaultArtifacts, setDefaultArtifacts] = useState<PiSearchArtifactHit[]>([]);
  const [history, setHistory] = useState<{ query: string; createdAt: string }[]>([]);

  const trimmedRaw = query.trim();
  // > 前缀 = 命令模式
  const isAction = trimmedRaw.startsWith(">");
  const trimmed = isAction ? trimmedRaw.replace(/^>\s*/, "") : trimmedRaw;

  const reloadHistory = useCallback(() => {
    void fetchSearchDefault(10)
      .then((r) => {
        setDefaultSessions(r.sessions);
        setDefaultArtifacts(r.artifacts);
        setHistory(r.history);
      })
      .catch(() => {});
  }, []);

  const clearHistory = useCallback(() => {
    void clearSearchHistory().then(reloadHistory).catch(() => {});
  }, [reloadHistory]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const commands = useMemo(
    () => actionCommands(onNewThread, clearHistory, close),
    [onNewThread, clearHistory, close],
  );
  // 默认页「搜索历史」组标签的清空按钮（随 rows 一起进 useMemo）
  const clearHistoryButton = useMemo(
    () => (
      <button
        type="button"
        onClick={clearHistory}
        className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Trash2Icon className="size-3" />
        清空
      </button>
    ),
    [clearHistory],
  );
  const filteredActions = useMemo<ActionCommand[]>(() => {
    if (!isAction) return [];
    const needle = trimmed.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(needle) ||
        cmd.id.toLowerCase().includes(needle),
    );
  }, [isAction, trimmed, commands]);

  // 打开即重置 + 拉默认页 + 聚焦（rAF 等挂载完成）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setSessionHits([]);
    setMessageHits([]);
    setArtifactHits([]);
    setProject({ files: [], contents: [], truncated: false });
    setTruncated(false);
    setError(null);
    setActive(0);
    reloadHistory();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, reloadHistory]);

  // ---- 结果组装：操作模式 / 普通查询（scope 过滤 + 全页配额）/ 默认页 ----
  // 扁平序列：label 条目（组标签）与可选中条目交错；active 只数 selectable，
  // 渲染层按序 map，不存在跨组的 offset 拼接。
  const rows = useMemo<SearchRow[]>(() => {
    const withLabel = (label: string, list: SearchHit[], action?: React.ReactNode): SearchRow[] =>
      list.length > 0 ? [{ type: "label", label, action }, ...list.map((hit) => ({ type: "hit" as const, hit }))] : [];
    const cut = <T,>(list: T[], n: number) => (scope === "all" ? list.slice(0, n) : list);

    if (isAction) {
      return filteredActions.map((cmd) => ({
        type: "hit" as const,
        hit: { kind: "action" as const, hit: cmd },
      }));
    }

    if (!trimmed) {
      // 默认页（monocode 式：空查询即有内容可点）
      if (scope !== "all") return [];
      return [
        ...withLabel("最近会话", defaultSessions.slice(0, ALL_LIMITS.sessions).map((hit) => ({ kind: "session" as const, hit }))),
        ...withLabel("最近产物", defaultArtifacts.slice(0, ALL_LIMITS.artifacts).map((hit) => ({ kind: "artifact" as const, hit }))),
        ...withLabel(
          "搜索历史",
          history.slice(0, 5).map((hit) => ({ kind: "history" as const, hit })),
          clearHistoryButton,
        ),
      ];
    }

    const libraryOnly = scope === "library";
    const artifactRows = (
      libraryOnly
        ? artifactHits.filter((h) => h.sessionId === "__library__")
        : cut(artifactHits, ALL_LIMITS.artifacts)
    ).map((hit) => ({ kind: "artifact" as const, hit }));
    const projectRows: SearchHit[] = [
      ...(scope === "project" || scope === "all"
        ? cut(project.files, ALL_LIMITS.projectFiles).map((hit) => ({ kind: "projectFile" as const, hit }))
        : []),
      ...(scope === "project" || scope === "all"
        ? cut(project.contents, ALL_LIMITS.projectContents).map((hit) => ({ kind: "projectContent" as const, hit }))
        : []),
    ];

    return [
      ...withLabel("会话", cut(sessionHits, ALL_LIMITS.sessions).map((hit) => ({ kind: "session" as const, hit }))),
      ...withLabel(
        "消息内容",
        scope === "conversations" || scope === "content" || scope === "all"
          ? cut(messageHits, ALL_LIMITS.messages).map((hit) => ({ kind: "message" as const, hit }))
          : [],
      ),
      ...withLabel(libraryOnly ? "资料库文件" : "产物文件", artifactRows),
      ...withLabel("项目", projectRows),
    ];
  }, [
    isAction, filteredActions, trimmed, scope, defaultSessions, defaultArtifacts,
    history, sessionHits, messageHits, artifactHits, project, clearHistoryButton,
  ]);

  // 可选中条目（label 除外）——键盘导航与 Enter 的目标集
  const selectable = useMemo(
    () => rows.filter((row): row is Extract<SearchRow, { type: "hit" }> => row.type === "hit"),
    [rows],
  );

  // 防抖查询 + 过期响应丢弃
  useEffect(() => {
    if (!open || isAction) return;
    if (!trimmed) {
      setSessionHits([]);
      setMessageHits([]);
      setArtifactHits([]);
      setProject({ files: [], contents: [], truncated: false });
      setTruncated(false);
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
        .then((result) => {
          if (requestSeq.current !== seq) return;
          setSessionHits(result.sessions);
          setMessageHits(result.messages);
          setArtifactHits(result.artifacts);
          setProject(result.project);
          setTruncated(result.truncated || result.project.truncated);
          setError(null);
        })
        .catch((err: unknown) => {
          if (requestSeq.current !== seq) return;
          setSessionHits([]);
          setMessageHits([]);
          setArtifactHits([]);
          setProject({ files: [], contents: [], truncated: false });
          setTruncated(false);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, trimmed, isAction, scope]);

  useEffect(() => {
    setActive(0);
  }, [trimmedRaw, scope]);

  useEffect(() => {
    setActive((current) => (current >= selectable.length ? 0 : current));
  }, [selectable.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  const openArtifact = useCallback((hit: PiSearchArtifactHit) => {
    // 产物文件用系统默认应用打开（与「我的文件」/资料库一致）。
    // fs_open 的可信根判定按 cwd 解析（resolveRoot），path 必须传**相对**路径：
    // 绝对路径要过 isUnderPath(realpath) 校验，而 taskWorkspaceDir() 可能返回
    // realpath 前的 /var 符号链接路径，两边对不上会被 cwd-not-allowed 拒掉。
    // 资料库行：cwd=库根、path=rel；产物行：cwd=<task-workspace>/<sessionId>、
    // path=rel（该目录在可信根子树内，首写前不存在也放行，见 fs-cmds resolveRoot）。
    void (async () => {
      if (hit.sessionId === "__library__") {
        const { libraryGetRoot } = await import("@/lib/workspace/library-files");
        const root = await libraryGetRoot().catch(() => null);
        if (root?.root) void fsOpen(root.root, hit.rel);
        return;
      }
      const base = await taskWorkspaceDir().catch(() => null);
      if (base) void fsOpen(`${base}/${hit.sessionId}`, hit.rel);
    })();
  }, []);

  const openHit = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      // 真实检索的落点：打开结果才记历史（防抖查询逐字符记会把前缀灌进历史）。
      // history/action 行不算检索，跳过。
      if (hit.kind !== "history" && hit.kind !== "action" && trimmed) {
        void recordSearchHistory(trimmed).catch(() => {});
      }
      switch (hit.kind) {
        case "session":
          requestOpenSession(hit.hit.sessionId);
          break;
        case "message":
          requestOpenSession(hit.hit.sessionId, { seq: hit.hit.seq, query: trimmed });
          break;
        case "artifact":
          openArtifact(hit.hit);
          break;
        case "projectFile":
        case "projectContent": {
          // 应用内打开（对齐产物卡 openCode）：面板 file 标签走 fs_read_file
          // 实时读盘，代码文件（ts/py 等）不在 fs_open 白名单里，系统打开会
          // bad-path——面板是主路，fsOpen 仅在无工作区时无操作
          const cwd = getWorkspace();
          if (cwd) {
            focusPanelTab("file", { cwd, path: hit.hit.rel });
            window.dispatchEvent(new Event("agent-panel:open"));
          }
          break;
        }
        case "history":
          setQuery(hit.hit.query);
          return; // 历史行：回填查询，不关闭
        case "action":
          hit.hit.run();
          return;
      }
      onOpenChange(false);
    },
    [onOpenChange, trimmed, openArtifact],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // IME 组合态放行：中文输入选字时 Enter 是上屏候选、↑↓ 是翻候选页，
    // 都不该被搜索导航拦截（nativeEvent.isComposing 覆盖主流 IME，
    // keyCode 229 兜底部分 Electron 环境下合成事件不置 isComposing 的情况）
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (selectable.length === 0) return;
      setActive((index) => (index + 1) % selectable.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (selectable.length === 0) return;
      setActive((index) => (index - 1 + selectable.length) % selectable.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openHit(selectable[active]?.hit);
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-hit-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const empty = !trimmedRaw;
  const showSpinner =
    loading && selectable.length === 0;
  const noResults =
    !empty && !isAction && !loading && selectable.length === 0 && !error;

  return (
    <div
      role="search"
      aria-label="全局搜索"
      className="flex min-w-0 flex-1 flex-col bg-background"
    >
      {/* 顶栏：输入行 + scope 行（monocode 同构）——平铺、紧凑、各带一条
          分割线；占位符保持短句（"搜索一切…"），具体覆盖哪些域由空态说明，
          长占位符会把整行读成工具栏而不是搜索框。 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <SearchIcon
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="搜索一切…"
          aria-label="全局搜索"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="go"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60 selection:bg-primary/25 selection:text-foreground"
        />
        {query ? (
          <button
            type="button"
            aria-label="清空搜索词"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : showSpinner ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {/* scope 页签：左对齐小胶囊（选中态带底色），与结果区同一 px 基线 */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/30 px-3">
        {SCOPES.map((item) => {
          const selected = scope === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setScope(item.id)}
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

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {/* 操作模式（> 前缀） */}
        {isAction ? (
          <>
            {filteredActions.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                没有匹配的操作
              </p>
            ) : (
              filteredActions.map((cmd, index) => (
                <ActionRow
                  key={cmd.id}
                  index={index}
                  active={active === index}
                  icon={<cmd.icon className="size-4 shrink-0 text-muted-foreground" />}
                  label={cmd.label}
                  hint={cmd.hint}
                  onActivate={() => setActive(index)}
                  onOpen={() => {
                    cmd.run();
                  }}
                />
              ))
            )}
          </>
        ) : (
          /* ---------- 统一渲染：rows 序列（label 行 + 可选中行交错） ---------- */
          selectable.length === 0 ? (
            empty ? (
              /* 默认页缺省（monocode 式）：点阵径向渐隐 + 毛玻璃搜索图标 */
              <SearchEmptyState />
            ) : (
              <div className="flex flex-col items-center gap-2 pt-20 text-muted-foreground">
                <SearchXIcon className="size-6 text-muted-foreground/50" />
                <p className="text-sm">没有找到「{trimmed}」</p>
                <p className="text-xs text-muted-foreground/70">
                  试试其他 scope，或用 &gt; 前缀执行操作
                </p>
              </div>
            )
          ) : (
            <>
              {truncated ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  结果较多，仅显示部分匹配
                </p>
              ) : null}
              {rows.map((row, rowIndex) => {
                if (row.type === "label") {
                  return (
                    <GroupLabel key={`l:${row.label}`} action={row.action}>
                      {row.label}
                    </GroupLabel>
                  );
                }
                const hitIndex = selectableIndexOf(rows, rowIndex);
                const { hit } = row;
                const open = () => openHit(hit);
                const activate = () => setActive(hitIndex);
                switch (hit.kind) {
                  case "session":
                    return (
                      <SessionRow
                        key={`s:${hit.hit.sessionId}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        hit={hit.hit}
                        query={trimmed}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "message":
                    return (
                      <MessageRow
                        key={`m:${hit.hit.sessionId}:${hit.hit.seq}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        hit={hit.hit}
                        query={trimmed}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "artifact":
                    return (
                      <ArtifactRow
                        key={`a:${hit.hit.sessionId}:${hit.hit.rel}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        hit={hit.hit}
                        query={trimmed}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "projectFile":
                    return (
                      <ProjectFileRow
                        key={`pf:${hit.hit.rel}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        hit={hit.hit}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "projectContent":
                    return (
                      <ProjectContentRow
                        key={`pc:${hit.hit.rel}:${hit.hit.line}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        hit={hit.hit}
                        query={trimmed}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "history":
                    return (
                      <HistoryRow
                        key={`h:${hit.hit.query}`}
                        index={hitIndex}
                        active={active === hitIndex}
                        query={hit.hit.query}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                  case "action":
                    return (
                      <ActionRow
                        key={hit.hit.id}
                        index={hitIndex}
                        active={active === hitIndex}
                        icon={<hit.hit.icon className="size-4 shrink-0 text-muted-foreground" />}
                        label={hit.hit.label}
                        hint={hit.hit.hint}
                        onActivate={activate}
                        onOpen={open}
                      />
                    );
                }
              })}
              <p className="flex items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
                <CornerDownLeftIcon className="size-3" />
                打开选中结果
              </p>
            </>
          )
        )}
      </div>
    </div>
  );
};

/**
 * rows 序列里一个条目的可选中下标：label 行不占 selectable 号位，
 * 但 map 的 rowIndex 含 label——需要按「到此为止的 label 数」修正。
 */
function selectableIndexOf(rows: SearchRow[], rowIndex: number): number {
  let labels = 0;
  for (let i = 0; i < rowIndex; i++) if (rows[i]!.type === "label") labels += 1;
  return rowIndex - labels;
}


/* monocode EmptyState 同款缺省视觉：装饰性点阵（径向渐隐 mask）上叠一个
 * 毛玻璃圆角容器 + 搜索图标。纯 CSS，无图片资源。 */
const EMPTY_DOT_COLS = 27;
const EMPTY_DOT_ROWS = 19;

const SearchEmptyState: FC = () => (
  // min-h-full：在滚动容器里撑满剩余高度，点阵云垂直居中（monocode 同款构图）
  <div className="flex min-h-full flex-col items-center justify-center px-6 pb-24">
    <div className="relative mb-2 grid h-48 w-72 place-items-center">
      <div
        aria-hidden
        className="grid gap-[7px] opacity-[0.14] [mask-image:radial-gradient(ellipse_72%_68%_at_50%_50%,#000_18%,transparent_76%)]"
        style={{
          gridTemplateColumns: `repeat(${EMPTY_DOT_COLS}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: EMPTY_DOT_COLS * EMPTY_DOT_ROWS }, (_, index) => (
          <span key={index} className="mx-auto size-[3px] rounded-full bg-foreground" />
        ))}
      </div>
      <div className="absolute grid size-14 place-items-center rounded-2xl bg-muted/60 backdrop-blur-sm">
        <SearchIcon className="size-6 text-muted-foreground/70" strokeWidth={1.75} />
      </div>
    </div>
    <p className="max-w-xs text-center text-[13px] text-muted-foreground">
      搜索会话、消息、产物、资料库与项目
    </p>
  </div>
);

const GroupLabel: FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({
  children,
  action,
}) => (
  <div className="flex items-center justify-between px-2 pb-1 pt-2">
    <p className="text-xs font-medium text-muted-foreground">{children}</p>
    {action}
  </div>
);

/** 行右侧槽位：常驻时间，选中时换来源（同 thread-list 用时/按钮互斥手法） */
const RowSlot: FC<{ time: string | null; meta: string; active: boolean }> = ({
  time,
  meta,
  active,
}) => (
  <span className="pointer-events-none relative flex h-4 w-24 shrink-0 items-center justify-end">
    {meta ? (
      <span
        className={cn(
          "absolute inset-y-0 right-0 flex items-center truncate text-xs text-muted-foreground transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      >
        {meta}
      </span>
    ) : null}
    {time ? (
      <span
        className={cn(
          "absolute inset-y-0 right-0 flex items-center text-xs leading-none tabular-nums text-muted-foreground transition-opacity",
          active && meta ? "opacity-0" : "opacity-100",
        )}
      >
        {time}
      </span>
    ) : null}
  </span>
);

/** 会话行首档位图标（与侧栏行首同源 APP_MODE_META）：hook 收在行级组件里，
 *  偏好镜像到达只重渲染该行，不牵动结果列表。 */
const SessionModeIcon: FC<{ sessionId: string; active: boolean }> = ({
  sessionId,
  active,
}) => {
  const appMode = useSessionAppMode(sessionId);
  const ModeIcon = APP_MODE_META[appMode].icon;
  return (
    <ModeIcon
      aria-label={`工作模式：${APP_MODE_META[appMode].label}`}
      className={cn(
        "size-4 shrink-0",
        active ? "text-accent-foreground/70" : "text-muted-foreground",
      )}
    />
  );
};

const ARCHIVED_BADGE = (
  <span className="flex shrink-0 items-center gap-1 rounded border px-1 py-px text-[10px] leading-none text-muted-foreground">
    <ArchiveIcon className="size-3" />
    归档
  </span>
);

const SessionRow: FC<{
  index: number;
  active: boolean;
  hit: PiSearchSessionHit;
  query: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, hit, query, onActivate, onOpen }) => (
  <button
    type="button"
    data-hit-index={index}
    role="option"
    aria-selected={active}
    onMouseDown={(event) => event.preventDefault()}
    onMouseMove={onActivate}
    onClick={onOpen}
    className={cn(
      "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
    )}
  >
    <SessionModeIcon sessionId={hit.sessionId} active={active} />
    <span className="min-w-0 flex-1 truncate">
      {query ? (
        <Highlight text={hit.title || hit.firstMessage || "新对话"} query={query} />
      ) : (
        (hit.title || hit.firstMessage || "新对话")
      )}
    </span>
    {hit.archived ? ARCHIVED_BADGE : null}
    <RowSlot
      time={formatElapsed(hit.updatedAt)}
      meta={projectNameOf(hit.cwd)}
      active={active}
    />
  </button>
);

const MessageRow: FC<{
  index: number;
  active: boolean;
  hit: PiSearchMessageHit;
  query: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, hit, query, onActivate, onOpen }) => {
  const isUser = hit.role === "user";
  const sessionTitle = hit.title || projectNameOf(hit.cwd);
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onActivate}
      onClick={onOpen}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {isUser ? (
        <UserIcon
          className={cn(
            "size-4 shrink-0",
            active ? "text-accent-foreground/70" : "text-muted-foreground",
          )}
        />
      ) : hit.role === "tool" ? (
        <WrenchIcon
          className={cn(
            "size-4 shrink-0",
            active ? "text-accent-foreground/70" : "text-muted-foreground",
          )}
        />
      ) : (
        <SparklesIcon
          className={cn(
            "size-4 shrink-0",
            active ? "text-accent-foreground/70" : "text-muted-foreground",
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        <Highlight text={hit.preview} query={query} />
      </span>
      {hit.archived ? ARCHIVED_BADGE : null}
      <RowSlot time={formatElapsed(hit.updatedAt)} meta={sessionTitle} active={active} />
    </button>
  );
};

const ArtifactRow: FC<{
  index: number;
  active: boolean;
  hit: PiSearchArtifactHit;
  query?: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, hit, query = "", onActivate, onOpen }) => {
  const isLibrary = hit.sessionId === "__library__";
  const meta = isLibrary ? "资料库" : hit.title || "任务产物";
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onActivate}
      onClick={onOpen}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {isLibrary ? (
        <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
      ) : (
        <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {query ? <Highlight text={hit.name} query={query} /> : hit.name}
        <span className="ms-2 text-xs text-muted-foreground/70">{hit.rel}</span>
      </span>
      <RowSlot
        time={null}
        meta={meta}
        active={active}
      />
    </button>
  );
};

const ProjectFileRow: FC<{
  index: number;
  active: boolean;
  hit: { rel: string; name: string };
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, hit, onActivate, onOpen }) => (
  <button
    type="button"
    data-hit-index={index}
    role="option"
    aria-selected={active}
    onMouseDown={(event) => event.preventDefault()}
    onMouseMove={onActivate}
    onClick={onOpen}
    className={cn(
      "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
    )}
  >
    <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{hit.name}</span>
    <RowSlot time={null} meta={hit.rel} active={active} />
  </button>
);

const ProjectContentRow: FC<{
  index: number;
  active: boolean;
  hit: { rel: string; name: string; line: number; preview: string };
  query: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, hit, query, onActivate, onOpen }) => (
  <button
    type="button"
    data-hit-index={index}
    role="option"
    aria-selected={active}
    onMouseDown={(event) => event.preventDefault()}
    onMouseMove={onActivate}
    onClick={onOpen}
    className={cn(
      "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
    )}
  >
    <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
    <span className="min-w-0 flex-1 truncate">
      <Highlight text={hit.preview} query={query} />
    </span>
    <span className="shrink-0 font-mono text-xs text-muted-foreground">
      {hit.rel}:{hit.line}
    </span>
  </button>
);

const HistoryRow: FC<{
  index: number;
  active: boolean;
  query: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, query, onActivate, onOpen }) => (
  <button
    type="button"
    data-hit-index={index}
    role="option"
    aria-selected={active}
    onMouseDown={(event) => event.preventDefault()}
    onMouseMove={onActivate}
    onClick={onOpen}
    className={cn(
      "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
    )}
  >
    <HistoryIcon
      className={cn(
        "size-3.5 shrink-0",
        active ? "text-accent-foreground/70" : "text-muted-foreground",
      )}
    />
    <span className="min-w-0 flex-1 truncate">{query}</span>
    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
  </button>
);

const ActionRow: FC<{
  index: number;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onActivate: () => void;
  onOpen: () => void;
}> = ({ index, active, icon, label, hint, onActivate, onOpen }) => (
  <button
    type="button"
    data-hit-index={index}
    role="option"
    aria-selected={active}
    onMouseDown={(event) => event.preventDefault()}
    onMouseMove={onActivate}
    onClick={onOpen}
    className={cn(
      "flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
    )}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
  </button>
);

