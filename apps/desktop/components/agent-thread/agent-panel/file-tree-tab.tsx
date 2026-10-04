"use client";

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
  EyeIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
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
import {
  activatePanelTab,
  getPanelTabs,
  openPanelTab,
} from "@/lib/panels/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/custom-ui/file-tree";
import { FileTypeIcon } from "./file-type-icon";
import { TabEmpty } from "./tab-empty";

/**
 * 「文件」标签（explorer）：当前工作目录的文件树浏览。
 * 根 = usePanelCwd 三级解析：选了工作区就是工作区；没选（全局会话）落到
 * 该会话按隔离的任务目录 <task-workspace>/<sessionId>，与 agent 实际读写
 * 同源（Rust resolve_root 已放行任务工作区子树，fs_* 读写命令直接可用）。
 * 数据 = Rust fs_list_dir 单层懒加载（lib/file-tree store），只为
 * **已展开**的目录建树节点，未展开子树零渲染成本；展开/选中状态受控。
 * 点击文件 → focusPanelTab("file", { path })：复用「文件」标签渲染
 * 磁盘实时内容（CodeMirror，见 file-view 的磁盘模式）。
 * 右键 → VSCode 式上下文菜单（单例受控 ContextMenu，锚在右键落点）：
 * 文件可打开/浏览器预览（html/htm/svg → browser 标签 file:// URL）/
 * 资源管理器中显示/复制路径/重命名/删除；文件夹可新建文件(夹)/重命名/删除；
 * 空白区 = 根目录菜单（新建文件(夹)/刷新）。写操作走 fs.rs 新命令，
 * 完成后 refreshFileTree 失效缓存，视图靠版本 bump 自动补水。
 * 仅 Tauri 桌面端出现（tab-registry 可见性过滤），web 端不渲染。
 */

const joinRel = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

/** 可用浏览器预览（browser 标签 file:// 加载）的扩展名 */
const PREVIEW_RE = /\.(html?|svg)$/i;

