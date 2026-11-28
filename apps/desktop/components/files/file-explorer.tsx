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
 * - onNewNote / onImport / onDropPaths：资料库的建笔记/导入/拖放（只挂主树的实例）；
 * - multiSelect：开启 Cmd/Ctrl 切换与 Shift 区间多选，以及批量删除/复制路径/
 *   拖拽移动（右侧文件树、资料库、设置产物均开启）。
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
import { NoteIconGlyph } from "./note-icon-glyph";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  type FileTreeRowDragHandlers,
  type FileTreeRowDragSource,
  type FileTreeSelectionMeta,
} from "@/components/custom-ui/file-tree";
import { filePathOf } from "@/desktop-bridge/core";
import {
  parseTreeDragPayload,
  serializeTreeDragPayload,
  topLevelTargets,
} from "@/lib/workspace/file-tree-selection";
import { cn } from "@/lib/utils";
import { t, useT } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
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
  /**
   * 「在新标签页中打开」/ 双击（VS Code 语义：单击预览、双击转常驻）。
   * 不传则菜单不出现该项、双击等同单击（资料库等无标签场景）。
   */
  onOpenFilePermanent?: (file: ExplorerFileRef) => void;
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
  /**
   * 只显示 git 变更：给 rootCwd 相对路径集合；null/undefined = 不过滤。
   * 树的祖先目录会临时强制展开并补水，过滤只作用于已加载条目；已删除的
   * 文件在盘上不存在，不会出现在树里（空结果用 filterEmptyText 说明）。
   */
  changedPaths?: ReadonlySet<string> | null;
  /** 变更过滤下没有可显示文件时的空态文案 */
  filterEmptyText?: string;
  /** 笔记页面图标（空间相对 rel → icon 值）：命中时行图标用它覆盖通用文件图标 */
  noteIconFor?: (rel: string) => string | undefined;
  /** 提供后菜单/空态出现「新建笔记」，在 dir 下建一条 Markdown */
  onNewNote?: (dir: string) => void;
  /** 提供后菜单出现「导入到此处…」，把外部文件拷进 dir */
  onImport?: (dir: string) => void;
  /** 提供后文件夹行成为投放目标：外部文件拖到该行即导入该目录 */
  onDropPaths?: (paths: string[], dir: string) => void;
  /** 提供后行可拖动（树内移动）：拖到文件夹行 / 空白区落进该目录或根。
   *  返回 true 表示确实移动了；返回 { moved, name } 时用 name 更新多选 rel
   *  （重名自动加序号后选区能跟上）。失败/原位返回 false 或 moved:false */
  onMoveRow?: (
    srcRel: string,
    destDir: string,
    /** batch=true：一次拖多个（父级不要逐个改写自己的“当前文件”，
     *  否则会把多选收敛成最后移动的那一项） */
    meta?: { batch: boolean },
  ) => boolean | Promise<boolean | { moved: boolean; name?: string }>;
  /** 开启 VS Code 式多选（Cmd/Ctrl 切换、Shift 区间、批量删除/拖拽） */
  multiSelect?: boolean;
  /** 展开/选中记忆槽（"panel" / "library" / "artifacts" 各一份） */
  stateKey: string;
  /** 受控选中（资料库用来高亮右栏正在看的文件）；不给则组件自管 */
  selected?: string | null;
  onSelectedChange?: (rel: string | null) => void;
  /** 批量移动后活动项换了路径：让右栏跟随新文件，但不走“点击打开”语义 */
  onPrimaryChange?: (file: ExplorerFileRef) => void;
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
  draggingRels?: ReadonlySet<string>,
  visiblePaths?: ReadonlySet<string> | null,
  noteIconFor?: (rel: string) => string | undefined,
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
  const entries = visiblePaths
    ? listing.entries.filter((e) => visiblePaths.has(joinRel(rel, e.name)))
    : listing.entries;
  const rows = entries.map((e) => {
    const child = joinRel(rel, e.name);
    // 笔记页面图标命中时覆盖通用文件图标（目录行不参与）
    const noteIcon = e.dir ? undefined : noteIconFor?.(child);
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
            draggingRels?.has(child) && "opacity-40",
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
                draggingRels,
                visiblePaths,
                noteIconFor,
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
        icon={
          noteIcon ? (
            <NoteIconGlyph
              icon={noteIcon}
              className="size-4 shrink-0 text-sm"
            />
          ) : (
            <FileTypeIcon path={e.name} />
          )
        }
        onContextMenu={(event) => onRowContextMenu(event, "file", child, e.name)}
        dragSource={dragSourceFor?.(child)}
        className={cn(draggingRels?.has(child) && "opacity-50")}
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
  onOpenFilePermanent,
  labelForName,
  fileMenuPrefix,
  onReferenceFile,
  onDeleted,
  onRenamed,
  isReferenced,
  emptyText,
  changedPaths,
  filterEmptyText,
  noteIconFor,
  onNewNote,
  onImport,
  onDropPaths,
  onMoveRow,
  multiSelect,
  stateKey,
  selected: selectedProp,
  onSelectedChange,
  onPrimaryChange,
  refreshSignal,
  ariaLabel,
  pendingText,
}) => {
  const t = useT();
  useFileTreeWiring();
  const treeVersion = useFileTreeVersion();
  const controlled = selectedProp !== undefined;
  const multiple = multiSelect === true;
  const [innerSelected, setInnerSelected] = useState<string | null>(null);
  const selected = controlled ? selectedProp! : innerSelected;
  /** 多选事实源：菜单/批量操作/拖拽都读它；单选模式保持空表 */
  const [selectedRels, setSelectedRels] = useState<string[]>(() =>
    multiple && selectedProp ? [selectedProp] : [],
  );
  /** 事件回调读最新选区，但不把选区放进 children memo 依赖（大树避免每次
   *  Cmd/Shift 选择都重建整棵声明树；行高亮由 FileTree 自己按 selectedValues 走） */
  const selectionRef = useRef(selectedRels);
  selectionRef.current = selectedRels;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [expanded, setExpanded] = useState<string[]>([]);
  /** 右键菜单目标（null = 关闭）：行条目或空白区（根目录） */
  const [menu, setMenu] = useState<TreeMenuTarget | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<DeleteTarget[] | null>(null);
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
  /** 正在被拖动的一组行（多选拖拽时淡化全部源行） */
  const [draggingRels, setDraggingRels] = useState<string[]>([]);
  const draggingSet = useMemo(() => new Set(draggingRels), [draggingRels]);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  // 变更过滤：把每个变更路径自身与全部祖先目录做成匹配集合（目录只在含有
  // 变更时保留）；同时把祖先目录并入展开集合，让懒加载的深层文件直接可见。
  // 用户收起某个强制展开的目录时，过滤期间会被这里加回去——过滤态下保持
  // 「变更路径完整可见」优先，关掉过滤即恢复用户自己的展开态。
  const changedFilter = useMemo(() => {
    if (!changedPaths) return null;
    /** match：路径本身 + 全部祖先（过滤行用）；dirs：只含祖先目录（展开用，
     *  不把文件路径塞进 expand 状态，避免用户展开操作把文件名写回记忆槽） */
    const match = new Set<string>();
    const dirs = new Set<string>();
    for (const raw of changedPaths) {
      const rel = raw
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (!rel || rel === "." || rel.startsWith("../") || rel.startsWith("/")) {
        continue;
      }
      const parts = rel.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) {
        const prefix = parts.slice(0, i).join("/");
        match.add(prefix);
        if (i < parts.length) dirs.add(prefix);
      }
    }
    return { match, dirs };
  }, [changedPaths]);
  const changedPrefixes = changedFilter?.match ?? null;
  const viewExpandedSet = useMemo(
    () =>
      changedFilter
        ? new Set([...expandedSet, ...changedFilter.dirs])
        : expandedSet,
    [expandedSet, changedFilter],
  );
  const viewExpanded = useMemo(
    () => (changedPrefixes ? [...viewExpandedSet] : expanded),
    [changedPrefixes, viewExpandedSet, expanded],
  );
  /** 展开态写回：过滤期间不能把「被强制展开的祖先目录」写进用户记忆槽，
   *  只落用户真正新展开的目录（forced 之外的）与用户主动收起的目录，这样
   *  关掉过滤后树会回到用户原来的展开态。 */
  const handleExpandedChange = useCallback(
    (next: string[]) => {
      if (!changedFilter) {
        setExpanded(next);
        return;
      }
      const nextSet = new Set(next);
      setExpanded((prev) => {
        const merged = new Set(prev);
        for (const id of [...merged]) {
          if (!nextSet.has(id)) merged.delete(id);
        }
        for (const id of nextSet) {
          if (!merged.has(id) && !changedFilter.dirs.has(id)) merged.add(id);
        }
        return [...merged];
      });
    },
    [changedFilter],
  );

  /** 选中写入：受控交给父级，非受控落本地 state（并始终外播） */
  const setSelected = useCallback(
    (rel: string | null) => {
      if (!controlled) setInnerSelected(rel);
      onSelectedChange?.(rel);
    },
    [controlled, onSelectedChange],
  );

  /** 多选写入：选区 + 主项（active）一起更新；active="" 表示清空主项 */
  const setSelection = useCallback(
    (rels: string[], active?: string) => {
      // 内容相同（如受控主项回写、重复点同一行）不换数组，省一次整棵树 diff
      setSelectedRels((prev) =>
        prev.length === rels.length && prev.every((rel, i) => rel === rels[i])
          ? prev
          : rels,
      );
      const primary =
        active !== undefined ? (active || null) : (rels.at(-1) ?? null);
      setSelected(primary);
    },
    [setSelected],
  );

  // 受控主项（FileRail activePath / 资料库右栏）变化且变成某个具体文件时，
  // 多选收敛到它；变成 null（标签关闭/文件被删）时保留多选，交给调用方决定
  // 右栏空态——否则批量删除活动文件时会把其余选中的文件也一起清掉。
  // 若新主项本来就在多选里（批量移动后右栏跟随新路径），保留整个选区。
  const lastControlledSelected = useRef(selected);
  useEffect(() => {
    if (!controlled || !multiple) return;
    if (lastControlledSelected.current === selected) return;
    lastControlledSelected.current = selected;
    if (!selected) return;
    if (selectionRef.current.includes(selected)) return;
    setSelectedRels([selected]);
  }, [controlled, multiple, selected]);

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
    setSelectedRels(
      controlled
        ? selectedProp
          ? [selectedProp]
          : []
        : nextSelected
          ? [nextSelected]
          : [],
    );
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
    for (const dir of collectVisibleDirs(rootCwd, viewExpandedSet)) {
      ensureDir(rootCwd, dir);
    }
  }, [rootCwd, viewExpandedSet, treeVersion]);

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

  /** 行 value（rel）→ 文件引用；文件夹/未加载条目返回 null */
  const fileRefOf = useCallback(
    (value: string): ExplorerFileRef | null => {
      if (!rootCwd) return null;
      const idx = value.lastIndexOf("/");
      const parent = idx < 0 ? "" : value.slice(0, idx);
      const name = idx < 0 ? value : value.slice(idx + 1);
      const entry = getDir(rootCwd, parent)?.entries.find(
        (e) => e.name === name,
      );
      if (!entry || entry.dir) return null;
      return { cwd: rootCwd, rel: value, name };
    },
    [rootCwd],
  );

  /** 行 value → 批量操作元数据（文件或目录；缓存缺失时按文件名兜底） */
  const entryOfRel = useCallback(
    (rel: string): DeleteTarget => {
      const idx = rel.lastIndexOf("/");
      const parent = idx < 0 ? "" : rel.slice(0, idx);
      const name = idx < 0 ? rel : rel.slice(idx + 1);
      const entry = rootCwd
        ? getDir(rootCwd, parent)?.entries.find((e) => e.name === name)
        : undefined;
      return { rel, name: entry?.name ?? name, isDir: entry?.dir ?? false };
    },
    [rootCwd],
  );

  const handleSelect = useCallback(
    (value: string) => {
      const file = fileRefOf(value);
      if (!file) return; // 文件夹只做展开/收起
      setSelected(value);
      onOpenFile(file);
    },
    [fileRefOf, onOpenFile, setSelected],
  );

  /** 多选模式普通单击：FileTree 已更新选区，这里只负责打开文件语义 */
  const handleSelectMulti = useCallback(
    (value: string) => {
      const file = fileRefOf(value);
      if (!file) return;
      setSelected(value);
      onOpenFile(file);
    },
    [fileRefOf, onOpenFile, setSelected],
  );

  /** 稳定回调：FileTree 内部 commitSelection / 折叠剪枝 effect 依赖它 */
  const handleSelectedValuesChange = useCallback(
    (values: string[], meta: FileTreeSelectionMeta) =>
      setSelection(values, meta.active),
    [setSelection],
  );

  /** 双击：转常驻（VS Code 语义）。未提供该能力（资料库等）时等同单击 */
  const handleDoubleClick = useCallback(
    (value: string) => {
      if (!onOpenFilePermanent) return;
      const file = fileRefOf(value);
      if (!file) return;
      onOpenFilePermanent(file);
    },
    [fileRefOf, onOpenFilePermanent],
  );

  const handleRowContextMenu = useCallback<RowContextMenuHandler>(
    (event, kind, rel, name) => {
      event.preventDefault();
      event.stopPropagation();
      if (!multiple) {
        setSelected(rel);
      } else if (!selectionRef.current.includes(rel)) {
        // 右键未选中行 → 只选它；右键已选行 → 保留整个多选
        setSelection([rel], rel);
      }
      setMenu({ kind, rel, name, x: event.clientX, y: event.clientY });
    },
    [multiple, setSelected, setSelection],
  );

  /** 批量移动：顶层归一化 → 顺序 onMoveRow → 选区跟随新 rel → 一次刷新 */
  const moveRows = useCallback(
    async (srcRels: string[], destDir: string): Promise<boolean> => {
      if (!onMoveRow) return false;
      const targets = topLevelTargets(srcRels);
      // 多选拖拽（哪怕祖先归一化后只剩一个目标）都算批量：父级不要逐个
      // 改写自己的“当前文件”，选区由本组件统一重映射
      const batch = multiple && selectionRef.current.length > 1;
      let moved = 0;
      let failed = 0;
      const mapping = new Map<string, string>();
      const movedDirs = new Set<string>();
      for (const src of targets) {
        if (destDir === src || destDir.startsWith(`${src}/`)) {
          failed += 1;
          continue;
        }
        const srcIsDir = entryOfRel(src).isDir;
        const result = await onMoveRow(src, destDir, { batch });
        const normalized = typeof result === "boolean" ? { moved: result } : result;
        if (!normalized.moved) continue; // 原地不动不算失败
        moved += 1;
        const fallbackName = src.slice(src.lastIndexOf("/") + 1);
        const nextRel = joinRel(destDir, normalized.name || fallbackName);
        mapping.set(src, nextRel);
        if (srcIsDir) movedDirs.add(nextRel);
      }
      if (moved > 0) {
        const currentSelection = selectionRef.current;
        const primarySelected = selectedRef.current;
        if (multiple && currentSelection.length > 0) {
          const remap = (rel: string): string => {
            for (const [from, to] of mapping) {
              if (rel === from) return to;
              if (rel.startsWith(`${from}/`)) return `${to}${rel.slice(from.length)}`;
            }
            return rel;
          };
          const next = currentSelection.map(remap);
          const remappedPrimary = primarySelected ? remap(primarySelected) : null;
          const active =
            remappedPrimary && next.includes(remappedPrimary)
              ? remappedPrimary
              : (next.at(-1) ?? null);
          setSelection(next, active ?? "");
          // 右栏按新路径续看。目标目录可能还没补进缓存，不能走 fileRefOf
          // 查询（会返回 null 静默丢掉回调）；路径由 remap 直接构造。
          if (active && rootCwd) {
            const activeIsDir =
              movedDirs.has(active) || entryOfRel(active).isDir;
            if (!activeIsDir) {
              onPrimaryChange?.({
                cwd: rootCwd,
                rel: active,
                name: active.slice(active.lastIndexOf("/") + 1),
              });
            }
          }
        }
        refreshTree();
      }
      if (failed > 0) {
        toast.warning(
          t("library.explorer.movePartial", { ok: moved, failed }),
        );
      }
      return moved > 0;
    },
    [
      onMoveRow,
      multiple,
      setSelection,
      refreshTree,
      t,
      rootCwd,
      entryOfRel,
      onPrimaryChange,
    ],
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
            const raw = event.dataTransfer.getData(TREE_DRAG_MIME);
            const srcs = parseTreeDragPayload(raw);
            if (srcs.length > 0) {
              setDraggingRels([]);
              // 落下即展开目标目录：移动后的新 rel 仍可见，选区不会因折叠被清
              setExpanded((prev) =>
                prev.includes(dir) ? prev : [...prev, dir],
              );
              void moveRows(srcs, dir);
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
    [onDropPaths, onMoveRow, moveRows, expandedSet, cancelHoverExpand, t],
  );

  /** 行作为拖拽源（树内移动）；拖动已选行时带上整个选区（顶层归一化） */
  const dragSourceFor = useCallback(
    (rel: string): FileTreeRowDragSource | undefined => {
      if (!onMoveRow) return undefined;
      return {
        onDragStart: (event) => {
          const current = selectionRef.current;
          const dragsSelection = multiple && current.includes(rel);
          const targets = dragsSelection ? topLevelTargets(current) : [rel];
          if (!dragsSelection && multiple) setSelection([rel], rel);
          event.stopPropagation();
          event.dataTransfer.setData(
            TREE_DRAG_MIME,
            serializeTreeDragPayload(targets),
          );
          event.dataTransfer.effectAllowed = "move";
          setDraggingRels(
            dragsSelection && multiple ? current : targets,
          );
        },
        onDragEnd: () => {
          setDraggingRels([]);
          cancelHoverExpand();
        },
      };
    },
    [onMoveRow, multiple, setSelection, cancelHoverExpand],
  );

  /**
   * 树的空白区：接住树内拖动 → 移到该树的根；外部文件（DataTransfer.files）
   * 在提供了 onDropPaths 时落到根目录（文件夹行同理，行上 stopPropagation
   * 后冒不到这里）。外部文件刻意不给视觉：与"落根是显式拖拽动作"的既有
   * 口径一致，落点由导入结果与选中反馈。
   */
  const onRootDragOver = (event: React.DragEvent) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    const isInternal = types.includes(TREE_DRAG_MIME);
    if (isInternal) {
      if (!onMoveRow) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      return;
    }
    if (!onDropPaths || !types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };
  const onRootDrop = (event: React.DragEvent) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    const isInternal = types.includes(TREE_DRAG_MIME);
    if (isInternal) {
      if (!onMoveRow) return;
      event.preventDefault();
      event.stopPropagation();
      setDropDir(null);
      cancelHoverExpand();
      const raw = event.dataTransfer.getData(TREE_DRAG_MIME);
      const srcs = parseTreeDragPayload(raw);
      if (srcs.length > 0) {
        setDraggingRels([]);
        void moveRows(srcs, "");
      }
      return;
    }
    if (!onDropPaths) return;
    event.preventDefault();
    event.stopPropagation();
    setDropDir(null);
    cancelHoverExpand();
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map((f) => filePathOf(f))
      .filter((p): p is string => Boolean(p));
    if (paths.length === 0) {
      toast.error(t("library.common.noDiskPath"));
      return;
    }
    onDropPaths(paths, "");
  };

  const reveal = async (rel: string) => {
    if (!rootCwd) return;
    const err = await fsReveal(rootCwd, rel);
    if (err) toast.error(fsErrorText(err));
  };

  /** 复制路径（abs=true 绝对路径，按平台分隔符拼接；false 相对路径）。
   *  多选用换行拼接，顺序沿用选区（可见行顺序）。 */
  const copyPaths = async (rels: readonly string[], abs: boolean) => {
    if (!rootCwd || rels.length === 0) return;
    const sep = rootCwd.includes("\\") ? "\\" : "/";
    const text = rels
      .map((rel) =>
        abs
          ? rel
            ? `${rootCwd}${sep}${rel.split("/").join(sep)}`
            : rootCwd
          : rel,
      )
      .join("\n");
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
        if (multiple) setSelection([newRel], newRel);
        else setSelected(newRel);
        onRenamed?.(nameDialog.rel, newRel, name, nameDialog.isDir);
      }
    } else {
      const target = nameDialog.dir ? `${nameDialog.dir}/${name}` : name;
      err =
        nameDialog.mode === "new-file"
          ? await fsTouch(rootCwd, target)
          : await fsMkdir(rootCwd, target);
      // 新建文件即打开（VS Code 语义）：面板开预览标签、资料库右栏选中，
      // 用户不用再去树里把刚建的文件找出来
      if (!err && nameDialog.mode === "new-file") {
        onOpenFile({ cwd: rootCwd, rel: target, name });
      }
    }
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    setNameDialog(null);
    refreshTree();
  };

  const confirmDeleteEntries = async () => {
    if (!deleteTargets?.length || !rootCwd) return;
    const byRel = new Map(deleteTargets.map((target) => [target.rel, target]));
    const targets = topLevelTargets(deleteTargets.map((target) => target.rel));
    let ok = 0;
    let failed = 0;
    let firstError: string | null = null;
    const removed: string[] = [];
    for (const rel of targets) {
      const err = await fsDelete(rootCwd, rel);
      if (err) {
        failed += 1;
        firstError ??= err;
        continue;
      }
      ok += 1;
      removed.push(rel);
    }
    // 回调统一放到循环后：批量删除时父级（资料库）会逐个清元数据并 bump
    // 刷新信号，同一 tick 内发出可被 React 合批，避免 N 次整页重渲染
    for (const rel of removed) {
      onDeleted?.(rel, byRel.get(rel)?.isDir ?? false);
    }
    if (removed.length > 0) {
      if (multiple) {
        const gone = (rel: string) =>
          removed.some((del) => rel === del || rel.startsWith(`${del}/`));
        const remaining = selectedRels.filter((rel) => !gone(rel));
        const primaryGone = Boolean(selected && gone(selected));
        const primary =
          selected && remaining.includes(selected)
            ? selected
            : (remaining.at(-1) ?? null);
        setSelection(remaining, primary ?? "");
        // 活动文件被删：通知受控父级清空右栏；选区仍保留其余项
        if (primaryGone) setSelected(null);
      } else {
        // 单选（资料库/产物）：只清掉被删文件；右栏看着别的文件时不能跟着清空
        const deleted = removed[0]!;
        setSelected(
          selected === deleted || selected?.startsWith(`${deleted}/`)
            ? null
            : selected,
        );
      }
      refreshTree();
    }
    setDeleteTargets(null);
    if (failed === 0) {
      // 单项删除保持原来的静默成功；批量才给汇总提示
      if (deleteTargets.length > 1) {
        toast.success(t("library.explorer.deleteManyDone", { count: ok }));
      }
    } else if (ok > 0) {
      toast.warning(
        t("library.explorer.deletePartial", { ok, failed }),
      );
    } else if (deleteTargets.length === 1 && firstError) {
      toast.error(fsErrorText(firstError));
    } else {
      toast.error(t("library.explorer.deleteManyFailed"));
    }
  };

  // 整棵树在 (rootCwd, expanded, 版本) 三个依赖上 memo：
  // 未变化的已加载子树复用同一批元素引用，React 只 diff 不重建
  const children = useMemo(
    () =>
      rootCwd && isDesktop()
        ? renderEntries(
            rootCwd,
            "",
            viewExpandedSet,
            handleRowContextMenu,
            labelForName,
            onDropPaths || onMoveRow ? dragForFolder : undefined,
            dropDir,
            dragSourceFor,
            draggingSet,
            changedPrefixes,
            noteIconFor,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rootCwd,
      viewExpandedSet,
      changedPrefixes,
      treeVersion,
      handleRowContextMenu,
      labelForName,
      noteIconFor,
      dragForFolder,
      onDropPaths,
      dropDir,
      dragSourceFor,
      draggingSet,
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

  // 变更过滤后根层一个可显示条目都没有：集合为空，或变更都在盘上不存在
  // （删除/整目录删除），树会空成一片，需要给专门的空态而不是空白。
  const isFilterEmpty = useMemo(() => {
    if (!changedPrefixes) return false;
    if (changedPrefixes.size === 0) return true;
    if (!rootCwd || !isDesktop()) return false;
    if (isDirLoading(rootCwd, "")) return false;
    const listing = getDir(rootCwd, "");
    if (!listing) return false;
    return !listing.entries.some((e) => changedPrefixes.has(joinRel("", e.name)));
    // treeVersion 驱动缓存补水后重新评估
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedPrefixes, rootCwd, treeVersion]);

  // 右键落点作虚拟锚点（显式 anchor 覆盖 ContextMenu 默认的 Trigger 锚定）
  const menuAnchor = useMemo(
    () =>
      menu
        ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }
        : null,
    [menu],
  );

  // 多选菜单：右键行属于多选且选区 >1 时，目标按祖先归一化（父目录覆盖子项）
  const menuMultiTargets = useMemo(() => {
    if (!multiple || !menu || menu.kind === "root") return null;
    if (selectedRels.length <= 1 || !selectedRels.includes(menu.rel)) return null;
    return topLevelTargets(selectedRels);
  }, [multiple, menu, selectedRels]);

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
        {isFilterEmpty ? (
          <ExplorerNotice
            text={filterEmptyText ?? "当前没有可显示的变更文件"}
          />
        ) : isEmptyRoot ? (
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
            selectionMode={multiple ? "multiple" : undefined}
            selectedValues={multiple ? selectedRels : undefined}
            onSelectedValuesChange={
              multiple ? handleSelectedValuesChange : undefined
            }
            value={multiple ? undefined : selected}
            onValueChange={multiple ? handleSelectMulti : handleSelect}
            onItemDoubleClick={onOpenFilePermanent ? handleDoubleClick : undefined}
            expandedIds={viewExpanded}
            onExpandedChange={handleExpandedChange}
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
            {menuMultiTargets ? (
              <ContextMenuGroup>
                <ContextMenuLabel className="text-muted-foreground px-3 py-1.5 text-xs">
                  {t("library.explorer.selectionCount", {
                    count: selectedRels.length,
                  })}
                </ContextMenuLabel>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => void copyPaths(menuMultiTargets, true)}>
                  {t("library.explorer.copyPaths")}
                </MenuItem>
                <MenuItem onClick={() => void copyPaths(menuMultiTargets, false)}>
                  {t("library.explorer.copyRelPaths")}
                </MenuItem>
                <MenuItem onClick={() => void reveal(menuMultiTargets[0]!)}>
                  {t("library.explorer.revealInExplorer")}
                </MenuItem>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem
                  destructive
                  onClick={() =>
                    setDeleteTargets(menuMultiTargets.map(entryOfRel))
                  }
                >
                  {t("library.explorer.deleteMany", {
                    count: menuMultiTargets.length,
                  })}
                </MenuItem>
              </ContextMenuGroup>
            ) : menu.kind === "root" ? (
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
                {onOpenFilePermanent && (
                  <MenuItem
                    onClick={() =>
                      onOpenFilePermanent({
                        cwd: rootCwd,
                        rel: menu.rel,
                        name: menu.name,
                      })
                    }
                  >
                    {t("library.explorer.openInNewTab")}
                  </MenuItem>
                )}
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
                <MenuItem onClick={() => void copyPaths([menu.rel], true)}>
                  {t("library.explorer.copyPath")}
                </MenuItem>
                <MenuItem onClick={() => void copyPaths([menu.rel], false)}>
                  {t("library.explorer.copyRelPath")}
                </MenuItem>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => startRename(menu.rel, menu.name, false)}>
                  {t("library.common.rename")}
                </MenuItem>
                <MenuItem
                  destructive
                  onClick={() =>
                    setDeleteTargets([
                      { rel: menu.rel, name: menu.name, isDir: false },
                    ])
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
                <MenuItem onClick={() => void copyPaths([menu.rel], true)}>
                  {t("library.explorer.copyPath")}
                </MenuItem>
                <MenuItem onClick={() => void copyPaths([menu.rel], false)}>
                  {t("library.explorer.copyRelPath")}
                </MenuItem>
                <ContextMenuSeparator className="bg-border" />
                <MenuItem onClick={() => startRename(menu.rel, menu.name, true)}>
                  {t("library.common.rename")}
                </MenuItem>
                <MenuItem
                  destructive
                  onClick={() =>
                    setDeleteTargets([
                      { rel: menu.rel, name: menu.name, isDir: true },
                    ])
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
        open={deleteTargets !== null && deleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTargets?.length === 1
                ? t("library.explorer.deleteTitle", {
                    name: deleteTargets[0]?.name ?? "",
                  })
                : t("library.explorer.deleteManyTitle", {
                    count: deleteTargets?.length ?? 0,
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargets?.length === 1
                ? deleteTargets[0]?.isDir
                  ? t("library.explorer.deleteDirDesc")
                  : t("library.explorer.deleteFileDesc")
                : t("library.explorer.deleteManyDesc", {
                    count: deleteTargets?.length ?? 0,
                  })}
              {deleteTargets?.some((target) =>
                isReferenced?.(target.rel, target.isDir),
              )
                ? t("library.explorer.deleteReferenced")
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDeleteEntries()}
            >
              {t("common.action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};