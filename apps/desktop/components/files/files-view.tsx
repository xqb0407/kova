"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  FileQuestionIcon,
  FolderIcon,
  FolderOpenIcon,
  LayoutGridIcon,
  ListIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from "lucide-react";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/custom-ui/segmented";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  deleteAppFile,
  listAppFiles,
  previewAppFile,
  revealAppFile,
  type AppFileEntry,
  type AppFilePreview,
} from "@/lib/workspace/app-files";
import {
  backupDeleteRemote,
  backupDownload,
  backupListRemote,
  formatBackupBytes,
  formatBackupTime,
  useBackupConfig,
  type RemoteBackup,
} from "@/lib/settings/backup-config";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/**
 * 我的文件（侧边栏「我的文件」主区视图）。
 * 本地 = AI 产物目录（无目录任务会话的执行工作目录，Rust app_file_list 列举，
 * 目录可点击逐层下钻，面包屑回跳）；云端 = 复用备份功能已配置的 S3 / WebDAV
 * （backup_list_remote 列远端备份包，支持下载 / 删除）。
 * 视图：宫格（类型图标预览瓦片）/ 列表（名称 / 上次更新 / 大小），偏好持久化。
 */

/** 一次清单加载的状态机：error 非空即停（不自动重试），刷新按钮清 error 重取 */
type FilesState<T> = { loading: boolean; files: T | null; error: string | null };

type FilesTab = "local" | "cloud";
type ViewMode = "grid" | "list";

/** 宫格/列表共用的行形状（local AppFileEntry 与云端 RemoteBackup 归一）；
 *  rel 仅本地行有值：相对 task-workspace 根的下钻路径（预览/删除用） */
type FileRow = {
  name: string;
  dir: boolean;
  size: number;
  modified: string | null;
  encrypted?: boolean;
  rel?: string;
};

/** 行/卡片/弹窗标题图标：目录用蓝色文件夹；文件走 material-file-icons
 *  （VS Code 同款彩色图标，按文件名/扩展名查表，未知类型回退默认文档图标） */
const RowIcon: FC<{
  row: FileRow;
  className?: string;
  /** 仅目录的 lucide 图标生效（material 图标是填充 SVG，无描边概念） */
  strokeWidth?: number;
}> = ({ row, className, strokeWidth }) =>
  row.dir ? (
    <FolderIcon
      strokeWidth={strokeWidth}
      className={cn("shrink-0 text-blue-500 dark:text-blue-400", className)}
    />
  ) : (
    <FileTypeIcon path={row.name} className={className} />
  );

const VIEW_MODE_KEY = "files-view-mode";

/** 走 Markdown 渲染预览的扩展名（Rust 侧按 text 返回内容，前端按名路由） */
const MARKDOWN_RE = /\.(md|markdown)$/i;

/** 走 CodeMirror 语法高亮预览的代码扩展名（与 fs.rs TEXT_EXTS 对齐，
 *  不含 md/txt/csv/log——分别归 Markdown 与纯文本） */
const CODE_EXTS = new Set([
  "json", "ts", "tsx", "js", "jsx", "py", "rs", "go", "css", "sh", "toml",
  "yaml", "yml", "xml",
]);

