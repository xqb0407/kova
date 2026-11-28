"use client";

/**
 * 资料库页的内容区（页头在 LibraryView 的通栏 header 上，这里只剩内容）。
 *
 * 左栏 = 当前空间（scope）的顶部工具条（搜索 + 添加知识，对齐参考图 2）
 * + FileExplorer 文件树；右栏 = FileViewer，文本类就地编辑。
 *
 * 空间（LibrarySpace）：全局 = 库根本身（旧树，含 项目/ 与 收件箱/）；
 * 项目 = `项目/<目录名>/` 子树（与划词笔记落点同一套规则，见
 * lib/workspace/library-save-note.ts 的 projectFolderFor）。
 *
 * 键翻译层：树/explorer 用**空间相对** rel；FileViewer、library_file_meta_*、
 * 引用构造、删除确认都以**库根**为键（root-relative）——元数据按 (root, rel)
 * 存储，不翻译会在两种作用域下分裂。全局空间 prefix=""，两键恒等，一条代码
 * 路径。搜索：searchLibrary 是库根相对的全量清单，按 prefix 过滤后剥前缀
 * 展示，选中时两个键一起给出。
 */

import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type FC,
} from "react";
import {
  ImportIcon,
  NotebookPenIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileExplorer, type ExplorerFileRef } from "./file-explorer";
import { FileViewer } from "./file-viewer";
import { SearchList } from "./search-list";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { filePathOf } from "@/desktop-bridge/core";
import { fsErrorText, fsMove } from "@/lib/workspace/fs";
import { searchLibrary } from "@/lib/workspace/library-index";
import type { LibraryScanEntry } from "@/lib/workspace/library-files";
import {
  libraryFileMetaDelete,
  libraryFileMetaListSafe,
  libraryFileMetaMove,
} from "@/lib/workspace/library-note-meta";
import {
  joinFsPath,
  type LibraryReference,
} from "@/lib/composer/library-reference";
import type { LibraryActions } from "./use-library-actions";

/** 树里选中的目标（空间相对 + 库根相对两个键） */
export interface LibrarySelection extends ExplorerFileRef {
  /** 树行的取值（与 rel 相同；留着便于对应实例） */
  value: string;
  /** 库根相对路径（引用/元数据/查看器的键；全局空间与 rel 同值） */
  rootRel: string;
}

/** 资料库页当前浏览的空间：全局（旧树）或某个项目子树 */
export interface LibrarySpace {
  /** 空间根绝对路径（必须在库根可信子树内） */
  rootCwd: string;
  /** 库根相对前缀：全局 ""，项目 "项目/<目录名>" */
  prefix: string;
  /** 树展开/选中记忆槽（与全局/各项目互不覆盖） */
  stateKey: string;
}

