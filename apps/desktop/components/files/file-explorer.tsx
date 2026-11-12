"use client";

/**
 * 通用文件树浏览器（agent 面板「文件」标签、资料库页/设置产物页共用）。
 *
 * 单根渲染：一行取值 = 相对 rootCwd 的路径。资料库页按当前空间（全局 /
 * 项目子树）各挂一个实例，设置产物页按会话产物目录挂实例，展开/选中记忆
 * 由 stateKey 分区，互不干扰。
 *
 * 树数据 = Rust fs_list_dir 单层懒加载（lib/file-tree store，按 cwd+dir 缓存、
 * 只给已展开目录建节点）；FileTree 内部虚拟滚动，大目录只挂载视口 ±overscan。
 * 右键菜单与对话框（新建文件/文件夹、重命名、删除）在本组件内闭环；写操作走
 * fs.rs 写命令，完成后失效缓存、版本 bump 驱动重拉。
 *
 * 差别化能力都由 props 注入，不在组件里读「当前是谁在用」：
 * - labelForName：行展示名覆盖（产物页根层的 UUID 目录显示会话标题）；
 * - fileMenuPrefix：文件菜单在「打开」之后追加项（面板的浏览器预览）；
 * - onNewNote / onImport / onDropPaths：资料库的建笔记/导入/拖放（只挂主树的实例）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  FilePlus2Icon,
  FolderOpenIcon,
  FolderPlusIcon,
  ImportIcon,
  NotebookPenIcon,
} from "lucide-react";
import {
  ensureDir,
  getDir,
  isDirLoading,
  refreshFileTree,
  useFileTreeVersion,
  useFileTreeWiring,
} from "@/lib/workspace/file-tree";
import {
  fsDelete,
  fsErrorText,
  fsMkdir,
  fsRename,
  fsReveal,
  fsTouch,
} from "@/lib/workspace/fs";
import { isDesktop } from "@/lib/desktop-env";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  type FileTreeRowDragHandlers,
  type FileTreeRowDragSource,
} from "@/components/custom-ui/file-tree";
import { filePathOf } from "@/desktop-bridge/core";
import { cn } from "@/lib/utils";
import { t, useT } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const joinRel = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

/** 树内拖动载荷的 MIME：外部文件拖入（DataTransfer.files）与树内移动（本类型）
 *  靠它区分——前者走导入，后者走移动 */
const TREE_DRAG_MIME = "application/x-kova-tree-rel";

/** 拖拽悬停在收起的文件夹行上多久自动展开（macOS 弹性文件夹的手感） */
const DRAG_HOVER_EXPAND_MS = 700;