const extOf = (name: string) =>
  name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export const FilesView: FC = () => {
  const [subTab, setSubTab] = useState<FilesTab>("local");
  const [query, setQuery] = useState("");
  // 搜索防抖：输入框即时回显，过滤只吃延迟值（连续击键折叠为最后一次）
  const debouncedQuery = useDebouncedValue(query, 200);
  // 视图偏好持久化（宫格 / 列表）
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "grid";
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const switchView = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {}
  };

  // ---- 本地：AI 产物目录（下钻浏览；进入本地页签/切换目录时拉取） ----
  const [local, setLocal] = useState<FilesState<AppFileEntry[]>>({
    loading: false,
    files: null,
    error: null,
  });
  /** 当前所在目录，相对 task-workspace 根（"" = 根），POSIX 分隔 */
  const [currentDir, setCurrentDir] = useState("");
  const loadLocal = () => {
    setLocal((s) => ({ ...s, loading: true }));
    listAppFiles(currentDir)
      .then((files) => setLocal({ loading: false, files, error: null }))
      .catch((err) =>
        setLocal({
          loading: false,
          files: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  };
  useEffect(() => {
    if (subTab === "local") loadLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, currentDir]);

  /** 进入子目录 / 经面包屑跳转（换目录即清旧清单，避免闪现上一层内容） */
  const navigateDir = (dir: string) => {
    setCurrentDir(dir);
    setLocal({ loading: true, files: null, error: null });
  };

  // ---- 云端：复用备份功能的存储配置（S3 / WebDAV） ----
  const backupCfg = useBackupConfig();
  const cloudReady = backupCfg.provider !== "off";
  const [cloud, setCloud] = useState<FilesState<RemoteBackup[]>>({
    loading: false,
    files: null,
    error: null,
  });
  const loadCloud = () => {
    setCloud((s) => ({ ...s, loading: true }));
    backupListRemote()
      .then((files) => setCloud({ loading: false, files, error: null }))
      .catch((err) =>
        setCloud({
          loading: false,
          files: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  };
  useEffect(() => {
    if (subTab === "cloud" && cloudReady && !cloud.loading && !cloud.error && cloud.files === null) {
      loadCloud();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, cloudReady, cloud]);

  // ---- 文件动作：下载 / 预览 / 删除（删除一律 AlertDialog 确认） ----
  const [busyName, setBusyName] = useState<string | null>(null);
  /** 待删除条目（带来源，确认后按来源走本地/云端删除） */
  const [deleteTarget, setDeleteTarget] = useState<{ row: FileRow; source: FilesTab } | null>(null);
  /** 预览 Dialog：目标行 + 拉取到的内容 */
  const [previewRow, setPreviewRow] = useState<FileRow | null>(null);
  const [preview, setPreview] = useState<AppFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const doDownload = async (name: string) => {
    try {
      const path = await saveDialog({ title: "下载文件", defaultPath: name });
      if (!path) return;
      setBusyName(name);
      await backupDownload(name, path);
      toast.success(`已下载到 ${path}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyName(null);
    }
  };

  const openPreview = (row: FileRow) => {
    setPreview(null);
    setPreviewLoading(true);
    setPreviewRow(row);
    previewAppFile(row.rel ?? row.name)
      .then(setPreview)
      .catch((e) => {
        setPreviewRow(null);
        toast.error(`预览失败：${String(e)}`);
      })
      .finally(() => setPreviewLoading(false));
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    const { row, source } = deleteTarget;
    setBusyName(row.name);
    try {
      if (source === "local") {
        await deleteAppFile(row.rel ?? row.name);
        loadLocal();
        toast.success(`已删除 ${row.name}`);
      } else {
        const msg = await backupDeleteRemote(row.name);
        setCloud((s) => ({ ...s, files: s.files?.filter((b) => b.name !== row.name) ?? null }));
        toast.success(msg);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyName(null);
      setDeleteTarget(null);
    }
  };

  /** 在系统文件管理器中打开/显示（目录打开该目录，文件选中显示）；失败轻提示 */
  const doReveal = async (row: FileRow) => {
    try {
      await revealAppFile(row.rel ?? row.name);
    } catch (e) {
      toast.error(`打开失败：${String(e)}`);
    }
  };

  /** 复制条目的磁盘绝对路径（task-workspace 根 + rel，按平台分隔符拼接，
   *  与工作区文件树 copyPath 同款写法） */
  const copyPath = async (row: FileRow) => {
    const root = await taskWorkspaceDir();
    if (!root) {
      toast.error("复制失败");
      return;
    }
    const sep = root.includes("\\") ? "\\" : "/";
    const text = row.rel
      ? `${root}${sep}${row.rel.split("/").join(sep)}`
      : root;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制路径");
    } catch {
      toast.error("复制失败");
    }
  };

  /** 右键菜单（grid 卡片 / list 行共用；按来源给不同动作） */
  const renderMenu = (row: FileRow, source: FilesTab): ReactNode => (
    <ContextMenuContent>
      {source === "local" ? (
        <ContextMenuItem disabled={row.dir} onClick={() => openPreview(row)}>
          <EyeIcon className="size-4" />
          预览
        </ContextMenuItem>
      ) : (
        <ContextMenuItem disabled={busyName !== null} onClick={() => void doDownload(row.name)}>
          <DownloadIcon className="size-4" />
          下载到本地
        </ContextMenuItem>
      )}
      {source === "local" && (
        <>
          <ContextMenuItem onClick={() => void doReveal(row)}>
            {row.dir ? <FolderOpenIcon className="size-4" /> : <SquareArrowOutUpRightIcon className="size-4" />}
            {row.dir ? "在系统中打开" : "在系统中显示"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyPath(row)}>
            <CopyIcon className="size-4" />
            复制路径
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        disabled={busyName !== null}
        onClick={() => setDeleteTarget({ row, source })}
      >
        <Trash2Icon className="size-4" />
        删除…
      </ContextMenuItem>
    </ContextMenuContent>
  );

  /** 云端行内悬浮按钮（保留快捷下载；删除同样走 AlertDialog） */
  const cloudActions = (name: string): ReactNode => (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void doDownload(name)}
        disabled={busyName !== null}
        title="下载到本地"
      >
        <DownloadIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive size-7"
        onClick={() => {
          const row = cloudRows.find((r) => r.name === name);
          if (row) setDeleteTarget({ row, source: "cloud" });
        }}
        disabled={busyName !== null}
        title="从云端删除"
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );

  const q = debouncedQuery.trim().toLowerCase();
  const localRows: FileRow[] =
    local.files
      ?.map((f) => ({ ...f, rel: currentDir ? `${currentDir}/${f.name}` : f.name }))
      .filter((f) => !q || f.name.toLowerCase().includes(q)) ?? [];
  const cloudRows: FileRow[] =
    cloud.files
      ?.filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((b) => ({ name: b.name, dir: false, size: b.size, modified: b.modified, encrypted: b.encrypted })) ?? [];

  return (
    <div className="h-full overflow-y-auto">
      {/* min-h-full 而非 h-full：h-full 固定高度会让 flex 在内容超高时压缩子项；
          列表容器自带 overflow-hidden（最小收缩尺寸按 0 算）会被直接压扁裁掉，
          外层永远无滚动条。min-h-full 短内容仍撑满、长内容自然溢出可滚 */}
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-8 lg:px-12">
        {/* 页头 */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">我的文件</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            本地为 AI 产生的文件（任务会话的工作目录）；云端为已配置存储里的备份文件。
          </p>
        </div>

        {/* 子分段器（本地 / 云端）+ 搜索 + 视图切换 */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <Segmented
            value={subTab}
            onChange={setSubTab}
            options={[
              { value: "local", label: "本地" },
              { value: "cloud", label: "云端" },
            ]}
          />
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件…"
              className="h-8 w-56 rounded-md border-none bg-muted/60 text-sm"
            />
            <div className="bg-muted/60 flex items-center gap-0.5 rounded-lg p-0.5">
              {(
                [
                  { value: "grid", label: "宫格视图", icon: LayoutGridIcon },
                  { value: "list", label: "列表视图", icon: ListIcon },
                ] as const
              ).map((v) => (
                <button
                  key={v.value}
                  onClick={() => switchView(v.value)}
                  title={v.label}
                  className={cn(
                    "grid size-7 place-items-center rounded-md transition-colors",
                    viewMode === v.value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <v.icon className="size-4" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 本地 */}
        {subTab === "local" ? (
          <>
            {/* 面包屑（非根目录时显示）：根「我的文件」+ 逐级目录，均可点回跳 */}
            {currentDir && (
              <nav className="mt-4 flex min-w-0 items-center gap-1 text-sm">
                <button
                  onClick={() => navigateDir("")}
                  className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                >
                  我的文件
                </button>
                {currentDir.split("/").map((part, i, parts) => {
                  const last = i === parts.length - 1;
                  return (
                    <span key={i} className="flex min-w-0 items-center gap-1">
                      <ChevronRightIcon className="text-muted-foreground/50 size-3.5 shrink-0" />
                      {last ? (
                        <span className="text-foreground truncate font-medium">{part}</span>
                      ) : (
                        <button
                          onClick={() => navigateDir(parts.slice(0, i + 1).join("/"))}
                          className="text-muted-foreground hover:text-foreground truncate transition-colors"
                        >
                          {part}
                        </button>
                      )}
                    </span>
                  );
                })}
              </nav>
            )}
            <FilesPane
              state={local}
              rows={localRows}
              query={query}
              onRetry={loadLocal}
              emptyHint={
                currentDir
                  ? "这个文件夹是空的。"
                  : "还没有 AI 产生的文件。任务会话里生成或修改的文件会出现在这里。"
              }
              viewMode={viewMode}
              onOpenDir={(name) => navigateDir(currentDir ? `${currentDir}/${name}` : name)}
              onOpenFile={openPreview}
              renderMenu={(row) => renderMenu(row, "local")}
            />
          </>
        ) : !cloudReady ? (
          /* 云端未配置：引导去备份设置 */
          <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl py-16 text-center">
            <CloudIcon className="text-muted-foreground/60 size-8" />
            <p className="text-sm font-medium">尚未配置云端存储</p>
            <p className="text-muted-foreground text-sm">
              在 设置 → 偏好 → 备份 中配置 S3 / WebDAV 后，这里会显示云端备份文件。
            </p>
          </div>
        ) : (
          /* 云端列表（行尾带下载 / 删除操作） */
          <FilesPane
            state={cloud}
            rows={cloudRows}
            query={query}
            onRetry={loadCloud}
            emptyHint="云端还没有备份文件。可在 设置 → 偏好 → 备份 中立即备份。"
            viewMode={viewMode}
            renderActions={cloudActions}
            renderMenu={(row) => renderMenu(row, "cloud")}
          />
        )}
      </div>

      {/* 预览 Dialog（本地文件：图片全显 / 文本滚动 / 不支持回退） */}
      <Dialog open={previewRow !== null} onOpenChange={(o) => !o && setPreviewRow(null)}>
        <DialogContent className="w-[min(90vw,72rem)] max-w-[90vw] sm:max-w-[72rem]">
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2">
              {previewRow && <RowIcon row={previewRow} className="size-4" />}
              <span className="truncate">{previewRow?.name}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">文件预览</DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              加载中…
            </div>
          ) : preview?.kind === "image" ? (
            <img
              src={`data:${preview.mime};base64,${preview.data}`}
              alt={previewRow?.name ?? ""}
              className="mx-auto max-h-[72vh] w-auto rounded-md  object-contain"
            />
          ) : preview?.kind === "html" ? (
            /* HTML：iframe 沙箱渲染成页面（不给 allow-same-origin，脚本可跑
             * 但与宿主同源隔离；srcDoc 下相对资源无法解析，仅自包含页可见） */
            <iframe
              srcDoc={preview.text}
              sandbox="allow-scripts allow-forms allow-popups"
              title={previewRow?.name ?? ""}
              className="h-[72vh] w-full rounded-md  bg-white"
            />
          ) : preview?.kind === "text" && previewRow && MARKDOWN_RE.test(previewRow.name) ? (
            /* Markdown：复用消息区渲染（frontmatter 卡片/表格/任务列表/mermaid），
             * 外层限高滚动（渲染结果任意高不撑破弹窗） */
            <div className="aui-markdown max-h-[72vh] overflow-y-auto rounded-md  p-5">
              <MarkdownText text={preview.text} />
            </div>
          ) : preview?.kind === "text" && previewRow && CODE_EXTS.has(extOf(previewRow.name)) ? (
            /* 代码：CodeMirror 只读视图（语法高亮/行号/主题跟「外观 → 代码设置」），
             * height 让编辑器内部滚动（行号 sticky 跟随），pre 的整页滚动会带跑行号 */
            <CodeMirrorCode
              value={preview.text}
              path={previewRow.name}
              height="72vh"
              className="rounded-md border"
            />
          ) : preview?.kind === "text" ? (
            <pre className="bg-muted/50 max-h-[72vh] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              {preview.text}
            </pre>
          ) : (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
              <FileQuestionIcon className="size-8" />
              该文件类型暂不支持预览
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认（本地 / 云端共用；本地为不可恢复操作） */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteTarget?.row.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.source === "local"
                ? deleteTarget.row.dir
                  ? "目录及其全部内容将被永久删除，此操作不可恢复。"
                  : "文件将被永久删除，此操作不可恢复。"
                : "将从云端存储中删除该备份文件。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyName !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busyName !== null}
              onClick={(e) => {
                e.preventDefault(); // 阻止 Radix 默认关闭：删除完成后再收
                void doDelete();
              }}
            >
              {busyName !== null ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

/** 宫格预览瓦片：目录恒图标；文件进入视口后懒加载——图片 data URL、
 *  文本渐隐片段、其余（含加载失败/超大图）回退类型图标（仅本地行有 rel，
 *  云端行直接回退图标） */
const PreviewTile: FC<{ row: FileRow }> = ({ row }) => {
  const [preview, setPreview] = useState<
    { kind: "image"; url: string } | { kind: "text"; text: string } | null
  >(null);
  const [attempted, setAttempted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (row.dir || attempted || !row.rel) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        previewAppFile(row.rel!)
          .then((p) => {
            if (p.kind === "image") {
              setPreview({ kind: "image", url: `data:${p.mime};base64,${p.data}` });
            } else if (p.kind === "text") {
              setPreview({ kind: "text", text: p.text });
            } else if (p.kind === "html") {
              // 瓦片里 HTML 按文本片段展示（iframe 渲染只在预览 Dialog 做）
              setPreview({ kind: "text", text: p.text });
            }
          })
          .catch(() => {})
          .finally(() => setAttempted(true));
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [row.dir, row.name, attempted]);

  if (preview?.kind === "image") {
    return (
      <img
        src={preview.url}
        alt=""
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  if (preview?.kind === "text") {
    return (
      <pre className="text-muted-foreground/80 h-full w-full overflow-hidden p-3 text-left font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
        {preview.text.slice(0, 600)}
      </pre>
    );
  }
  return <RowIcon row={row} className="size-10" strokeWidth={1.5} />;
};

/** 清单面板：加载 / 错误 / 空 / 宫格 / 列表 五态；行与卡片右键弹 renderMenu，
 *  renderActions 提供时行尾与卡片悬浮出现操作；onOpenDir 提供时目录卡片 /
 *  目录行可点击进入（下钻），onOpenFile 提供时文件可单击预览（右键菜单保留） */
const FilesPane: FC<{
  /** files 只做「已加载与否」判断，元素形状由 rows 承担（local/cloud 归一前不同） */
  state: { loading: boolean; files: unknown; error: string | null };
  rows: FileRow[];
  query: string;
  onRetry: () => void;
  emptyHint: string;
  viewMode: ViewMode;
  onOpenDir?: (name: string) => void;
  onOpenFile?: (row: FileRow) => void;
  renderActions?: (name: string) => ReactNode;
  renderMenu?: (row: FileRow) => ReactNode;
}> = ({
  state,
  rows,
  query,
  onRetry,
  emptyHint,
  viewMode,
  onOpenDir,
  onOpenFile,
  renderActions,
  renderMenu,
}) => {
  /** 单击行/卡片：目录进入，文件预览；能力未给（如云端文件）则不可点 */
  const openRow = (f: FileRow) => {
    if (f.dir) onOpenDir?.(f.name);
    else onOpenFile?.(f);
  };
  const rowClickable = (f: FileRow) => Boolean(f.dir ? onOpenDir : onOpenFile);
  if (state.loading && state.files === null) {
    return (
      <div className="text-muted-foreground mt-4 px-1 text-sm">加载中…</div>
    );
  }
  if (state.error) {
    return (
      <div className="mt-4 flex items-center justify-between gap-3 px-1 text-sm">
        <span className="text-muted-foreground min-w-0 break-words">读取失败：{state.error}</span>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onRetry}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground mt-4 px-1 text-sm">
        {query.trim() ? `没有匹配「${query.trim()}」的文件。` : emptyHint}
      </div>
    );
  }
  return viewMode === "grid" ? (
    <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
      {rows.map((f) => {
        return (
          <ContextMenu key={f.name}>
            <ContextMenuTrigger
              render={
                <div
                  onClick={rowClickable(f) ? () => openRow(f) : undefined}
                  className={cn(
                    "group hover:border-border/80 relative overflow-hidden rounded-xl border transition-colors",
                    rowClickable(f) ? "cursor-pointer" : "cursor-default",
                  )}
                />
              }
            >
              {/* 预览瓦片：懒加载真预览（图片缩略图 / 文本片段），回退类型图标 */}
              <div className="bg-muted/40 flex h-28 items-center justify-center overflow-hidden border-b">
                <PreviewTile row={f} />
              </div>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <RowIcon row={f} className="size-3.5" />
                    <span className="truncate text-sm font-medium">{f.name}</span>
                    {f.encrypted && (
                      <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none">
                        已加密
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                    {f.modified ? formatBackupTime(f.modified) : ""}
                    {!f.dir && f.size > 0 ? ` · ${formatBackupBytes(f.size)}` : ""}
                  </div>
                </div>
              </div>
              {renderActions && (
                <div className="absolute right-2 bottom-2 opacity-0 transition-opacity group-hover:opacity-100">
                  {renderActions(f.name)}
                </div>
              )}
            </ContextMenuTrigger>
            {renderMenu?.(f)}
          </ContextMenu>
        );
      })}
    </div>
  ) : (
    <div className="mt-4 overflow-hidden rounded-xl border">
      {/* 表头：名称 / 上次更新 / 大小（+操作列占位） */}
      <div className="text-muted-foreground bg-muted/50 grid grid-cols-[minmax(0,1fr)_10rem_6rem_auto] gap-3 border-b px-4 py-2 text-xs">
        <span>名称</span>
        <span>上次更新</span>
        <span className="text-right">大小</span>
        <span className="w-16" />
      </div>
      <div className="divide-y">
        {rows.map((f) => {
          return (
            <ContextMenu key={f.name}>
              <ContextMenuTrigger
                render={
                  <div
                    onClick={rowClickable(f) ? () => openRow(f) : undefined}
                    className={cn(
                      "hover:bg-muted/70 grid grid-cols-[minmax(0,1fr)_10rem_6rem_auto] items-center gap-3 px-4 py-2.5",
                      rowClickable(f) ? "cursor-pointer" : "cursor-default",
                    )}
                  />
                }
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <RowIcon row={f} className="size-4" />
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  {f.encrypted && (
                    <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none">
                      已加密
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {f.modified ? formatBackupTime(f.modified) : ""}
                </span>
                <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">
                  {f.dir ? "—" : formatBackupBytes(f.size)}
                </span>
                <div className="w-16 justify-self-end">
                  {renderActions?.(f.name)}
                </div>
              </ContextMenuTrigger>
              {renderMenu?.(f)}
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
};