export const LibraryPane: FC<{
  /** 资料库根（元数据/引用/查看器的键，全页恒定） */
  root: string | null;
  space: LibrarySpace;
  selected: LibrarySelection | null;
  onSelect: (sel: LibrarySelection | null) => void;
  refreshSignal: number;
  actions: LibraryActions;
  /** 「引用到对话」：两个空间都提供（引用指针指向库根下的真实文件） */
  onReference: (ref: LibraryReference) => void;
  /** 当前草稿是否引用了该文件/目录（删除确认框警示行用；库根相对 rel） */
  isReferenced?: (rel: string, isDir: boolean) => boolean;
  /** 资料库内容变化（应用内删除等）：页面 bump 刷新信号 */
  onLibraryChanged?: () => void;
}> = ({
  root,
  space,
  selected,
  onSelect,
  refreshSignal,
  actions,
  onReference,
  isReferenced,
  onLibraryChanged,
}) => {
  const t = useT();
  const { prefix, rootCwd: spaceRoot } = space;

  /** 左栏顶部搜索（对齐参考图 2；防抖后整栏换成扁平结果） */
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  const q = debouncedQuery.trim();

  // 切空间清搜索：上个空间的命中结果不残留到新空间。
  // （选中不清——跨页打开请求会在切空间的同一帧带上新选中；点卡片进入
  // 时的清空由 LibraryView.openSpace 负责）
  useEffect(() => {
    setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceRoot, prefix]);

  // ---- 键翻译：空间相对 ↔ 库根相对 ----
  const toRootRel = useCallback(
    (rel: string) => (prefix ? `${prefix}/${rel}` : rel),
    [prefix],
  );
  /** 不在当前空间内的 rootRel 返回 null（调用方自行兜底） */
  const toSpaceRel = useCallback(
    (rootRelValue: string): string | null => {
      if (!prefix) return rootRelValue;
      if (rootRelValue.startsWith(`${prefix}/`)) {
        return rootRelValue.slice(prefix.length + 1);
      }
      return null;
    },
    [prefix],
  );

  /** 在当前空间内选中（两个键一起给） */
  const selectInSpace = useCallback(
    (rel: string, name: string) => {
      onSelect({
        value: rel,
        cwd: spaceRoot,
        rel,
        name,
        rootRel: toRootRel(rel),
      });
    },
    [onSelect, spaceRoot, toRootRel],
  );

  // ---- 笔记页面图标（库根相对 rel → icon）----
  // 来源是 library_file_meta 的 icon 列（编辑器改图标时同步写入）；树行命中
  // 就覆盖通用文件图标（Notion 侧栏行为）。随 root/刷新信号重拉，编辑器里
  // 改图标走 onNoteIconChanged 即时更新，不等下一轮刷新。
  const [noteIcons, setNoteIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!root) {
      setNoteIcons({});
      return;
    }
    let stale = false;
    void libraryFileMetaListSafe(root).then((list) => {
      if (stale) return;
      const map: Record<string, string> = {};
      for (const entry of list.entries) {
        if (entry.icon && !entry.missing) map[entry.rel] = entry.icon;
      }
      setNoteIcons(map);
    });
    return () => {
      stale = true;
    };
  }, [root, refreshSignal]);

  /** 查看器里改了图标：只动当前文件的键，值没变就不触发重渲染 */
  const handleNoteIconChanged = useCallback(
    (icon: string | null) => {
      if (!selected) return;
      const rel = selected.rootRel;
      setNoteIcons((prev) => {
        if (icon) {
          if (prev[rel] === icon) return prev;
          return { ...prev, [rel]: icon };
        }
        if (!(rel in prev)) return prev;
        const next = { ...prev };
        delete next[rel];
        return next;
      });
    },
    [selected],
  );

  /** 树行的 rel 是空间相对的，元数据是库根相对的：这里做键翻译 */
  const noteIconFor = useCallback(
    (rel: string) => noteIcons[toRootRel(rel)],
    [noteIcons, toRootRel],
  );

  // ---- 搜索（searchLibrary 是库根相对的全量清单，按 prefix 过滤剥壳）----
  const [search, setSearch] = useState<{
    loading: boolean;
    entries: LibraryScanEntry[];
    truncated: boolean;
  }>({ loading: false, entries: [], truncated: false });
  useEffect(() => {
    if (!root || !q) {
      setSearch({ loading: false, entries: [], truncated: false });
      return;
    }
    let stale = false;
    setSearch((s) => ({ ...s, loading: true }));
    searchLibrary(q, { under: prefix || undefined })
      .then((r) => {
        if (stale) return;
        const prefixDir = prefix ? `${prefix}/` : "";
        setSearch({
          loading: false,
          entries: r.entries
            .filter((e) => (prefixDir ? e.rel.startsWith(prefixDir) : true))
            .map((e) => ({
              ...e,
              rel: prefixDir ? e.rel.slice(prefixDir.length) : e.rel,
            })),
          truncated: r.truncated,
        });
      })
      .catch(() => {
        if (!stale) setSearch({ loading: false, entries: [], truncated: false });
      });
    return () => {
      stale = true;
    };
  }, [root, prefix, q, refreshSignal]);

  // ---- 拖放（整栏落当前空间根；文件夹行由树内部处理）----
  const onDropToSpace = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => filePathOf(f))
        .filter((p): p is string => Boolean(p));
      if (paths.length === 0) {
        toast.error(t("library.common.noDiskPath"));
        return;
      }
      void actions.importPaths(paths, prefix);
    },
    [actions, prefix, t],
  );

  /**
   * 树内移动（把 A.md 拖进某个文件夹）：destDir = "" 即空间根。本就在空间
   * 子树内移动，不需要键翻译；返回 true 表示确实移动了（FileExplorer 侧
   * 统一失效缓存重拉）。
   */
  const handleMoveRow = useCallback(
    async (
      srcRel: string,
      destDir: string,
      meta?: { batch: boolean },
    ): Promise<{ moved: boolean; name: string } | false> => {
      const r = await fsMove(spaceRoot, srcRel, destDir);
      if (!r.ok) {
        toast.error(fsErrorText(r.error));
        return false;
      }
      if (!r.moved) return { moved: false, name: r.name }; // 已经在该目录
      const rel = destDir ? `${destDir}/${r.name}` : r.name;
      // 不弹成功提示：文件出现在新位置 + 选中/查看器跟随，本身就是反馈。
      // 批量移动时由 FileExplorer 统一重映射选区、并回调活动项新路径；
      // 这里逐个 select 会把多选收敛成最后移动的一项。
      if (!meta?.batch) selectInSpace(rel, r.name);
      // name 用于多选拖拽后把选区 rel 跟到重名自动改号后的新路径
      return { moved: true, name: r.name };
    },
    [spaceRoot, selectInSpace],
  );

  /** 批量移动后活动项换了路径：右栏跟过去（不重复触发打开/刷新） */
  const handlePrimaryChange = useCallback(
    (file: ExplorerFileRef) => selectInSpace(file.rel, file.name),
    [selectInSpace],
  );

  /** 资料库引用构造：库根相对 rel + 固化的绝对路径（插入时定格） */
  const referenceOf = useCallback(
    (
      rootRelValue: string,
      name: string,
      range?: { startLine: number; endLine: number },
    ): LibraryReference | null => {
      if (!root) return null;
      return {
        rel: rootRelValue,
        name,
        absPath: joinFsPath(root, rootRelValue),
        ...(range ?? {}),
      };
    },
    [root],
  );

  /** 应用内删除（explorer 给空间相对 rel）：元数据按库根相对清理 */
  const handleDeleted = useCallback(
    (rel: string, isDir: boolean) => {
      if (root) {
        void libraryFileMetaDelete(root, [toRootRel(rel)], isDir).catch(
          () => {},
        );
      }
      onLibraryChanged?.();
    },
    [root, toRootRel, onLibraryChanged],
  );

  /** explorer 内改名：迁移标签元数据（库根相对）+ 选中项跟到新路径 */
  const handleExplorerRenamed = useCallback(
    (oldRel: string, newRel: string, newName: string, isDir = false) => {
      if (root) {
        void libraryFileMetaMove(
          root,
          toRootRel(oldRel),
          toRootRel(newRel),
          isDir,
        ).catch(() => {});
      }
      selectInSpace(newRel, newName);
      onLibraryChanged?.();
    },
    [root, toRootRel, selectInSpace, onLibraryChanged],
  );

  /** 查看器点文件名改名（库根相对；只在同目录改名，必落在当前空间内） */
  const handleViewerRenamed = useCallback(
    (newRootRel: string, newName: string) => {
      const oldRootRel = selected?.rootRel;
      if (root && oldRootRel) {
        void libraryFileMetaMove(root, oldRootRel, newRootRel, false).catch(
          () => {},
        );
      }
      const spaceRel = toSpaceRel(newRootRel);
      if (spaceRel !== null) selectInSpace(spaceRel, newName);
      else onSelect(null);
      onLibraryChanged?.();
    },
    [root, selected, toSpaceRel, selectInSpace, onSelect, onLibraryChanged],
  );

  /** 删除确认的引用检查：explorer 给空间相对 rel，草稿引用是库根相对 */
  const isReferencedInSpace = useCallback(
    (rel: string, isDir: boolean) =>
      isReferenced ? isReferenced(toRootRel(rel), isDir) : false,
    [isReferenced, toRootRel],
  );

  /** dir 是 explorer 内的空间相对目录 → 动作要库根相对目录 */
  const dirToRoot = useCallback(
    (dir: string) => (prefix ? `${prefix}/${dir}` : dir),
    [prefix],
  );

  /** 树的清空信号（删除文件/文件夹、选中的父目录被删）要传回页面，
   *  否则右栏会停在已删除文件的旧内容上。稳定引用：避免父级重渲染时
   *  整棵 FileExplorer 声明树 memo 失效（大资料库每次选择都重建）。 */
  const handleSelectedChange = useCallback(
    (rel: string | null) => {
      if (rel === null) onSelect(null);
    },
    [onSelect],
  );

  const tree = (
    <FileExplorer
      rootCwd={spaceRoot}
      multiSelect
      onOpenFile={(file) => selectInSpace(file.rel, file.name)}
      onNewNote={(dir) => void actions.newNote(dirToRoot(dir))}
      onImport={(dir) => void actions.pickImport(dirToRoot(dir), false)}
      onDropPaths={(paths, dir) =>
        void actions.importPaths(paths, dirToRoot(dir))
      }
      onMoveRow={handleMoveRow}
      onReferenceFile={(rel, name) => {
        const ref = referenceOf(toRootRel(rel), name);
        if (ref) onReference(ref);
      }}
      onDeleted={handleDeleted}
      onRenamed={handleExplorerRenamed}
      onPrimaryChange={handlePrimaryChange}
      isReferenced={isReferencedInSpace}
      selected={selected && selected.cwd === spaceRoot ? selected.rel : null}
      // 树的清空信号（删除文件/文件夹、选中的父目录被删）要传回页面，
      // 否则右栏会停在已删除文件的旧内容上
      onSelectedChange={handleSelectedChange}
      stateKey={space.stateKey}
      refreshSignal={refreshSignal}
      noteIconFor={noteIconFor}
      ariaLabel={t("library.pane.libraryAria")}
      emptyText={
        prefix
          ? t("library.space.emptyProject")
          : t("library.pane.libraryEmpty")
      }
    />
  );

  return (
    <div className="flex h-full min-w-0">
      <div
        className="border-border/60 flex w-72 min-h-0 shrink-0 flex-col border-r"
        onDragOver={(e) => {
          // 只为放行 drop（外部文件落当前空间根）；不再叠加任何区域样式
          e.preventDefault();
        }}
        onDrop={onDropToSpace}
      >
        {/* 左栏顶部工具条（对齐参考图 2）：一行 = 搜索 + 添加（图标钮）。
            行高与下方 36px 树行同密度，避免两颗大控件把左栏顶撑出一块
            「面板头」的观感 */}
        <div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2.5 pb-1.5">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="text-muted-foreground/70 pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                prefix
                  ? t("library.space.searchPlaceholder")
                  : t("library.view.searchPlaceholder")
              }
              className="h-8 rounded-md bg-muted/60 pl-8 text-sm"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  title={t("library.space.add")}
                >
                  <PlusIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem onClick={() => void actions.newNote(prefix)}>
                <NotebookPenIcon />
                {t("library.common.newNote")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void actions.pickImport(prefix, false)}
              >
                <ImportIcon />
                {t("library.common.importFile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void actions.pickImport(prefix, true)}
              >
                <ImportIcon />
                {t("library.common.importFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {q ? (
          /* 搜索态：整栏换成扁平结果（已在当前空间内过滤） */
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SearchList
              entries={search.entries}
              loading={search.loading}
              truncated={search.truncated}
              query={q}
              selected={
                selected && selected.cwd === spaceRoot ? selected.rel : null
              }
              onSelect={(e) => selectInSpace(e.rel, e.name)}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
        )}
      </div>

      <FileViewer
        className="flex-1"
        cwd={root}
        rel={selected?.rootRel ?? null}
        name={selected?.name ?? ""}
        reloadSignal={refreshSignal}
        onReference={
          selected && root
            ? (range) => {
                const ref = referenceOf(selected.rootRel, selected.name, range);
                if (ref) onReference(ref);
              }
            : undefined
        }
        metaEnabled={Boolean(selected && root)}
        onNoteIconChanged={handleNoteIconChanged}
        onRenamed={selected ? handleViewerRenamed : undefined}
        emptyActions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void actions.newNote(prefix)}
            >
              <NotebookPenIcon />
              {t("library.common.newNote")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void actions.pickImport(prefix, false)}
            >
              <ImportIcon />
              {t("library.common.importFile")}
            </Button>
          </>
        }
      />
    </div>
  );
};