/** 文件/文件夹命名中不允许的字符（与 fs.rs is_bad_name 同规则） */
const BAD_NAME_RE = /[\\/:*?"<>|]/;

/** 菜单项统一版式（与侧栏会话菜单一致：不带行内图标、36px 行、px-3、右留快捷键位） */
const MenuItem: FC<{
  destructive?: boolean;
  className?: string;
  onClick?: () => void;
  children?: ReactNode;
}> = ({ destructive, className, onClick, children }) => (
  <ContextMenuItem
    variant={destructive ? "destructive" : "default"}
    className={cn(
      "justify-between gap-6 rounded-md px-3 py-2",
      !destructive && "focus:bg-accent",
      className,
    )}
    onClick={onClick}
  >
    {children}
  </ContextMenuItem>
);

/** 树里的一个文件目标 */
export interface ExplorerFileRef {
  cwd: string;
  rel: string;
  name: string;
}

type TreeMenuTarget =
  | { kind: "file" | "folder"; rel: string; name: string; x: number; y: number }
  | { kind: "root"; x: number; y: number };

type NameDialogState =
  | { mode: "new-file" | "new-folder"; dir: string }
  | { mode: "rename"; rel: string; name: string; isDir: boolean };

type DeleteTarget = { rel: string; name: string; isDir: boolean };

type RowContextMenuHandler = (
  event: ReactMouseEvent<HTMLButtonElement>,
  kind: "file" | "folder",
  rel: string,
  name: string,
) => void;

export interface FileExplorerProps {
  /** 树根绝对路径（必须在主进程可信根内）；null = 尚未解析出来 */
  rootCwd: string | null;
  /** 点击文件（面板开标签 / 资料库右栏查看器） */
  onOpenFile: (file: ExplorerFileRef) => void;
  /** 行展示名覆盖（AI 产物根层 UUID 目录 → 会话标题） */
  labelForName?: (name: string, rel: string, isDir: boolean) => string | undefined;
  /** 文件菜单「打开」之后的追加项（面板的浏览器预览） */
  fileMenuPrefix?: (rel: string, name: string) => ReactNode;
  /** 文件菜单「引用到对话」（资料库根才提供；AI 产物树不传） */
  onReferenceFile?: (rel: string, name: string) => void;
  /** 应用内删除成功后的回调（资料库清理元数据行 + 引用守卫重校验） */
  onDeleted?: (rel: string, isDir: boolean) => void;
  /** 应用内改名成功后的回调（页面更新选中项 + 迁移标签元数据；目录按前缀迁移） */
  onRenamed?: (
    oldRel: string,
    newRel: string,
    newName: string,
    isDir: boolean,
  ) => void;
  /** 删除确认前查询：该文件/目录是否被当前草稿引用（命中时确认框加警示行） */
  isReferenced?: (rel: string, isDir: boolean) => boolean;
  /** 根目录空态文案（缺省「此目录暂无文件」） */
  emptyText?: string;
  /** 提供后菜单/空态出现「新建笔记」，在 dir 下建一条 Markdown */
  onNewNote?: (dir: string) => void;
  /** 提供后菜单出现「导入到此处…」，把外部文件拷进 dir */
  onImport?: (dir: string) => void;
  /** 提供后文件夹行成为投放目标：外部文件拖到该行即导入该目录 */
  onDropPaths?: (paths: string[], dir: string) => void;
  /** 提供后行可拖动（树内移动）：拖到文件夹行 / 空白区落进该目录或根。
   *  返回 true 表示确实移动了（组件据此失效缓存重拉）；失败/原位返回 false */
  onMoveRow?: (srcRel: string, destDir: string) => boolean | Promise<boolean>;
  /** 展开/选中记忆槽（"panel" / "library" / "artifacts" 各一份） */
  stateKey: string;
  /** 受控选中（资料库用来高亮右栏正在看的文件）；不给则组件自管 */
  selected?: string | null;
  onSelectedChange?: (rel: string | null) => void;
  /** 数值变化即失效缓存重拉（调用方写操作后用） */
  refreshSignal?: number;
  ariaLabel?: string;
  /** 根目录未就绪时的占位文案 */
  pendingText?: string;
}

/**
 * 收集「可见且应已缓存」的目录：根 + 沿已加载数据能走到的展开链。
 * 未加载的展开目录走不深，等它补水触发版本 bump 后 effect 再跑一遍，
 * 逐层收敛（self-healing：store 只失效不主动重拉）。
 */
function collectVisibleDirs(cwd: string, expanded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    out.push(rel);
    const listing = getDir(cwd, rel);
    if (!listing) continue;
    for (const e of listing.entries) {
      if (!e.dir) continue;
      const child = joinRel(rel, e.name);
      if (expanded.has(child)) stack.push(child);
    }
  }
  return out;
}

