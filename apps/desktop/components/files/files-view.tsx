"use client";

import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import {
  CloudIcon,
  CodeIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FileQuestionIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
  Loader2Icon,
  RefreshCwIcon,
  SheetIcon,
  Trash2Icon,
} from "lucide-react";
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
  type AppFileEntry,
  type AppFilePreview,
} from "@/lib/app-files";
import {
  backupDeleteRemote,
  backupDownload,
  backupListRemote,
  formatBackupBytes,
  formatBackupTime,
  useBackupConfig,
  type RemoteBackup,
} from "@/lib/backup-config";
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
 * 本地 = AI 产物目录（无目录任务会话的执行工作目录，Rust app_file_list 只读
 * 列举）；云端 = 复用备份功能已配置的 S3 / WebDAV（backup_list_remote 列远端
 * 备份包，支持下载 / 删除）。
 * 视图：宫格（类型图标预览瓦片）/ 列表（名称 / 上次更新 / 大小），偏好持久化。
 */

/** 一次清单加载的状态机：error 非空即停（不自动重试），刷新按钮清 error 重取 */
type FilesState<T> = { loading: boolean; files: T | null; error: string | null };

type FilesTab = "local" | "cloud";
type ViewMode = "grid" | "list";

/** 宫格/列表共用的行形状（local AppFileEntry 与云端 RemoteBackup 归一） */
type FileRow = {
  name: string;
  dir: boolean;
  size: number;
  modified: string | null;
  encrypted?: boolean;
};

/** 按扩展名挑图标与颜色（无真实缩略图，宫格预览瓦片用它撑场） */
function typeMeta(row: FileRow) {
  if (row.dir) return { icon: FolderIcon, cls: "text-blue-500 dark:text-blue-400" };
  const ext = row.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext))
    return { icon: ImageIcon, cls: "text-emerald-500 dark:text-emerald-400" };
  if (["md", "txt", "pdf", "doc", "docx"].includes(ext))
    return { icon: FileTextIcon, cls: "text-sky-500 dark:text-sky-400" };
  if (["csv", "xlsx", "xls"].includes(ext))
    return { icon: SheetIcon, cls: "text-green-600 dark:text-green-500" };
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "json", "html", "css", "sh", "toml", "yaml", "yml"].includes(ext))
    return { icon: CodeIcon, cls: "text-violet-500 dark:text-violet-400" };
  return { icon: FileIcon, cls: "text-muted-foreground" };
}

const VIEW_MODE_KEY = "files-view-mode";

export const FilesView: FC = () => {
  const [subTab, setSubTab] = useState<FilesTab>("local");
  const [query, setQuery] = useState("");
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

  // ---- 本地：AI 产物目录（首次切到本地页签时拉取） ----
  const [local, setLocal] = useState<FilesState<AppFileEntry[]>>({
    loading: false,
    files: null,
    error: null,
  });
  const loadLocal = () => {
    setLocal((s) => ({ ...s, loading: true }));
    listAppFiles()
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
    if (subTab === "local" && !local.loading && !local.error && local.files === null) {
      loadLocal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, local]);

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
    previewAppFile(row.name)
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
        await deleteAppFile(row.name);
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

  const q = query.trim().toLowerCase();
  const localRows: FileRow[] =
    local.files?.filter((f) => !q || f.name.toLowerCase().includes(q)) ?? [];
  const cloudRows: FileRow[] =
    cloud.files
      ?.filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((b) => ({ name: b.name, dir: false, size: b.size, modified: b.modified, encrypted: b.encrypted })) ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-8 py-8 lg:px-12">
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
          <FilesPane
            state={local}
            rows={localRows}
            query={query}
            onRetry={loadLocal}
            emptyHint="还没有 AI 产生的文件。任务会话里生成或修改的文件会出现在这里。"
            viewMode={viewMode}
            renderMenu={(row) => renderMenu(row, "local")}
          />
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
              {previewRow && (() => {
                const Meta = typeMeta(previewRow).icon;
                return <Meta className={cn("size-4 shrink-0", typeMeta(previewRow).cls)} />;
              })()}
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
              className="mx-auto max-h-[72vh] w-auto rounded-md border object-contain"
            />
          ) : preview?.kind === "html" ? (
            /* HTML：iframe 沙箱渲染成页面（不给 allow-same-origin，脚本可跑
             * 但与宿主同源隔离；srcDoc 下相对资源无法解析，仅自包含页可见） */
            <iframe
              srcDoc={preview.text}
              sandbox="allow-scripts allow-forms allow-popups"
              title={previewRow?.name ?? ""}
              className="h-[72vh] w-full rounded-md border bg-white"
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
 *  文本渐隐片段、其余（含加载失败/超大图）回退类型图标 */
const PreviewTile: FC<{ row: FileRow }> = ({ row }) => {
  const [preview, setPreview] = useState<
    { kind: "image"; url: string } | { kind: "text"; text: string } | null
  >(null);
  const [attempted, setAttempted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (row.dir || attempted) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        previewAppFile(row.name)
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
  const meta = typeMeta(row);
  return <meta.icon className={cn("size-10", meta.cls)} strokeWidth={1.5} />;
};

/** 清单面板：加载 / 错误 / 空 / 宫格 / 列表 五态；行与卡片右键弹 renderMenu，
 *  renderActions 提供时行尾与卡片悬浮出现操作 */
const FilesPane: FC<{
  /** files 只做「已加载与否」判断，元素形状由 rows 承担（local/cloud 归一前不同） */
  state: { loading: boolean; files: unknown; error: string | null };
  rows: FileRow[];
  query: string;
  onRetry: () => void;
  emptyHint: string;
  viewMode: ViewMode;
  renderActions?: (name: string) => ReactNode;
  renderMenu?: (row: FileRow) => ReactNode;
}> = ({ state, rows, query, onRetry, emptyHint, viewMode, renderActions, renderMenu }) => {
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
        const meta = typeMeta(f);
        return (
          <ContextMenu key={f.name}>
            <ContextMenuTrigger
              render={
                <div className="group hover:border-border/80 relative cursor-default overflow-hidden rounded-xl border transition-colors" />
              }
            >
              {/* 预览瓦片：懒加载真预览（图片缩略图 / 文本片段），回退类型图标 */}
              <div className="bg-muted/40 flex h-28 items-center justify-center overflow-hidden border-b">
                <PreviewTile row={f} />
              </div>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <meta.icon className={cn("size-3.5 shrink-0", meta.cls)} />
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
          const meta = typeMeta(f);
          return (
            <ContextMenu key={f.name}>
              <ContextMenuTrigger
                render={
                  <div className="hover:bg-muted/70 grid cursor-default grid-cols-[minmax(0,1fr)_10rem_6rem_auto] items-center gap-3 px-4 py-2.5" />
                }
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <meta.icon className={cn("size-4 shrink-0", meta.cls)} />
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
