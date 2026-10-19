"use client";

/**
 * 资料库页的内容区（工具条在页面的通栏 header 上，这里只剩内容）。
 *
 * 左栏上下两段（对齐右侧面板 git 面板的做法）：上段 = 用户自己的文件（库根），
 * 下段 = AI 产物（task-workspace，根层 UUID 目录显示会话标题）。两段各有头行，
 * 点一下折叠/展开；都展开时中间有拖拽条调高度（双击复位，聚焦后 ↑↓ 也能调），
 * 高度与折叠状态都记忆；折叠后头行钉在栏底。搜索时左栏整栏换成扁平结果
 * （两个根一起扫，结果标注来源）。
 * 右栏是查看器，文本类就地编辑；拖放：拖进上段拷入库根，拖到文件夹行拷进该目录。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ImportIcon,
  LibraryIcon,
  NotebookPenIcon,
  PackageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileExplorer, type ExplorerFileRef } from "./file-explorer";
import { FileViewer } from "./file-viewer";
import { SearchList } from "./search-list";
import { toast } from "@/components/ui/toast";
import { filePathOf } from "@/desktop-bridge/core";
import { cn } from "@/lib/utils";
import {
  piSessionPrefsMap,
  refreshSessionPrefs,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { fsErrorText, fsMove } from "@/lib/workspace/fs";
import {
  libraryScan,
  type LibraryScanEntry,
} from "@/lib/workspace/library-files";
import type { LibraryActions } from "./use-library-actions";

/** 树里选中的目标 */
export interface LibrarySelection extends ExplorerFileRef {
  /** 树行的取值（与 rel 相同；留着便于对应两个根的实例） */
  value: string;
}

/** 段折叠状态与分割高度的持久化键 */
const LIB_OPEN_KEY = "library-tree-lib-open";
const ART_OPEN_KEY = "library-tree-art-open";
const SPLIT_KEY = "library-tree-split";
/** 展开段的最小内容高（拖拽夹取用），与头行高 */
const SECTION_MIN = 120;
const HEADER_H = 32;

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function persistBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* 不可用就不记忆 */
  }
}
function readNumber(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= SECTION_MIN ? n : null;
  } catch {
    return null;
  }
}
function persistNumber(key: string, n: number | null): void {
  try {
    if (n === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(n)));
  } catch {
    /* ignore */
  }
}

/** 段头行：图标 + 标题 + 折叠箭头（整行可点） */
const SectionHeader: FC<{
  icon: FC<{ className?: string }>;
  title: string;
  open: boolean;
  trailing?: string;
  onToggle: () => void;
}> = ({ icon: SectionIcon, title, open, trailing, onToggle }) => (
  <button
    type="button"
    data-slot="library-section-header"
    data-section={title}
    onClick={onToggle}
    aria-expanded={open}
    className="hover:bg-muted/60 flex h-8 shrink-0 items-center gap-1.5 px-2 text-left text-xs font-medium transition-colors"
  >
    {open ? (
      <ChevronDownIcon className="text-muted-foreground/70 size-3.5 shrink-0" />
    ) : (
      <ChevronRightIcon className="text-muted-foreground/70 size-3.5 shrink-0" />
    )}
    <SectionIcon className="text-muted-foreground size-3.5 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{title}</span>
    {trailing && (
      <span className="text-muted-foreground/60 shrink-0 text-[10px] tabular-nums">
        {trailing}
      </span>
    )}
  </button>
);

