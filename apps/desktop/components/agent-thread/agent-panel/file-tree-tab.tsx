"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
} from "@/lib/file-tree";
import {
  fsDelete,
  fsErrorText,
  fsMkdir,
  fsRename,
  fsReveal,
  fsTouch,
} from "@/lib/fs";
import { focusPanelTab, openPanelTab } from "@/lib/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { useWorkspace } from "@/lib/workspace-store";
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
 * 「文件」标签（explorer）：workspace 文件树浏览。
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
 * workspace + 相对路径 → file:/// URL（浏览器标签预览本地 HTML/SVG）。
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

export const FileTreeTab: FC = () => {
  const workspace = useWorkspace();
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

  // 切 workspace 收起全部展开（旧路径在新根下无意义）
  useEffect(() => {
    setExpanded([]);
    setSelected(null);
    setMenu(null);
  }, [workspace]);

  // 补水：可见目录链缺缓存就拉（挂载、展开变化、失效 bump 后各收敛一次）
  useEffect(() => {
    if (!workspace || !isTauri()) return;
    for (const dir of collectVisibleDirs(workspace, expandedSet)) {
      ensureDir(workspace, dir);
    }
  }, [workspace, expandedSet, treeVersion]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!workspace) return;
      const idx = value.lastIndexOf("/");
      const parent = idx < 0 ? "" : value.slice(0, idx);
      const name = idx < 0 ? value : value.slice(idx + 1);
      const entry = getDir(workspace, parent)?.entries.find(
        (e) => e.name === name,
      );
      if (!entry || entry.dir) return; // 文件夹只做展开/收起
      setSelected(value);
      // focus:undefined 清掉该标签可能残留的消息快照上下文（复用同标签）
      focusPanelTab("file", {
        cwd: workspace,
        path: value,
        title: name,
        focus: undefined,
      });
    },
    [workspace],
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

  /** 写操作后的公共收尾：失效该 workspace 全部目录缓存，版本 bump 驱动重拉 */
  const refreshTree = useCallback(() => {
    if (workspace) refreshFileTree(workspace);
  }, [workspace]);

  const openFile = (rel: string, name: string) => {
    if (!workspace) return;
    focusPanelTab("file", {
      cwd: workspace,
      path: rel,
      title: name,
      focus: undefined,
    });
  };

  /** 浏览器标签预览：file:// URL 走原生子 webview（browser.rs 放行 file 协议） */
  const previewInBrowser = (rel: string, name: string) => {
    if (!workspace) return;
    openPanelTab("browser", {
      cwd: workspace,
      url: toFileUrl(workspace, rel),
      title: name,
    });
  };

  const reveal = async (rel: string) => {
    if (!workspace) return;
    const err = await fsReveal(workspace, rel);
    if (err) toast.error(fsErrorText(err));
  };

  /** 复制路径（abs=true 绝对路径，按平台分隔符拼接；false 相对路径） */
  const copyPath = async (rel: string, abs: boolean) => {
    if (!workspace) return;
    const sep = workspace.includes("\\") ? "\\" : "/";
    const text = abs
      ? rel
        ? `${workspace}${sep}${rel.split("/").join(sep)}`
        : workspace
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
    if (!nameDialog || !workspace) return;
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
      err = await fsRename(workspace, nameDialog.rel, name);
      if (!err) {
        const idx = nameDialog.rel.lastIndexOf("/");
        const parent = idx < 0 ? "" : nameDialog.rel.slice(0, idx);
        setSelected(parent ? `${parent}/${name}` : name);
      }
    } else {
      const target = nameDialog.dir ? `${nameDialog.dir}/${name}` : name;
      err =
        nameDialog.mode === "new-file"
          ? await fsTouch(workspace, target)
          : await fsMkdir(workspace, target);
    }
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    setNameDialog(null);
    refreshTree();
  };

  const confirmDeleteEntry = async () => {
    if (!deleteTarget || !workspace) return;
    const err = await fsDelete(workspace, deleteTarget.rel);
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

  // 整棵树在 (workspace, expanded, 版本) 三个依赖上 memo：
  // 未变化的已加载子树复用同一批元素引用，React 只 diff 不重建
  const children = useMemo(
    () =>
      workspace && isTauri()
        ? renderEntries(workspace, "", expandedSet, handleRowContextMenu)
        : null,
    [workspace, expandedSet, treeVersion, handleRowContextMenu],
  );

  // 右键落点作虚拟锚点（显式 anchor 覆盖 ContextMenu 默认的 Trigger 锚定）
  const menuAnchor = useMemo(
    () =>
      menu
        ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }
        : null,
    [menu],
  );

  if (!workspace || !isTauri())
    return (
      <TabEmpty
        icon={FolderOpenIcon}
        text={workspace ? "文件树仅在桌面端可用" : "选择工作目录后可浏览文件树"}
      />
    );

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
        <FileTree
          ariaLabel="工作区文件"
          value={selected}
          onValueChange={handleSelect}
          expandedIds={expanded}
          onExpandedChange={setExpanded}
        >
          {children}
        </FileTree>
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
                : `位置：${nameDialog?.dir || "工作区根目录"}`}
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
