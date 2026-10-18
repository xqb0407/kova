"use client";

/**
 * 通用文件树浏览器（agent 面板「文件」标签、资料库页共用）。
 *
 * 单根渲染：一行取值 = 相对 rootCwd 的路径。资料库页上下两段各自挂一个实例
 * （上=用户自己的文件，下=task-workspace 的 AI 产物），两段的展开/选中记忆由
 * stateKey 分区，互不干扰。
 *
 * 树数据 = Rust fs_list_dir 单层懒加载（lib/file-tree store，按 cwd+dir 缓存、
 * 只给已展开目录建节点）；FileTree 内部虚拟滚动，大目录只挂载视口 ±overscan。
 * 右键菜单与对话框（新建文件/文件夹、重命名、删除）在本组件内闭环；写操作走
 * fs.rs 写命令，完成后失效缓存、版本 bump 驱动重拉。
 *
 * 差别化能力都由 props 注入，不在组件里读「当前是谁在用」：
 * - labelForName：行展示名覆盖（AI 产物根层的 UUID 目录显示会话标题）；
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
  CopyIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  ImportIcon,
  NotebookPenIcon,
  PenLineIcon,
  RefreshCwIcon,
  Trash2Icon,
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
} from "@/components/custom-ui/file-tree";
import { filePathOf } from "@/desktop-bridge/core";
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

/** 文件/文件夹命名中不允许的字符（与 fs.rs is_bad_name 同规则） */
const BAD_NAME_RE = /[\\/:*?"<>|]/;

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
  | { mode: "rename"; rel: string; name: string };

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
  /** 根目录空态文案（缺省「此目录暂无文件」） */
  emptyText?: string;
  /** 提供后菜单/空态出现「新建笔记」，在 dir 下建一条 Markdown */
  onNewNote?: (dir: string) => void;
  /** 提供后菜单出现「导入到此处…」，把外部文件拷进 dir */
  onImport?: (dir: string) => void;
  /** 提供后文件夹行成为投放目标：外部文件拖到该行即导入该目录 */
  onDropPaths?: (paths: string[], dir: string) => void;
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
): ReactNode[] {
  const listing = getDir(cwd, rel);
  if (!listing) {
    // 展开的目录补水在途：占位行保住展开反馈（disabled 行不可选中）
    return [
      <FileTreeFile
        key={`${rel}\u0000loading`}
        value={`${rel}\u0000loading`}
        name={isDirLoading(cwd, rel) ? "加载中…" : "（无法读取该目录）"}
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
          className={
            dropDir === child
              ? "ring-primary/40 bg-primary/[0.07] ring-1 ring-inset"
              : undefined
          }
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
      />
    );
  });
  if (listing.truncated) {
    rows.push(
      <FileTreeFile
        key={`${rel}\u0000truncated`}
        value={`${rel}\u0000truncated`}
        name="…（条目过多，已截断）"
        disabled
      />,
    );
  }
  return rows;
}

