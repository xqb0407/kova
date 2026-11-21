"use client";

/**
 * 设置 → 产物：AI 产物（task-workspace）的独立入口。
 *
 * 一级 = 会话卡片网格（对齐参考图 1）：libraryScan({scope:"artifacts"}) 按
 * 顶层目录分组——根层目录即会话产物目录（<task-workspace>/<sessionId>），
 * 标题用 piSessionPrefsMap 的会话名（无记录退目录名）；footer 左 =
 * piSessionCwdMap 的项目目录名（无 cwd = 无目录任务），右 = 「更新于 {date}」。
 * 首张虚线卡 = 打开产物位置（projectReveal，与通用页「任务产物位置」的
 * 打开按钮同用法）。
 *
 * 二级 = 会话详情（对齐参考图 2）：顶栏返回 + 标题 + 本会话搜索 + 在系统中
 * 显示；左栏 FileExplorer（常态）/ SearchList（搜索态），右栏 FileViewer。
 * 键：explorer/搜索结果用会话目录相对 rel，FileViewer cwd = 会话目录（fs
 * 可信根包含 <task-workspace>/<sessionId> 子树）；libraryScan 结果按
 * `<dir>/` 前缀过滤剥壳。根层散文件（无目录直接落盘的少数情况）没有子树，
 * 恒用扁平列表。
 */

import { useEffect, useMemo, useState, type FC } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageIcon,
  RefreshCwIcon,
  SearchXIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useT, getLocale } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import { cn } from "@/lib/utils";