/** 文件/文件夹命名中不允许的字符（与 fs.rs is_bad_name 同规则） */
const BAD_NAME_RE = /[\\/:*?"<>|]/;

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

/**
 * rootCwd + 相对路径 → file:/// URL（浏览器标签预览本地 HTML/SVG）。
 * 逐段 encodeURIComponent，盘符冒号（"D:"）保留。
 */
function toFileUrl(cwd: string, rel: string): string {
  const segs = (p: string) =>
    p
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((s) => encodeURIComponent(s).replace(/%3A/g, ":"));
  return `file:///${[...segs(cwd), ...segs(rel)].join("/")}`;
}

/**
 * 收集"可见且应已缓存"的目录：根 + 沿已加载数据能走到的展开链。
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
          name={e.name}
          onContextMenu={(event) =>
            onRowContextMenu(event, "folder", child, e.name)
          }
        >
          {expanded.has(child)
            ? renderEntries(cwd, child, expanded, onRowContextMenu)
            : null}
        </FileTreeFolder>
      );
    }
    return (
      <FileTreeFile
        key={child}
        value={child}
        name={e.name}
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

/**
 * 树空态缺省页：根目录已加载但没有任何文件/文件夹（如新任务目录）。
 * 快捷动作直接弹既有的新建对话框；空白区右键的根目录菜单仍然可用
 * （外层容器的 onContextMenu 未动）。
 */
const TreeEmptyState: FC<{
  onNewFile: () => void;
  onNewFolder: () => void;
}> = ({ onNewFile, onNewFolder }) => (
  <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs">
    <FolderOpenIcon className="size-6" />
    <p>此目录暂无文件</p>
    <div className="flex items-center gap-2">
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

/** 树 tab 状态的模块级缓存：TabContentView 以 tab.id 作 key 重挂载（tab 切换
 *  即卸载），useState 会丢展开状态——点文件开新 tab 再切回树，之前展开的目录
 *  全部收起。缓存按 cwd 失效，切工作区仍走既有重置逻辑。 */
let explorerTreeCache: {
  cwd: string | null;
  expanded: string[];
  selected: string | null;
} | null = null;

export const FileTreeTab: FC = () => {
  const rootCwd = usePanelCwd();
  useFileTreeWiring();
  const treeVersion = useFileTreeVersion();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /** 右键菜单目标（null = 关闭）：行条目或空白区（根目录） */
  const [menu, setMenu] = useState<TreeMenuTarget | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  // 切 rootCwd 收起全部展开（旧路径在新根下无意义）。声明序在恢复 effect
  // 之前：rootCwd 首次到位的同一次 commit 里重置先跑、恢复后跑（恢复胜）；
  // 真切工作区时 restoredRef 已 true，重置是唯一生效路径
  useEffect(() => {
    setExpanded([]);
    setSelected(null);
    setMenu(null);
  }, [rootCwd]);

  // 树 tab 状态恢复（重挂不丢展开）：TabContentView 以 tab.id 作 key 重挂载，
  // 点文件开新 tab 再切回树时 useState 归零。恢复必须在 rootCwd **到位后**做
  // 而非 useState 惰性初始化——无工作区模式下 cwd 走异步兜底（首帧 null），
  // 惰性初始化比对失败就永远恢复不上了。restoredRef 保证只恢复一次：
  // 之后真正的切工作区仍走上方重置逻辑。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!rootCwd || restoredRef.current) return;
    restoredRef.current = true;
    if (
      explorerTreeCache?.cwd === rootCwd &&
      Array.isArray(explorerTreeCache.expanded)
    ) {
      setExpanded(explorerTreeCache.expanded);
      setSelected(explorerTreeCache.selected);
    }
  }, [rootCwd]);

  // 展开状态写回缓存：tab 切换重挂时恢复（点文件开新 tab 不再收起树）；
  // rootCwd 未到位（null）不写，防空值覆盖好缓存
  useEffect(() => {
    if (!rootCwd) return;
    explorerTreeCache = { cwd: rootCwd, expanded, selected };
  }, [rootCwd, expanded, selected]);

  // 补水：可见目录链缺缓存就拉（挂载、展开变化、失效 bump 后各收敛一次）
  useEffect(() => {
    if (!rootCwd || !isTauri()) return;
    for (const dir of collectVisibleDirs(rootCwd, expandedSet)) {
      ensureDir(rootCwd, dir);
    }
  }, [rootCwd, expandedSet, treeVersion]);

  /** 打开文件标签：同 (cwd, path) 已有标签则聚焦，否则新开——不同文件并存
   *  多标签（此前走 focusPanelTab 按类型复用第一个，每次打开都覆盖同一个） */
  const openFileTabUnique = useCallback(
    (rel: string, name: string) => {
      if (!rootCwd) return;
      const existing = getPanelTabs().tabs.find(
        (t) => t.type === "file" && t.cwd === rootCwd && t.path === rel,
      );
      if (existing) {
        activatePanelTab(existing.id);
        return;
      }
      openPanelTab("file", {
        cwd: rootCwd,
        path: rel,
        title: name,
        focus: undefined,
      });
    },
    [rootCwd],
  );

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
      openFileTabUnique(value, name);
    },
    [rootCwd, openFileTabUnique],
  );

  const handleRowContextMenu = useCallback<RowContextMenuHandler>(
    (event, kind, rel, name) => {
      event.preventDefault();
      event.stopPropagation();
      setSelected(rel);
      setMenu({ kind, rel, name, x: event.clientX, y: event.clientY });
    },
    [],
  );

  /** 写操作后的公共收尾：失效该 rootCwd 全部目录缓存，版本 bump 驱动重拉 */
  const refreshTree = useCallback(() => {
    if (rootCwd) refreshFileTree(rootCwd);
  }, [rootCwd]);

  const openFile = (rel: string, name: string) => {
    openFileTabUnique(rel, name);
  };

  /** 浏览器标签预览：file:// URL 走原生子 webview（browser.rs 放行 file 协议） */
  const previewInBrowser = (rel: string, name: string) => {
    if (!rootCwd) return;
    openPanelTab("browser", {
      cwd: rootCwd,
      url: toFileUrl(rootCwd, rel),
      title: name,
    });
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
    setSelected((prev) =>
      prev === deleteTarget.rel || prev?.startsWith(`${deleteTarget.rel}/`)
        ? null
        : prev,
    );
    setDeleteTarget(null);
    refreshTree();
  };

  // 整棵树在 (rootCwd, expanded, 版本) 三个依赖上 memo：
  // 未变化的已加载子树复用同一批元素引用，React 只 diff 不重建
  const children = useMemo(
    () =>
      rootCwd && isTauri()
        ? renderEntries(rootCwd, "", expandedSet, handleRowContextMenu)
        : null,
    [rootCwd, expandedSet, treeVersion, handleRowContextMenu],
  );

  // 根目录空态：listing 已缓存且零条目才显示缺省页。补水中（isDirLoading）
  // 不算空，避免首次进面板闪一下缺省页再闪回
  const isEmptyRoot = useMemo(() => {
    if (!rootCwd || !isTauri()) return false;
    if (isDirLoading(rootCwd, "")) return false;
    const listing = getDir(rootCwd, "");
    return (
      listing !== null &&
      !listing.truncated &&
      listing.entries.length === 0
    );
    // treeVersion 不参与判定，仅驱动重算（缓存补水/失效后重新评估空态）
  }, [rootCwd, treeVersion]);

  // 右键落点作虚拟锚点（显式 anchor 覆盖 ContextMenu 默认的 Trigger 锚定）
  const menuAnchor = useMemo(
    () =>
      menu
        ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }
        : null,
    [menu],
  );

  if (!isTauri())
    return <TabEmpty icon={FolderOpenIcon} text="文件树仅在桌面端可用" />;
  // 面板根目录异步解析（appDataDir / 会话物化）中，只闪现一瞬
  if (!rootCwd) return <TabEmpty icon={FolderOpenIcon} text="正在准备任务目录…" />;

  return (
    <>
      <div
        className="h-full overflow-y-auto p-1.5"
        onContextMenu={(event) => {
          // 行内右键已 stopPropagation，到这里即空白区 → 根目录菜单
          event.preventDefault();
          setMenu({ kind: "root", x: event.clientX, y: event.clientY });
        }}
      >
        {isEmptyRoot ? (
          <TreeEmptyState
            onNewFile={() => startNew("new-file", "")}
            onNewFolder={() => startNew("new-folder", "")}
          />
        ) : (
          <FileTree
            ariaLabel="工作区文件"
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
                <ContextMenuSeparator />
                <ContextMenuItem onClick={refreshTree}>
                  <RefreshCwIcon />
                  刷新
                </ContextMenuItem>
              </>
            ) : menu.kind === "file" ? (
              <>
                <ContextMenuItem onClick={() => openFile(menu.rel, menu.name)}>
                  <FileTextIcon />
                  打开
                </ContextMenuItem>
                {PREVIEW_RE.test(menu.name) ? (
                  <ContextMenuItem
                    onClick={() => previewInBrowser(menu.rel, menu.name)}
                  >
                    <EyeIcon />
                    浏览器预览
                  </ContextMenuItem>
                ) : null}
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