/** 小空态占位（与面板标签空态同观感） */
const ExplorerNotice: FC<{ text: string }> = ({ text }) => (
  <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
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
}> = ({ text, onNewFile, onNewFolder, onNewNote, onImport }) => (
  // 顶部对齐（不再竖直居中）：资料库页左栏是窄而高的一列，居中的空态会
  // 飘在中间显得空；贴顶更接近浏览器的空目录观感
  <div className="text-muted-foreground/60 flex flex-col items-center gap-3 px-4 py-10 text-center text-xs select-none">
    <FolderOpenIcon className="size-6" />
    <p>{text}</p>
    <div className="flex flex-wrap items-center justify-center gap-2">
      {onNewNote && (
        <Button variant="outline" size="sm" onClick={onNewNote}>
          <NotebookPenIcon />
          新建笔记
        </Button>
      )}
      {onImport && (
        <Button variant="outline" size="sm" onClick={onImport}>
          <ImportIcon />
          导入文件
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onNewFile}>
        <FilePlus2Icon />
        新建文件
      </Button>
      <Button variant="outline" size="sm" onClick={onNewFolder}>
        <FolderPlusIcon />
        新建文件夹
      </Button>
    </div>
    <p className="text-muted-foreground/40">右键空白处可刷新或查看更多操作</p>
  </div>
);

/** 展开/选中状态的模块级记忆槽：使用处重挂载（面板切标签、资料库切段）不丢
 *  展开态；按 stateKey 分区，各使用处互不覆盖（切 rootCwd 时自然重置）。 */
const treeStateCache = new Map<
  string,
  { root: string; expanded: string[]; selected: string | null }
>();

export const FileExplorer: FC<FileExplorerProps> = ({
  rootCwd,
  onOpenFile,
  labelForName,
  fileMenuPrefix,
  emptyText,
  onNewNote,
  onImport,
  onDropPaths,
  stateKey,
  selected: selectedProp,
  onSelectedChange,
  refreshSignal,
  ariaLabel,
  pendingText,
}) => {
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
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  /** 选中写入：受控交给父级，非受控落本地 state（并始终外播） */
  const setSelected = useCallback(
    (rel: string | null) => {
      if (!controlled) setInnerSelected(rel);
      onSelectedChange?.(rel);
    },
    [controlled, onSelectedChange],
  );

  // 切 rootCwd 收起全部展开（旧路径在新根下无意义）。声明序在恢复 effect
  // 之前：rootCwd 首次到位的同一次 commit 里重置先跑、恢复后跑（恢复胜）；
  // 真切根时 restoredRef 已 true，重置是唯一生效路径
  const restoredRef = useRef(false);
  useEffect(() => {
    setExpanded([]);
    setSelected(null);
    setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootCwd]);

  // 记忆恢复（重挂载不丢展开）：无根模式首帧 rootCwd 为 null，等它到位再恢复；
  // restoredRef 保证只恢复一次，之后真正的切根走上方重置逻辑
  useEffect(() => {
    if (!rootCwd || restoredRef.current) return;
    restoredRef.current = true;
    const cached = treeStateCache.get(stateKey);
    if (cached && cached.root === rootCwd && Array.isArray(cached.expanded)) {
      setExpanded(cached.expanded);
      if (cached.selected !== null) setSelected(cached.selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootCwd, stateKey]);

  // 展开/选中写回记忆槽（rootCwd 未到位不写，防空值覆盖好缓存）
  useEffect(() => {
    if (!rootCwd) return;
    treeStateCache.set(stateKey, { root: rootCwd, expanded, selected });
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
   * 文件夹行的拖放目标：悬停高亮 + 落下即导入该目录。
   * 行上 stopPropagation——不让外层（资料库页整区的「落库根」投放）重复处理。
   */
  const dragForFolder = useCallback(
    (dir: string): FileTreeRowDragHandlers | undefined => {
      if (!onDropPaths) return undefined;
      return {
        onDragOver: (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setDropDir((d) => (d === dir ? d : dir));
        },
        onDragLeave: (event) => {
          event.stopPropagation();
          setDropDir((d) => (d === dir ? null : d));
        },
        onDrop: (event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropDir(null);
          const paths = Array.from(event.dataTransfer?.files ?? [])
            .map((f) => filePathOf(f))
            .filter((p): p is string => Boolean(p));
          if (paths.length === 0) {
            toast.error("这些内容没有磁盘路径，无法导入");
            return;
          }
          onDropPaths(paths, dir);
        },
      };
    },
    [onDropPaths],
  );

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
      toast.error("复制失败");
    }
  };

  const startNew = (mode: "new-file" | "new-folder", dir: string) => {
    setNameValue("");
    setNameDialog({ mode, dir });
  };

  const startRename = (rel: string, name: string) => {
    setNameValue(name);
    setNameDialog({ mode: "rename", rel, name });
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
        setSelected(parent ? `${parent}/${name}` : name);
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
            onDropPaths ? dragForFolder : undefined,
            dropDir,
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

  if (!isDesktop()) return <ExplorerNotice text="文件树仅在桌面端可用" />;
  if (!rootCwd) return <ExplorerNotice text={pendingText ?? "正在准备目录…"} />;

  return (
    <>
      <div
        className="h-full"
        onContextMenu={(event) => {
          // 行内右键已 stopPropagation，到这里即空白区 → 根目录菜单
          event.preventDefault();
          setMenu({ kind: "root", x: event.clientX, y: event.clientY });
        }}
      >
        {isEmptyRoot ? (
          <TreeEmptyState
            text={emptyText ?? "此目录暂无文件"}
            onNewFile={() => startNew("new-file", "")}
            onNewFolder={() => startNew("new-folder", "")}
            onNewNote={onNewNote ? () => onNewNote("") : undefined}
            onImport={onImport ? () => onImport("") : undefined}
          />
        ) : (
          <FileTree
            ariaLabel={ariaLabel ?? "文件树"}
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
          <ContextMenuContent anchor={menuAnchor} className="min-w-44">
            {menu.kind === "root" ? (
              <>
                <ContextMenuItem onClick={() => startNew("new-file", "")}>
                  <FilePlus2Icon />
                  新建文件
                </ContextMenuItem>
                <ContextMenuItem onClick={() => startNew("new-folder", "")}>
                  <FolderPlusIcon />
                  新建文件夹
                </ContextMenuItem>
                {onNewNote && (
                  <ContextMenuItem onClick={() => onNewNote("")}>
                    <NotebookPenIcon />
                    新建笔记
                  </ContextMenuItem>
                )}
                {onImport && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => onImport("")}>
                      <ImportIcon />
                      导入到此处…
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void reveal("")}>
                  <FolderSearchIcon />
                  在系统中打开
                </ContextMenuItem>
                <ContextMenuItem onClick={refreshTree}>
                  <RefreshCwIcon />
                  刷新
                </ContextMenuItem>
              </>
            ) : menu.kind === "file" ? (
              <>
                <ContextMenuItem
                  onClick={() =>
                    onOpenFile({ cwd: rootCwd, rel: menu.rel, name: menu.name })
                  }
                >
                  <FileTextIcon />
                  打开
                </ContextMenuItem>
                {fileMenuPrefix?.(menu.rel, menu.name)}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void reveal(menu.rel)}>
                  <FolderSearchIcon />
                  在文件资源管理器中显示
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyPath(menu.rel, true)}>
                  <CopyIcon />
                  复制路径
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyPath(menu.rel, false)}>
                  <CopyIcon />
                  复制相对路径
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => startRename(menu.rel, menu.name)}>
                  <PenLineIcon />
                  重命名
                </ContextMenuItem>
                <ContextMenuItem
                  variant="destructive"
                  onClick={() =>
                    setDeleteTarget({
                      rel: menu.rel,
                      name: menu.name,
                      isDir: false,
                    })
                  }
                >
                  <Trash2Icon />
                  删除
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem onClick={() => startNew("new-file", menu.rel)}>
                  <FilePlus2Icon />
                  新建文件
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => startNew("new-folder", menu.rel)}
                >
                  <FolderPlusIcon />
                  新建文件夹
                </ContextMenuItem>
                {onNewNote && (
                  <ContextMenuItem onClick={() => onNewNote(menu.rel)}>
                    <NotebookPenIcon />
                    新建笔记
                  </ContextMenuItem>
                )}
                {onImport && (
                  <ContextMenuItem onClick={() => onImport(menu.rel)}>
                    <ImportIcon />
                    导入到此处…
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void reveal(menu.rel)}>
                  <FolderSearchIcon />
                  在文件资源管理器中显示
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyPath(menu.rel, true)}>
                  <CopyIcon />
                  复制路径
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyPath(menu.rel, false)}>
                  <CopyIcon />
                  复制相对路径
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => startRename(menu.rel, menu.name)}>
                  <PenLineIcon />
                  重命名
                </ContextMenuItem>
                <ContextMenuItem
                  variant="destructive"
                  onClick={() =>
                    setDeleteTarget({
                      rel: menu.rel,
                      name: menu.name,
                      isDir: true,
                    })
                  }
                >
                  <Trash2Icon />
                  删除
                </ContextMenuItem>
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
                ? "重命名"
                : nameDialog?.mode === "new-file"
                  ? "新建文件"
                  : "新建文件夹"}
            </DialogTitle>
            <DialogDescription>
              {nameDialog?.mode === "rename"
                ? `修改「${nameDialog.name}」的名称`
                : `位置：${nameDialog?.dir || "根目录"}`}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNameDialog();
            }}
            placeholder={
              nameDialog?.mode === "new-folder"
                ? "文件夹名称"
                : "文件名称（如 index.html）"
            }
            spellCheck={false}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameDialog(null)}>
              取消
            </Button>
            <Button onClick={() => void submitNameDialog()}>确定</Button>
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
            <AlertDialogTitle>删除「{deleteTarget?.name ?? ""}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isDir
                ? "该文件夹及其中的全部内容将被永久删除，此操作不可撤销。"
                : "该文件将被永久删除，此操作不可撤销。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteEntry()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};