import {
  libraryScan,
  type LibraryScanEntry,
} from "@/lib/workspace/library-files";
import {
  piSessionCwdMap,
  piSessionPrefsMap,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { pathBasename } from "@/lib/workspace/workspace-store";
import { fsErrorText, projectReveal } from "@/lib/workspace/fs";
import { useTaskWorkspaceRoot } from "@/lib/workspace/task-workspace";
import { joinFsPath } from "@/lib/composer/library-reference";
import { FileExplorer } from "@/components/files/file-explorer";
import { FileViewer } from "@/components/files/file-viewer";
import { SearchList } from "@/components/files/search-list";
import { FileManagerIcon } from "@/components/files/file-manager-icon";

/** 一张会话产物卡 */
interface SessionCard {
  /** task-workspace 顶层的目录名（sessionId）；"" = 根层散文件 */
  dir: string;
  title: string;
  count: number;
  modifiedAt: number;
  /** footer 左侧：项目目录名（无 cwd = 任务产物） */
  projectHint: string;
}

/** 日期（不带时间） */
function formatDay(ts: number, locale: string): string {
  return new Date(ts).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export const ArtifactsSettings: FC = () => {
  const t = useT();
  const rootInfo = useTaskWorkspaceRoot();
  const root = rootInfo?.root ?? null;
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  /** 非空 = 进入该会话的详情页 */
  const [detail, setDetail] = useState<{ dir: string; title: string } | null>(
    null,
  );
  const [scan, setScan] = useState<{
    loading: boolean;
    entries: LibraryScanEntry[];
    truncated: boolean;
  }>({ loading: false, entries: [], truncated: false });

  const bump = () => setRefreshSignal((n) => n + 1);

  useEffect(() => {
    if (!isDesktop()) {
      setScan({ loading: false, entries: [], truncated: false });
      return;
    }
    // 任务产物根是异步镜像：首帧还在解析时保持 loading，别闪一下空态
    if (!root) {
      setScan((s) => (s.loading ? s : { ...s, loading: true }));
      return;
    }
    let stale = false;
    setScan((s) => ({ ...s, loading: true }));
    libraryScan({ scope: "artifacts" })
      .then((r) => {
        if (!stale) {
          setScan({ loading: false, entries: r.entries, truncated: r.truncated });
        }
      })
      .catch(() => {
        if (!stale) setScan({ loading: false, entries: [], truncated: false });
      });
    return () => {
      stale = true;
    };
  }, [root, refreshSignal]);

  // 会话标题/项目归属的镜像随快照更新：卡片重算时订阅版本号
  const prefsVersion = useSessionPrefsVersion();
  void prefsVersion;

  const cards = useMemo<SessionCard[]>(() => {
    const byDir = new Map<string, { count: number; modifiedAt: number }>();
    for (const e of scan.entries) {
      const dir = e.rel.includes("/") ? e.rel.slice(0, e.rel.indexOf("/")) : "";
      const at = e.modified ? Date.parse(e.modified) : 0;
      const b = byDir.get(dir) ?? { count: 0, modifiedAt: 0 };
      b.count += 1;
      b.modifiedAt = Math.max(b.modifiedAt, at);
      byDir.set(dir, b);
    }
    return [...byDir.entries()]
      .map(([dir, b]) => {
        const cwd = dir === "" ? null : (piSessionCwdMap.get(dir) ?? null);
        return {
          dir,
          title:
            dir === ""
              ? t("settings.artifacts.rootFiles")
              : (piSessionPrefsMap.get(dir)?.name || dir),
          count: b.count,
          modifiedAt: b.modifiedAt,
          projectHint: cwd
            ? pathBasename(cwd)
            : t("settings.artifacts.taskScoped"),
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }, [scan.entries, prefsVersion, t]);

  const needle = debouncedQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return cards;
    return cards.filter(
      (card) =>
        card.title.toLowerCase().includes(needle) ||
        scan.entries.some(
          (e) =>
            (card.dir
              ? e.rel.startsWith(`${card.dir}/`)
              : !e.rel.includes("/")) && e.name.toLowerCase().includes(needle),
        ),
    );
  }, [cards, needle, scan.entries]);

  const openLocation = async () => {
    if (!root) return;
    const err = await projectReveal(root);
    if (err) toast.error(fsErrorText(err));
  };

  if (!isDesktop()) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-sm text-muted-foreground">
        {t("library.explorer.desktopOnly")}
      </div>
    );
  }

  if (detail) {
    return (
      <ArtifactsDetail
        // key=dir：从一个会话直接切进另一个会话详情时强制重挂载，
        // 否则 selection/搜索词残留上一个会话
        key={detail.dir || "root"}
        dir={detail.dir}
        title={detail.title}
        root={root}
        scanEntries={scan.entries}
        refreshSignal={refreshSignal}
        onRefresh={bump}
        onBack={() => {
          // 返回列表不做重扫：详情里没改内容（只读视图），列表数据仍新鲜
          setDetail(null);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-6 self-center px-8 py-8">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {t("settings.artifacts.title")}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.artifacts.searchPlaceholder")}
              className="h-8 w-44 rounded-md bg-muted/60 text-sm"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              title={t("library.common.refresh")}
              onClick={bump}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
          </div>
        </header>

        {scan.truncated && (
          <p className="text-muted-foreground text-xs">
            {t("settings.artifacts.truncated")}
          </p>
        )}

        {scan.loading && scan.entries.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {t("library.common.searching")}
          </div>
        ) : cards.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed p-10 text-sm">
            <PackageIcon className="size-4" />
            {t("settings.artifacts.empty")}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {/* 打开产物位置（虚线卡，对齐参考图 1 的首张虚线卡） */}
            <button
              type="button"
              onClick={() => void openLocation()}
              className="text-muted-foreground hover:bg-muted/40 hover:text-foreground flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-sm transition-colors"
            >
              <FolderOpenIcon className="size-5" />
              {t("settings.artifacts.openLocation")}
            </button>

            {filtered.map((card) => (
              <button
                key={card.dir || "root"}
                type="button"
                onClick={() => setDetail({ dir: card.dir, title: card.title })}
                className="bg-muted/40 hover:bg-muted/70 flex min-h-36 flex-col justify-between gap-4 rounded-2xl p-5 text-left transition-colors"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="bg-background grid size-9 shrink-0 place-items-center rounded-xl shadow-sm">
                    <PackageIcon className="text-muted-foreground size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{card.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                      {t("settings.artifacts.fileCount", { count: card.count })}
                    </p>
                  </div>
                </div>
                <div className="text-muted-foreground flex items-center justify-between gap-2 text-2xs">
                  <span className="min-w-0 truncate" title={card.projectHint}>
                    {card.projectHint}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {card.modifiedAt
                      ? t("settings.artifacts.updatedAt", {
                          date: formatDay(card.modifiedAt, getLocale()),
                        })
                      : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {!scan.loading && needle && filtered.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed p-10 text-sm">
            <SearchXIcon className="size-4" />
            {t("library.search.noMatch", { query: needle })}
          </div>
        )}
      </div>
    </div>
  );
};

/** 二级页：单个会话的产物列表 + 预览（对齐参考图 2） */
const ArtifactsDetail: FC<{
  dir: string;
  title: string;
  root: string | null;
  /** 一级页已拉到的全量清单（无关键词时根层散文件直接复用，不重扫） */
  scanEntries: LibraryScanEntry[];
  refreshSignal: number;
  onRefresh: () => void;
  onBack: () => void;
}> = ({ dir, title, root, scanEntries, refreshSignal, onRefresh, onBack }) => {
  const t = useT();
  const sessionCwd = root && dir ? joinFsPath(root, dir) : root;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  const dq = debouncedQuery.trim();
  /** 会话相对 rel（viewer/explorer 的键） */
  const [selection, setSelection] = useState<{
    rel: string;
    name: string;
  } | null>(null);
  const [searchEntries, setSearchEntries] = useState<LibraryScanEntry[] | null>(
    null,
  );

  // 会话内搜索：主进程按名字过滤后，剥掉 `<dir>/` 前缀换算成会话相对 rel
  useEffect(() => {
    if (!dq) {
      setSearchEntries(null);
      return;
    }
    let stale = false;
    libraryScan({
      scope: "artifacts",
      query: dq,
      ...(dir ? { under: dir } : {}),
    })
      .then((r) => {
        if (stale) return;
        setSearchEntries(
          r.entries
            .filter((e) =>
              dir ? e.rel.startsWith(`${dir}/`) : !e.rel.includes("/"),
            )
            .map((e) => ({
              ...e,
              rel: dir ? e.rel.slice(dir.length + 1) : e.rel,
            })),
        );
      })
      .catch(() => {
        if (!stale) setSearchEntries([]);
      });
    return () => {
      stale = true;
    };
  }, [dir, dq, refreshSignal]);

  const rootFiles = useMemo(
    () => scanEntries.filter((e) => !e.rel.includes("/")),
    [scanEntries],
  );

  const revealSession = async () => {
    if (!sessionCwd) return;
    const err = await projectReveal(sessionCwd);
    if (err) toast.error(fsErrorText(err));
  };

  // 顶栏动作 portal 进设置页顶栏槽位（settings-page 的 settings-top-actions）：
  // 详情是全高视图，自己再画一条 header 会在设置页 48px 拖拽区下方多出一块
  // 空白带——顶栏只有一条，动作（返回/标题/搜索/显示）全部并入。
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTopSlot(
      document.querySelector<HTMLElement>('[data-slot="settings-top-actions"]'),
    );
  }, []);

  const headerContent = (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={onBack}
        data-drag-region="false"
      >
        <ArrowLeftIcon />
        {t("settings.artifacts.back")}
      </Button>
      <span
        data-drag-region="false"
        className="min-w-0 max-w-60 truncate text-sm font-semibold tracking-tight"
        title={title}
      >
        {title}
      </span>
      <span className="min-w-0 flex-1" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.artifacts.searchInSession")}
        className="h-8 w-44 shrink-0 rounded-md bg-muted/60 text-sm"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title={t("library.common.refresh")}
        onClick={onRefresh}
      >
        <RefreshCwIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={() => void revealSession()}
      >
        <FileManagerIcon className="size-4" />
        {t("settings.artifacts.reveal")}
      </Button>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {topSlot ? createPortal(headerContent, topSlot) : null}

      <div className="border-border/60 flex min-h-0 flex-1 border-t">
        <div
          className={cn(
            "border-border/60 flex w-72 min-h-0 shrink-0 flex-col border-r",
          )}
        >
          {dq || dir === "" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SearchList
                entries={dq ? (searchEntries ?? []) : rootFiles}
                loading={Boolean(dq) && searchEntries === null}
                truncated={false}
                query={dq}
                selected={selection?.rel ?? null}
                emptyText={t("settings.artifacts.empty")}
                onSelect={(e) => setSelection({ rel: e.rel, name: e.name })}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FileExplorer
                rootCwd={sessionCwd}
                onOpenFile={(file) =>
                  setSelection({ rel: file.rel, name: file.name })
                }
                selected={selection?.rel ?? null}
                onSelectedChange={(rel) => {
                  if (rel === null) setSelection(null);
                }}
                stateKey="settings-artifacts"
                refreshSignal={refreshSignal}
                ariaLabel={t("settings.artifacts.treeAria")}
              />
            </div>
          )}
        </div>

        <FileViewer
          className="flex-1"
          cwd={sessionCwd}
          rel={selection?.rel ?? null}
          name={selection?.name ?? ""}
          reloadSignal={refreshSignal}
          onRenamed={
            selection
              ? (newRel, newName) => setSelection({ rel: newRel, name: newName })
              : undefined
          }
        />
      </div>
    </div>
  );
};