/** 从缓存递归生成声明式树；只有展开且已加载的目录才下探 */
function renderEntries(
  cwd: string,
  rel: string,
  expanded: ReadonlySet<string>,
  onRowContextMenu: RowContextMenuHandler,
  labelForName: FileExplorerProps["labelForName"],
  dragForFolder?: (dir: string) => FileTreeRowDragHandlers | undefined,
  dropDir?: string | null,
  dragSourceFor?: (rel: string) => FileTreeRowDragSource | undefined,
  draggingRel?: string | null,
): ReactNode[] {
  const listing = getDir(cwd, rel);
  if (!listing) {
    // 展开的目录补水在途：占位行保住展开反馈（disabled 行不可选中）
    return [
      <FileTreeFile
        key={`${rel}\u0000loading`}
        value={`${rel}\u0000loading`}
        name={isDirLoading(cwd, rel) ? t("common.action.loading") : t("library.explorer.unreadable")}
        disabled
      />,
    ];
  }
  const rows = listing.entries.map((e) => {
    const child = joinRel(rel, e.name);
    if (e.dir) {
      return (
        <FileTreeFolder
          key={child}
          value={child}
          name={labelForName?.(e.name, child, true) ?? e.name}
          onContextMenu={(event) =>
            onRowContextMenu(event, "folder", child, e.name)
          }
          dragHandlers={dragForFolder?.(child)}
          dragSource={dragSourceFor?.(child)}
          className={cn(
            // 投放目标：整圈描边（颜色与根区落点线同一个 --drop-line token）；
            // 基础行已预留 1px 透明边框，所以这里只换颜色、不产生位移
            dropDir === child && "border-[var(--drop-line)]",
            draggingRel === child && "opacity-40",
          )}
        >
          {expanded.has(child)
            ? renderEntries(
                cwd,
                child,
                expanded,
                onRowContextMenu,
                labelForName,
                dragForFolder,
                dropDir,
                dragSourceFor,
                draggingRel,
              )
            : null}
        </FileTreeFolder>
      );
    }
    return (
      <FileTreeFile
        key={child}
        value={child}
        name={labelForName?.(e.name, child, false) ?? e.name}
        icon={<FileTypeIcon path={e.name} />}
        onContextMenu={(event) => onRowContextMenu(event, "file", child, e.name)}
        dragSource={dragSourceFor?.(child)}
        className={cn(draggingRel === child && "opacity-50")}
      />
    );
  });
  if (listing.truncated) {
    rows.push(
      <FileTreeFile
        key={`${rel}\u0000truncated`}
        value={`${rel}\u0000truncated`}
        name={t("library.explorer.truncated")}
        disabled
      />,
    );
  }
  return rows;
}

/** 小空态占位（与面板标签空态同观感） */
const ExplorerNotice: FC<{ text: string }> = ({ text }) => (
  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
    <FolderOpenIcon className="size-6" />
    <p>{text}</p>
  </div>
);