export const LibraryPane: FC<{
  root: string | null;
  /** 已防抖的查询串（非空时左栏整栏换成扁平搜索结果） */
  query: string;
  selected: LibrarySelection | null;
  onSelect: (sel: LibrarySelection | null) => void;
  refreshSignal: number;
  actions: LibraryActions;
}> = ({ root, query, selected, onSelect, refreshSignal, actions }) => {
  const q = query.trim();
  /** AI 产物根（task-workspace）：异步解析 */
  const [artifactsRoot, setArtifactsRoot] = useState<string | null>(null);
  /** 会话标题镜像的响应式信号（根层 UUID 目录显示标题） */
  const prefsVersion = useSessionPrefsVersion();

  useEffect(() => {
    void taskWorkspaceDir().then(setArtifactsRoot);
    // 根层 UUID 目录要显示会话标题：随树一起刷一遍会话快照（内部自吞失败，
    // 拿不到就退显示原始目录名）
    void refreshSessionPrefs();
  }, []);

  /** 行展示名：AI 产物根层的 UUID 目录 → 会话标题；其余原名 */
  const labelForName = useCallback(
    (name: string, rel: string, isDir: boolean): string | undefined => {
      void prefsVersion; // 订阅：快照更新后重算行名
      if (!isDir || rel.includes("/")) return undefined;
      return piSessionPrefsMap.get(name)?.name || undefined;
    },
    [prefsVersion],
  );

  // ---- 两段的折叠态与分割高度（都持久化）----
  const [libOpen, setLibOpen] = useState(() => readBool(LIB_OPEN_KEY, true));
  const [artOpen, setArtOpen] = useState(() => readBool(ART_OPEN_KEY, true));
  const [topHeight, setTopHeight] = useState<number | null>(() => readNumber(SPLIT_KEY));
  const [resizing, setResizing] = useState(false);
  const columnRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startY: number;
    startHeight: number;
    max: number;
  } | null>(null);
  const bothOpen = libOpen && artOpen;

  /** 折叠规则：至少留一段展开。收起时若另一段也已收起，就对调（收我、开它），
   *  这样点头行的动作永远有反馈，也不会出现"两段都收起来"的空栏 */
  const toggleLib = () => {
    if (libOpen) {
      persistBool(LIB_OPEN_KEY, false);
      setLibOpen(false);
      if (!artOpen) {
        persistBool(ART_OPEN_KEY, true);
        setArtOpen(true);
      }
    } else {
      persistBool(LIB_OPEN_KEY, true);
      setLibOpen(true);
    }
  };
  const toggleArt = () => {
    if (artOpen) {
      persistBool(ART_OPEN_KEY, false);
      setArtOpen(false);
      if (!libOpen) {
        persistBool(LIB_OPEN_KEY, true);
        setLibOpen(true);
      }
    } else {
      persistBool(ART_OPEN_KEY, true);
      setArtOpen(true);
    }
  };

  /** 上段可拖到多高：两段内容各留 SECTION_MIN，再扣两条头行 */
  const maxTopHeight = useCallback(() => {
    const h = columnRef.current?.getBoundingClientRect().height ?? 400;
    return Math.max(SECTION_MIN, h - HEADER_H * 2 - SECTION_MIN);
  }, []);

  const beginResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!bothOpen || !topRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startHeight: topRef.current.getBoundingClientRect().height,
      max: maxTopHeight(),
    };
    setResizing(true);
  };
  const moveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 往下拖 = 上段变高；夹在最小高度与「给下段留出最小高度」的上界之间
    setTopHeight(
      Math.min(
        drag.max,
        Math.max(SECTION_MIN, drag.startHeight + (e.clientY - drag.startY)),
      ),
    );
  };
  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    persistNumber(SPLIT_KEY, topHeight);
  };
  const resetSplit = () => {
    setTopHeight(null);
    persistNumber(SPLIT_KEY, null);
  };
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const current =
      topHeight ?? topRef.current?.getBoundingClientRect().height ?? 200;
    const next = Math.min(
      maxTopHeight(),
      Math.max(SECTION_MIN, current + (e.key === "ArrowUp" ? -16 : 16)),
    );
    setTopHeight(next);
    persistNumber(SPLIT_KEY, next);
  };

  // ---- 搜索（两个根一起扫，结果标注来源）----
  const [search, setSearch] = useState<{
    loading: boolean;
    entries: (LibraryScanEntry & { origin: "library" | "artifacts" })[];
    truncated: boolean;
  }>({ loading: false, entries: [], truncated: false });
  useEffect(() => {
    if (!root || !q) {
      setSearch({ loading: false, entries: [], truncated: false });
      return;
    }
    let stale = false;
    setSearch((s) => ({ ...s, loading: true }));
    const scopes: ("library" | "artifacts")[] = artifactsRoot
      ? ["library", "artifacts"]
      : ["library"];
    Promise.all(scopes.map((scope) => libraryScan({ scope, query: q })))
      .then((results) => {
        if (stale) return;
        const entries = results.flatMap((r, i) =>
          r.entries.map((e) => ({ ...e, origin: scopes[i] })),
        );
        setSearch({
          loading: false,
          entries,
          truncated: results.some((r) => r.truncated),
        });
      })
      .catch(() => {
        if (!stale) setSearch({ loading: false, entries: [], truncated: false });
      });
    return () => {
      stale = true;
    };
  }, [root, artifactsRoot, q, refreshSignal]);

  // ---- 拖放（上段整区落库根；文件夹行由树内部处理）----
  const onDropToRoot = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => filePathOf(f))
        .filter((p): p is string => Boolean(p));
      if (paths.length === 0) {
        toast.error("这些内容没有磁盘路径，无法导入");
        return;
      }
      void actions.importPaths(paths, "");
    },
    [actions],
  );

  /**
   * 树内移动（把 A.md 拖进某个文件夹）：destDir = "" 即该树的根。
   * 返回 true 表示确实移动了——树的缓存由 FileExplorer 侧统一失效重拉。
   */
  const handleMoveRow = useCallback(
    async (cwd: string, srcRel: string, destDir: string): Promise<boolean> => {
      const r = await fsMove(cwd, srcRel, destDir);
      if (!r.ok) {
        toast.error(fsErrorText(r.error));
        return false;
      }
      if (!r.moved) return false; // 已经在该目录
      const rel = destDir ? `${destDir}/${r.name}` : r.name;
      // 不弹成功提示：文件出现在新位置 + 选中/查看器跟随，本身就是反馈
      onSelect({ value: rel, cwd, rel, name: r.name });
      return true;
    },
    [onSelect],
  );

  const libraryTree = (
    <FileExplorer
      rootCwd={root}
      onOpenFile={(file) => onSelect({ ...file, value: file.rel })}
      onNewNote={(dir) => void actions.newNote(dir)}
      onImport={(dir) => void actions.pickImport(dir, false)}
      onDropPaths={(paths, dir) => void actions.importPaths(paths, dir)}
      onMoveRow={(src, dir) => (root ? handleMoveRow(root, src, dir) : false)}
      selected={selected && selected.cwd === root ? selected.rel : null}
      stateKey="library"
      refreshSignal={refreshSignal}
      ariaLabel="资料库文件"
      emptyText="还没有文件：拖进来，或先写一条笔记。"
    />
  );

  const artifactsTree = (
    <FileExplorer
      rootCwd={artifactsRoot}
      onOpenFile={(file) => onSelect({ ...file, value: file.rel })}
      labelForName={labelForName}
      onMoveRow={(src, dir) =>
        artifactsRoot ? handleMoveRow(artifactsRoot, src, dir) : false
      }
      selected={selected && selected.cwd === artifactsRoot ? selected.rel : null}
      stateKey="artifacts"
      refreshSignal={refreshSignal}
      ariaLabel="AI 产物文件"
      pendingText="正在准备任务目录…"
      emptyText="还没有 AI 产物。无目录任务里生成或修改的文件会出现在这里。"
    />
  );

  return (
    <div className="flex h-full min-w-0">
      <div
        ref={columnRef}
        className={cn(
          "border-border/60 flex w-72 min-h-0 shrink-0 flex-col border-r",
          resizing && "cursor-row-resize select-none",
        )}
      >
        {q ? (
          /* 搜索态：整栏换成扁平结果（两个根一起扫，标注来源） */
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SearchList
              entries={search.entries}
              loading={search.loading}
              truncated={search.truncated}
              query={q}
              selected={
                selected
                  ? libraryOriginValue(selected, root, artifactsRoot)
                  : null
              }
              onSelect={(e) =>
                onSelect({
                  value: e.rel,
                  cwd: e.origin === "library" ? (root ?? "") : (artifactsRoot ?? ""),
                  rel: e.rel,
                  name: e.name,
                })
              }
            />
          </div>
        ) : (
          <>
            {libOpen && (
              <>
                <SectionHeader
                  icon={LibraryIcon}
                  title="资料库"
                  open
                  onToggle={toggleLib}
                />
                <div
                  ref={topRef}
                  className="min-h-0 overflow-hidden"
                  onDragOver={(e) => {
                    // 只为放行 drop（外部文件落库根）；不再叠加任何区域样式
                    e.preventDefault();
                  }}
                  onDrop={onDropToRoot}
                  style={
                    bothOpen
                      ? topHeight !== null
                        ? { height: topHeight, minHeight: SECTION_MIN, flex: "0 0 auto" }
                        : { flex: "1 1 0%" }
                      : { flex: "1 1 0%" }
                  }
                >
                  <div className="h-full overflow-y-auto">{libraryTree}</div>
                </div>
              </>
            )}

            {/* 两段都展开时才有分割条：拖动调高，双击复位，聚焦后 ↑↓ 也能调 */}
            {bothOpen && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="调整两段高度"
                tabIndex={0}
                title="拖动调整高度（双击复位）"
                onPointerDown={beginResize}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onLostPointerCapture={endResize}
                onDoubleClick={resetSplit}
                onKeyDown={onHandleKeyDown}
                className="group/handle relative flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
              >
                <div className="bg-border/60 pointer-events-none h-px w-full transition-colors group-hover/handle:bg-foreground/30 group-active/handle:bg-foreground/45 group-focus-visible/handle:bg-foreground/45" />
              </div>
            )}

            {artOpen && (
              <>
                <SectionHeader
                  icon={PackageIcon}
                  title="AI 产物"
                  open
                  onToggle={toggleArt}
                />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {artifactsTree}
                </div>
              </>
            )}

            {/* 折叠后的段：只剩头行，钉在栏底 */}
            <div className="mt-auto flex flex-col">
              {!libOpen && (
                <SectionHeader
                  icon={LibraryIcon}
                  title="资料库"
                  open={false}
                  onToggle={toggleLib}
                />
              )}
              {!artOpen && (
                <SectionHeader
                  icon={PackageIcon}
                  title="AI 产物"
                  open={false}
                  onToggle={toggleArt}
                />
              )}
            </div>
          </>
        )}
      </div>

      <FileViewer
        className="flex-1"
        cwd={selected?.cwd ?? root}
        rel={selected?.rel ?? null}
        name={selected?.name ?? ""}
        reloadSignal={refreshSignal}
        emptyActions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void actions.newNote("")}
            >
              <NotebookPenIcon />
              新建笔记
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void actions.pickImport("", false)}
            >
              <ImportIcon />
              导入文件
            </Button>
          </>
        }
      />
    </div>
  );
};

/** 搜索结果高亮键：两个根的 rel 可能同名，只有命中来源的根才算选中 */
function libraryOriginValue(
  selected: LibrarySelection,
  root: string | null,
  artifactsRoot: string | null,
): string | null {
  if (selected.cwd === root || selected.cwd === artifactsRoot) return selected.rel;
  return null;
}