/** 根目录空态：快捷动作直连既有对话框；空白区右键的根菜单仍然可用 */
const TreeEmptyState: FC<{
  text: string;
  onNewFile: () => void;
  onNewFolder: () => void;
  onNewNote?: () => void;
  onImport?: () => void;
}> = ({ text, onNewFile, onNewFolder, onNewNote, onImport }) => {
  const t = useT();
  return (
  // 顶部对齐（不再竖直居中）：资料库页左栏是窄而高的一列，居中的空态会
  // 飘在中间显得空；贴顶更接近浏览器的空目录观感
  <div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-10 text-center text-xs select-none">
    <FolderOpenIcon className="size-6" />
    <p>{text}</p>
    <div className="flex flex-wrap items-center justify-center gap-2">
      {onNewNote && (
        <Button variant="outline" size="sm" onClick={onNewNote}>
          <NotebookPenIcon />
          {t("library.common.newNote")}
        </Button>
      )}
      {onImport && (
        <Button variant="outline" size="sm" onClick={onImport}>
          <ImportIcon />
          {t("library.common.importFile")}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onNewFile}>
        <FilePlus2Icon />
        {t("library.common.newFile")}
      </Button>
      <Button variant="outline" size="sm" onClick={onNewFolder}>
        <FolderPlusIcon />
        {t("library.common.newFolder")}
      </Button>
    </div>
    <p className="text-muted-foreground">{t("library.explorer.emptyHint")}</p>
  </div>
  );
};

type TreeState = {
  root: string;
  expanded: string[];
  selected: string | null;
};

/** 展开/选中状态的模块级记忆槽：使用处重挂载（面板切标签、资料库切段）不丢
 *  展开态；按 stateKey 分区，各使用处互不覆盖（切 rootCwd 时自然重置）。 */
const treeStateCache = new Map<string, TreeState>();
const TREE_STATE_STORAGE_PREFIX = "kova.file-tree.state.v1:";

/** 读记忆：内存优先，其次 localStorage（整窗刷新/重载后仍能恢复展开态） */
function readTreeState(stateKey: string, root: string): TreeState | null {
  const cached = treeStateCache.get(stateKey);
  if (cached && cached.root === root) return cached;
  try {
    const raw = localStorage.getItem(TREE_STATE_STORAGE_PREFIX + stateKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TreeState> | null;
    if (!parsed || parsed.root !== root || !Array.isArray(parsed.expanded)) {
      return null;
    }
    const value: TreeState = {
      root,
      expanded: parsed.expanded.filter(
        (rel): rel is string => typeof rel === "string",
      ),
      selected: typeof parsed.selected === "string" ? parsed.selected : null,
    };
    treeStateCache.set(stateKey, value);
    return value;
  } catch {
    return null;
  }
}

function writeTreeState(stateKey: string, value: TreeState): void {
  treeStateCache.set(stateKey, value);
  try {
    localStorage.setItem(
      TREE_STATE_STORAGE_PREFIX + stateKey,
      JSON.stringify(value),
    );
  } catch {
    /* 隐私模式/配额满：内存记忆仍有效 */
  }
}

export const FileExplorer: FC<FileExplorerProps> = ({
  rootCwd,
  onOpenFile,
  labelForName,
  fileMenuPrefix,
  onReferenceFile,
  onDeleted,
  onRenamed,
  isReferenced,
  emptyText,
  onNewNote,
  onImport,
  onDropPaths,
  onMoveRow,
  stateKey,
  selected: selectedProp,
  onSelectedChange,
  refreshSignal,
  ariaLabel,
  pendingText,
}) => {
  const t = useT();
  useFileTreeWiring();
  const treeVersion = useFileTreeVersion();
  const controlled = selectedProp !== undefined;
  const [innerSelected, setInnerSelected] = useState<string | null>(null);
  const selected = controlled ? selectedProp! : innerSelected;
  const [expanded, setExpanded] = useState<string[]>([]);
  /** 右键菜单目标（null = 关闭）：行条目或空白区（根目录） */
  const [menu, setMenu] = useState<TreeMenuTarget | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  /** 拖拽悬停中的投放目录（文件夹行高亮） */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** 悬停自动展开的计时器（拖动经过收起的文件夹时，停够时长就展开它） */
  const hoverExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverExpandDirRef = useRef<string | null>(null);
  const cancelHoverExpand = useCallback(() => {
    if (hoverExpandTimerRef.current) {
      clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = null;
    }
    hoverExpandDirRef.current = null;
  }, []);
  /** 正在被拖动的行（淡化标记） */
  const [draggingRel, setDraggingRel] = useState<string | null>(null);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  /** 选中写入：受控交给父级，非受控落本地 state（并始终外播） */
  const setSelected = useCallback(
    (rel: string | null) => {
      if (!controlled) setInnerSelected(rel);
      onSelectedChange?.(rel);
    },
    [controlled, onSelectedChange],
  );

  // 根变化/首次到位：从记忆槽恢复展开与选中。用 rootRef 做幂等——同一根
  // 的普通重渲染（以及 StrictMode 的 effect 复跑）不能把用户刚展开的目录重置。
  // 受控模式只恢复**展开态**：选中由父级全权管理（此刻父级可能刚带着新选中
  // 切根，比如跨空间打开请求——外推缓存/null 会把它抹掉）；高亮本就跟着
  // selected prop 走。非受控（面板文件页签）保持原有恢复行为。
  const rootRef = useRef<string | null>(null);
  /** 恢复目标：写回 effect 等展开态真正落地后再写，避免初始空数组盖掉缓存 */
  const pendingRestoreRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (!rootCwd || rootRef.current === rootCwd) return;
    rootRef.current = rootCwd;
    const cached = readTreeState(stateKey, rootCwd);
    const nextExpanded = cached?.expanded ?? [];
    const nextSelected = cached?.selected ?? null;
    pendingRestoreRef.current = nextExpanded;
    setExpanded(nextExpanded);
    if (!controlled) setSelected(nextSelected);
    setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootCwd, stateKey]);

  // 展开/选中写回记忆槽（内存 + localStorage）：恢复帧先等 state 对齐，
  // 否则初次渲染的空 [] 会把要恢复的展开态原地覆盖（表现为刷新后文件夹关闭）。
  useEffect(() => {
    if (!rootCwd) return;
    const pending = pendingRestoreRef.current;
    if (pending) {
      const sameExpanded =
        expanded.length === pending.length &&
        expanded.every((rel, index) => rel === pending[index]);
      // 只等展开态落地；受控选中可能被父级忽略（资料库右栏），不能因此
      // 永远卡住写回，否则之后的展开都不会进缓存。
      if (!sameExpanded) return;
      pendingRestoreRef.current = null;
    }
    writeTreeState(stateKey, { root: rootCwd, expanded, selected });
  }, [rootCwd, stateKey, expanded, selected]);

  // 补水：可见目录链缺缓存就拉（挂载、展开变化、失效 bump 后各收敛一次）
  useEffect(() => {
    if (!rootCwd || !isDesktop()) return;
    for (const dir of collectVisibleDirs(rootCwd, expandedSet)) {
      ensureDir(rootCwd, dir);
    }
  }, [rootCwd, expandedSet, treeVersion]);

  /** 写操作后的公共收尾：失效该 rootCwd 全部目录缓存，版本 bump 驱动重拉 */
  const refreshTree = useCallback(() => {
    if (rootCwd) refreshFileTree(rootCwd);
  }, [rootCwd]);

  // 外部驱动的刷新（导入/新建笔记后调用方 bump 计数）
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === lastSignal.current) return;
    lastSignal.current = refreshSignal;
    refreshTree();
  }, [refreshSignal, refreshTree]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!rootCwd) return;
      const idx = value.lastIndexOf("/");
      const parent = idx < 0 ? "" : value.slice(0, idx);
      const name = idx < 0 ? value : value.slice(idx + 1);
      const entry = getDir(rootCwd, parent)?.entries.find(
        (e) => e.name === name,
      );
      if (!entry || entry.dir) return; // 文件夹只做展开/收起
      setSelected(value);
      onOpenFile({ cwd: rootCwd, rel: value, name });
    },
    [rootCwd, onOpenFile, setSelected],
  );

  const handleRowContextMenu = useCallback<RowContextMenuHandler>(
    (event, kind, rel, name) => {
      event.preventDefault();
      event.stopPropagation();
      setSelected(rel);
      setMenu({ kind, rel, name, x: event.clientX, y: event.clientY });
    },
    [setSelected],
  );

  /**
   * 文件夹行的拖放目标：
   * - 外部文件（DataTransfer.files）→ 导入该目录（onDropPaths）；
   * - 树内拖动（TREE_DRAG_MIME）→ 移动进该目录（onMoveRow）。
   * 两类都在行上 stopPropagation：不让外层（资料库页整区的落库根投放）重复处理。
   */
  const dragForFolder = useCallback(
    (dir: string): FileTreeRowDragHandlers | undefined => {
      if (!onDropPaths && !onMoveRow) return undefined;
      const isInternal = (e: React.DragEvent) =>
        Array.from(e.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME);
      return {
        onDragOver: (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = isInternal(event) ? "move" : "copy";
          setDropDir((d) => (d === dir ? d : dir));
          // 弹性文件夹：停在收起的目录上够久就自动展开，好继续往里拖
          // （已展开的目录不排计时）
          if (expandedSet.has(dir)) {
            cancelHoverExpand();
          } else if (hoverExpandDirRef.current !== dir) {
            cancelHoverExpand();
            hoverExpandDirRef.current = dir;
            hoverExpandTimerRef.current = setTimeout(() => {
              hoverExpandTimerRef.current = null;
              hoverExpandDirRef.current = null;
              setExpanded((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
            }, DRAG_HOVER_EXPAND_MS);
          }
        },
        onDragLeave: (event) => {
          event.stopPropagation();
          setDropDir((d) => (d === dir ? null : d));
          cancelHoverExpand();
        },
        onDrop: (event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropDir(null);
          cancelHoverExpand();
          if (isInternal(event)) {
            const src = event.dataTransfer.getData(TREE_DRAG_MIME);
            if (src) {
              void Promise.resolve(onMoveRow?.(src, dir)).then((changed) => {
                if (changed) refreshTree();
              });
            }
            return;
          }
          if (!onDropPaths) return;
          const paths = Array.from(event.dataTransfer?.files ?? [])
            .map((f) => filePathOf(f))
            .filter((p): p is string => Boolean(p));
          if (paths.length === 0) {
            toast.error(t("library.common.noDiskPath"));
            return;
          }
          onDropPaths(paths, dir);
        },
      };
    },
    [onDropPaths, onMoveRow, refreshTree, expandedSet, cancelHoverExpand, t],
  );

  /** 行作为拖拽源（树内移动）；拖动期间给源行加个淡化标记 */
  const dragSourceFor = useCallback(
    (rel: string): FileTreeRowDragSource | undefined => {
      if (!onMoveRow) return undefined;
      return {
        onDragStart: (event) => {
          event.stopPropagation();
          event.dataTransfer.setData(TREE_DRAG_MIME, rel);
          event.dataTransfer.effectAllowed = "move";
          setDraggingRel(rel);
        },
        onDragEnd: () => {
          setDraggingRel(null);
          cancelHoverExpand();
        },
      };
    },
    [onMoveRow, cancelHoverExpand],
  );

  /**
   * 树的空白区：接住树内拖动 → 移到该树的根（外部文件仍冒泡给页面处理）。
   * 刻意**不给任何视觉**：这里覆盖的是整棵树的空白，画线/描边都会像"给最外层
   * 加了个框"（用户实测反馈）；落根是显式拖拽动作，落点由移动结果与选中反馈。
   */
  const onRootDragOver = (event: React.DragEvent) => {
    if (!onMoveRow) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  };
  const onRootDrop = (event: React.DragEvent) => {
    if (!onMoveRow) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropDir(null);
    cancelHoverExpand();
    const src = event.dataTransfer.getData(TREE_DRAG_MIME);
    if (src) {
      void Promise.resolve(onMoveRow?.(src, "")).then((changed) => {
        if (changed) refreshTree();
      });
    }
  };

  const reveal = async (rel: string) => {
    if (!rootCwd) return;
    const err = await fsReveal(rootCwd, rel);
    if (err) toast.error(fsErrorText(err));
  };

  /** 复制路径（abs=true 绝对路径，按平台分隔符拼接；false 相对路径） */
  const copyPath = async (rel: string, abs: boolean) => {
    if (!rootCwd) return;
    const sep = rootCwd.includes("\\") ? "\\" : "/";
    const text = abs
      ? rel
        ? `${rootCwd}${sep}${rel.split("/").join(sep)}`
        : rootCwd
      : rel;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error(t("library.explorer.copyFailed"));
    }
  };

  const startNew = (mode: "new-file" | "new-folder", dir: string) => {
    setNameValue("");
    setNameDialog({ mode, dir });
  };

  const startRename = (rel: string, name: string, isDir: boolean) => {
    setNameValue(name);
    setNameDialog({ mode: "rename", rel, name, isDir });
  };

  const submitNameDialog = async () => {
    if (!nameDialog || !rootCwd) return;
    const name = nameValue.trim();
    if (!name || BAD_NAME_RE.test(name)) {
      toast.error(fsErrorText("bad-name"));
      return;
    }
    let err: string | null;
    if (nameDialog.mode === "rename") {
      if (name === nameDialog.name) {
        setNameDialog(null);
        return;
      }
      err = await fsRename(rootCwd, nameDialog.rel, name);
      if (!err) {
        const idx = nameDialog.rel.lastIndexOf("/");
        const parent = idx < 0 ? "" : nameDialog.rel.slice(0, idx);
        const newRel = parent ? `${parent}/${name}` : name;
        setSelected(newRel);
        onRenamed?.(nameDialog.rel, newRel, name, nameDialog.isDir);
      }
    } else {
      const target = nameDialog.dir ? `${nameDialog.dir}/${name}` : name;
      err =
        nameDialog.mode === "new-file"
          ? await fsTouch(rootCwd, target)
          : await fsMkdir(rootCwd, target);
    }
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    setNameDialog(null);
    refreshTree();
  };

  const confirmDeleteEntry = async () => {
    if (!deleteTarget || !rootCwd) return;
    const err = await fsDelete(rootCwd, deleteTarget.rel);
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    setSelected(
      selected === deleteTarget.rel || selected?.startsWith(`${deleteTarget.rel}/`)
        ? null
        : selected,
    );
    setDeleteTarget(null);
    refreshTree();
    // 资料库侧回调：清理该文件的元数据（标题/标签），并让引用守卫重校验
    onDeleted?.(deleteTarget.rel, deleteTarget.isDir);
  };

  // 整棵树在 (rootCwd, expanded, 版本) 三个依赖上 memo：
  // 未变化的已加载子树复用同一批元素引用，React 只 diff 不重建
  const children = useMemo(
    () =>
      rootCwd && isDesktop()
        ? renderEntries(
            rootCwd,
            "",
            expandedSet,
            handleRowContextMenu,
            labelForName,
            onDropPaths || onMoveRow ? dragForFolder : undefined,
            dropDir,
            dragSourceFor,
            draggingRel,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rootCwd,
      expandedSet,
      treeVersion,
      handleRowContextMenu,
      labelForName,
      dragForFolder,
      onDropPaths,
      dropDir,
      dragSourceFor,
      draggingRel,
      onMoveRow,
    ],
  );

  // 根目录空态：listing 已缓存且零条目才显示缺省页。补水中（isDirLoading）
  // 不算空，避免首次进入闪一下缺省页再闪回
  const isEmptyRoot = useMemo(() => {
    if (!rootCwd || !isDesktop()) return false;
    if (isDirLoading(rootCwd, "")) return false;
    const listing = getDir(rootCwd, "");
    return (
      listing !== null && !listing.truncated && listing.entries.length === 0
    );
    // treeVersion 不参与判定，仅驱动重算（缓存补水/失效后重新评估空态）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootCwd, treeVersion]);

  // 右键落点作虚拟锚点（显式 anchor 覆盖 ContextMenu 默认的 Trigger 锚定）
  const menuAnchor = useMemo(
    () =>
      menu
        ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }
        : null,
    [menu],
  );

  if (!isDesktop()) return <ExplorerNotice text={t("library.explorer.desktopOnly")} />;
  if (!rootCwd) return <ExplorerNotice text={pendingText ?? t("library.explorer.preparing")} />;

  return (
    <>
      <div
        className="h-full"
        onContextMenu={(event) => {
          // 行内右键已 stopPropagation，到这里即空白区 → 根目录菜单
          event.preventDefault();
          setMenu({ kind: "root", x: event.clientX, y: event.clientY });
        }}
        onDragOver={onRootDragOver}
        onDrop={onRootDrop}
      >
        {isEmptyRoot ? (
          <TreeEmptyState
            text={emptyText ?? t("library.explorer.empty")}
            onNewFile={() => startNew("new-file", "")}
            onNewFolder={() => startNew("new-folder", "")}
            onNewNote={onNewNote ? () => onNewNote("") : undefined}
            onImport={onImport ? () => onImport("") : undefined}
          />
        ) : (
          <FileTree
            ariaLabel={ariaLabel ?? t("library.explorer.ariaLabel")}
            value={selected}
            onValueChange={handleSelect}
            expandedIds={expanded}
            onExpandedChange={setExpanded}
          >
            {children}
          </FileTree>
        )}
      </div>

      <ContextMenu
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        {menu && menuAnchor ? (
          <ContextMenuContent anchor={menuAnchor} className="min-w-56">
            {menu.kind === "root" ? (
              <>
                <MenuItem onClick={() => startNew("new-file", "")}>
                  {t("library.common.newFile")}
                </MenuItem>
                <MenuItem onClick={() => startNew("new-folder", "")}>
                  {t("library.common.newFolder")}
                </MenuItem>
                {onNewNote && (
                  <MenuItem onClick={() => onNewNote("")}>
                    {t("library.common.newNote")}
                  </MenuItem>
                )}
                {onImport && (
                  <>
                    <ContextMenuSeparator className="bg-border" />
                    <MenuItem onClick={() => onImport("")}>
                      {t("library.explorer.importHere")}
                    </MenuItem>
                  </>
                )}
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => void reveal("")}>
                  {t("library.common.reveal")}
                </MenuItem>
                <MenuItem onClick={refreshTree}>
                  {t("library.common.refresh")}
                </MenuItem>
              </>
            ) : menu.kind === "file" ? (
              <>
                <MenuItem
                  onClick={() =>
                    onOpenFile({ cwd: rootCwd, rel: menu.rel, name: menu.name })
                  }
                >
                  {t("common.action.open")}
                </MenuItem>
                {onReferenceFile && (
                  <MenuItem onClick={() => onReferenceFile(menu.rel, menu.name)}>
                    {t("library.common.reference")}
                  </MenuItem>
                )}
                {fileMenuPrefix?.(menu.rel, menu.name)}
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => void reveal(menu.rel)}>
                  {t("library.explorer.revealInExplorer")}
                </MenuItem>
                <MenuItem onClick={() => void copyPath(menu.rel, true)}>
                  {t("library.explorer.copyPath")}
                </MenuItem>
                <MenuItem onClick={() => void copyPath(menu.rel, false)}>
                  {t("library.explorer.copyRelPath")}
                </MenuItem>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => startRename(menu.rel, menu.name, false)}>
                  {t("library.common.rename")}
                </MenuItem>
                <MenuItem
                  destructive
                  onClick={() =>
                    setDeleteTarget({
                      rel: menu.rel,
                      name: menu.name,
                      isDir: false,
                    })
                  }
                >
                  {t("common.action.delete")}
                </MenuItem>
              </>
            ) : (
              <>
                <MenuItem onClick={() => startNew("new-file", menu.rel)}>
                  {t("library.common.newFile")}
                </MenuItem>
                <MenuItem
                  onClick={() => startNew("new-folder", menu.rel)}
                >
                  {t("library.common.newFolder")}
                </MenuItem>
                {onNewNote && (
                  <MenuItem onClick={() => onNewNote(menu.rel)}>
                    {t("library.common.newNote")}
                  </MenuItem>
                )}
                {onImport && (
                  <MenuItem onClick={() => onImport(menu.rel)}>
                    {t("library.explorer.importHere")}
                  </MenuItem>
                )}
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => void reveal(menu.rel)}>
                  {t("library.explorer.revealInExplorer")}
                </MenuItem>
                <MenuItem onClick={() => void copyPath(menu.rel, true)}>
                  {t("library.explorer.copyPath")}
                </MenuItem>
                <MenuItem onClick={() => void copyPath(menu.rel, false)}>
                  {t("library.explorer.copyRelPath")}
                </MenuItem>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => startRename(menu.rel, menu.name, true)}>
                  {t("library.common.rename")}
                </MenuItem>
                <MenuItem
                  destructive
                  onClick={() =>
                    setDeleteTarget({
                      rel: menu.rel,
                      name: menu.name,
                      isDir: true,
                    })
                  }
                >
                  {t("common.action.delete")}
                </MenuItem>
              </>
            )}
          </ContextMenuContent>
        ) : null}
      </ContextMenu>

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === "rename"
                ? t("library.common.rename")
                : nameDialog?.mode === "new-file"
                  ? t("library.common.newFile")
                  : t("library.common.newFolder")}
            </DialogTitle>
            <DialogDescription>
              {nameDialog?.mode === "rename"
                ? t("library.explorer.renameDesc", { name: nameDialog.name })
                : t("library.explorer.location", {
                    dir: nameDialog?.dir || t("library.explorer.rootDir"),
                  })}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合中：回车是确认候选词，不是提交
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter") void submitNameDialog();
            }}
            placeholder={
              nameDialog?.mode === "new-folder"
                ? t("library.explorer.folderNamePlaceholder")
                : t("library.explorer.fileNamePlaceholder")
            }
            spellCheck={false}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameDialog(null)}>
              {t("common.action.cancel")}
            </Button>
            <Button onClick={() => void submitNameDialog()}>
              {t("common.action.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.explorer.deleteTitle", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isDir
                ? t("library.explorer.deleteDirDesc")
                : t("library.explorer.deleteFileDesc")}
              {deleteTarget && isReferenced?.(deleteTarget.rel, deleteTarget.isDir)
                ? t("library.explorer.deleteReferenced")
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeleteEntry()}>
              {t("common.action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};