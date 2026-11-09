"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isDesktop } from "@/lib/desktop-env";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace/workspace-store";
import {
  deleteMemoryTrash,
  emptyMemoryTrash,
  listMemoryFiles,
  listMemoryTrash,
  readMemoryEntry,
  restoreMemoryTrash,
  saveMemoryConfig,
  trashMemoryEntry,
  useMemoryConfig,
  writeMemoryEntry,
  type MemoryConfig,
} from "@/lib/memory/memory";
import type {
  PiMemoryFileEntry,
  PiMemoryScopeState,
  PiMemoryTrashEntry,
} from "@/lib/pi/pi-bridge";
import { getLocale, useT } from "@/lib/i18n";

/* 重依赖（CodeMirror / Streamdown）走异步分块：点开才拉取，不进设置页首屏包 */
const MarkdownEditDialog = dynamic(() => import("./markdown-edit-dialog"), {
  ssr: false,
  loading: () => null,
});
const MemoryHistoryDialog = dynamic(() => import("./memory-history-dialog"), {
  ssr: false,
  loading: () => null,
});

type SaveState = "saved" | "pending" | "error";

type ScopeTab = "global" | "workspace";

/** 工作区目录切换器（与子智能体页同款）：候选 = 手动浏览 + 当前工作区 + 最近使用。
 *  只切换本页查看哪个工作区的记忆目录，不改动主界面的工作区选择。 */
const WorkspaceCwdMenu: FC<{
  value: string | null;
  following: boolean;
  followLabel: string | null;
  candidates: string[];
  showBrowse: boolean;
  onChange: (dir: string) => void;
  onFollowCurrent: () => void;
  onBrowse: () => void;
}> = ({
  value,
  following,
  followLabel,
  candidates,
  showBrowse,
  onChange,
  onFollowCurrent,
  onBrowse,
}) => {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={value ?? undefined}
            className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] leading-5 transition-colors"
          >
            <FolderOpenIcon className="size-3.5 shrink-0" />
            <span className="max-w-44 truncate">
              {value ? pathBasename(value) : t("settings.memory.noWorkspaceSelected")}
            </span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-72">
        {candidates.map((dir) => (
          <DropdownMenuCheckboxItem
            key={dir}
            checked={dir === value}
            onCheckedChange={(checked) => {
              if (checked) onChange(dir);
            }}
            title={dir}
          >
            <span className="truncate">{pathBasename(dir)}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {candidates.length === 0 && (
          <div className="text-muted-foreground px-2 py-3 text-center text-[13px] leading-5">
            {t("settings.memory.noRecent")}
          </div>
        )}
        {!following && followLabel && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onFollowCurrent}>
              {t("settings.memory.followCurrent", { name: followLabel })}
            </DropdownMenuItem>
          </>
        )}
        {showBrowse && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onBrowse}>
              <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
              {t("settings.memory.browseOther")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const formatTime = (ms: number): string => {
  if (!ms) return "";
  return new Intl.DateTimeFormat(getLocale() === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
};

/** 单作用域记忆文件浏览器：工具行（作用域段选/工作区切换/计数/搜索/刷新）+ 文件列表 + 点开预览编辑 */
const MemoryFileBrowser: FC<{
  scopeTab: ScopeTab;
  onScopeTabChange: (tab: ScopeTab) => void;
  workspaceCwd: string | null;
  scopeState: PiMemoryScopeState | null;
  files: PiMemoryFileEntry[];
  dailyHint: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** 总开关（空态文案区分：关闭时 AI 不会写入，别再提示"让 AI 写入第一条"） */
  memoryEnabled: boolean;
  fileOn: (name: string) => boolean;
  onToggleFile: (name: string, on: boolean) => void;
  onOpenFile: (name: string) => void;
  openingFile: string | null;
  /** 打开版本历史 / 移入回收站（行内动作，按钮各自 stopPropagation 不触发行点击） */
  onOpenHistory: (name: string) => void;
  onDeleteFile: (name: string) => void;
  /** 行内操作进行中的文件名（禁用按钮防连点） */
  rowBusy: string | null;
  // 工作区目录切换（仅工作区页签显示）：查看来源可与主界面当前工作区解耦
  following: boolean;
  followLabel: string | null;
  cwdCandidates: string[];
  onSwitchCwd: (dir: string) => void;
  onFollowCurrent: () => void;
  onBrowse: () => void;
}> = (props) => {
  const {
    scopeTab,
    onScopeTabChange,
    workspaceCwd,
    scopeState,
    files,
    dailyHint,
    query,
    onQueryChange,
    onRefresh,
    refreshing,
    memoryEnabled,
    fileOn,
    onToggleFile,
    onOpenFile,
    openingFile,
    onOpenHistory,
    onDeleteFile,
    rowBusy,
    following,
    followLabel,
    cwdCandidates,
    onSwitchCwd,
    onFollowCurrent,
    onBrowse,
  } = props;

  const t = useT();
  const workspaceUnavailable = scopeTab === "workspace" && !scopeState;

  return (
    <section className="flex flex-col gap-3">
      {/* 工具行：作用域段选 + 工作区切换 + 计数 + 搜索 + 刷新 */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={scopeTab}
          onValueChange={(v) => onScopeTabChange(v as ScopeTab)}
        >
          <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
            <TabsTrigger value="global" className="rounded-full px-3 py-1 text-sm">
              {t("settings.memory.global")}
            </TabsTrigger>
            <TabsTrigger value="workspace" className="rounded-full px-3 py-1 text-sm">
              {t("settings.memory.workspace")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {scopeTab === "workspace" && (
          <WorkspaceCwdMenu
            value={workspaceCwd}
            following={following}
            followLabel={followLabel}
            candidates={cwdCandidates}
            showBrowse={isDesktop()}
            onChange={onSwitchCwd}
            onFollowCurrent={onFollowCurrent}
            onBrowse={onBrowse}
          />
        )}
        <span className="text-muted-foreground text-sm leading-relaxed">
          {t("settings.memory.fileCount", { count: files.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="h-9 w-56 bg-background"
            placeholder={t("settings.memory.searchPlaceholder")}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={t("settings.memory.refresh")}
          >
            <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {scopeTab === "workspace" && scopeState && (
        <div className="flex items-center gap-1">
          <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground truncate font-mono text-[13px] leading-5">{scopeState.dir}</span>
        </div>
      )}

      {/* 文件列表 */}
      <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        {workspaceUnavailable ? (
          <div className="text-muted-foreground px-3 py-3 text-sm">
            {t("settings.memory.noWorkspaceHint")}
          </div>
        ) : !scopeState ? (
          <div className="text-muted-foreground px-3 py-3 text-sm">{t("settings.memory.loading")}</div>
        ) : files.length === 0 ? (
          <div className="text-muted-foreground flex flex-col gap-1 px-3 py-3 text-sm">
            <span>
              {query.trim()
                ? t("settings.memory.noMatch", { query: query.trim() })
                : !memoryEnabled
                  ? t("settings.memory.noFilesDisabled")
                  : t("settings.memory.noFiles")}
            </span>
            {!query.trim() && (
              <span className="flex items-center gap-1 font-mono text-[13px] leading-5">
                <FolderOpenIcon className="size-3 shrink-0" />
                {scopeState.dir}
              </span>
            )}
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.name}
              className="hover:bg-muted/70 flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors"
              onClick={() => onOpenFile(f.name)}
            >
              <div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border">
                <FileTextIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {f.name}
                  {openingFile === f.name && (
                    <span className="text-muted-foreground ml-2 text-[13px] leading-5">
                      {t("settings.memory.opening")}
                    </span>
                  )}
                </div>
                {f.mtime > 0 && (
                  <div className="text-muted-foreground text-[13px] leading-5">{formatTime(f.mtime)}</div>
                )}
              </div>
              <div
                className="flex shrink-0 items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  title={t("settings.memory.versionHistory")}
                  disabled={rowBusy === f.name}
                  onClick={() => onOpenHistory(f.name)}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                >
                  <HistoryIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={t("settings.memory.deleteToTrash")}
                  disabled={rowBusy === f.name}
                  onClick={() => onDeleteFile(f.name)}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                >
                  {rowBusy === f.name ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                </button>
                <Switch
                  size="sm"
                  checked={fileOn(f.name)}
                  onCheckedChange={(on) => onToggleFile(f.name, on)}
                  aria-label={t("settings.memory.participate", { name: f.name })}
                />
              </div>
            </div>
          ))
        )}
        {dailyHint && files.length > 0 && (
          <div className="text-muted-foreground px-3 py-1.5 text-[13px] leading-5">{dailyHint}</div>
        )}
      </div>
    </section>
  );
};

/** 记忆配置页：总开关 / 双作用域叠加 / 文件检索 / 以文件列表为中心的浏览
 *  （点开文件 = 预览 + 编辑，编辑保存走 sidecar 整体覆盖并热替换提示词）。
 *  事实源在 sidecar（SQLite kv 持久化），这里只镜像；开关即改即存（乐观更新）。 */
export const MemorySettings: FC = () => {
  const t = useT();
  const config = useMemoryConfig();
  const workspaceCwd = useWorkspace();
  const recents = useWorkspaceRecents();
  // 工作区页签查看哪个目录：overrideCwd 为 null 时跟随主界面当前工作区，
  // 手动切换/浏览仅改变本页的查看目标（打开/编辑都按它走），不影响主界面选择
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspaceCwd;
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [scopes, setScopes] = useState<{
    global: PiMemoryScopeState;
    workspace: PiMemoryScopeState | null;
  } | null>(null);
  const [scopeTab, setScopeTab] = useState<ScopeTab>("global");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // 点开的文件（内容读回后开编辑弹窗，默认落在预览页签）
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [editFile, setEditFile] = useState<{ name: string; content: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // 版本历史 / 删除 / 回收站
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [trash, setTrash] = useState<PiMemoryTrashEntry[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [trashBusy, setTrashBusy] = useState<string | null>(null);
  const latest = useRef(config);

  useEffect(() => {
    latest.current = config;
  }, [config]);

  const fetchFiles = useCallback(() => {
    setRefreshing(true);
    return Promise.all([
      listMemoryFiles(viewingCwd)
        .then((s) => setScopes(s))
        .catch(() => setScopes(null)),
      listMemoryTrash(scopeTab, viewingCwd)
        .then((entries) => setTrash(entries))
        .catch(() => setTrash([])),
    ]).finally(() => setRefreshing(false));
  }, [viewingCwd, scopeTab]);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  const update = (patch: Partial<MemoryConfig>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setSaveState("pending");
    saveMemoryConfig(next)
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("error"));
  };

  const activeState = scopeTab === "global" ? scopes?.global ?? null : scopes?.workspace ?? null;
  const allFiles = activeState?.files ?? [];
  const rootFiles = allFiles.filter((f) => !f.name.startsWith("daily/"));
  const dailyHintRow = allFiles.find((f) => f.name.startsWith("daily/"));
  const files = rootFiles.filter((f) =>
    query.trim() ? f.name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  const fileOn = (name: string): boolean => {
    const allow = config.enabledFiles[scopeTab];
    if (allow === null) return true;
    return allow.includes(name);
  };

  const updateEnabledFile = (name: string, on: boolean) => {
    const cfg = latest.current;
    const allNames = rootFiles.map((f) => f.name);
    // 白名单语义：null = 全部启用；关掉任一文件时落成显式名单（除它之外全开）
    const base = cfg.enabledFiles[scopeTab] ?? allNames;
    const nextList = on ? [...new Set([...base, name])] : base.filter((n) => n !== name);
    const materialized = allNames.length > 0 && allNames.every((n) => nextList.includes(n));
    update({ enabledFiles: { ...cfg.enabledFiles, [scopeTab]: materialized ? null : nextList } });
  };

  const openFile = (name: string) => {
    setOpeningFile(name);
    readMemoryEntry(scopeTab, viewingCwd, name)
      .then((content) => {
        setEditFile({ name, content });
        setEditOpen(true);
      })
      .catch(() => setSaveState("error"))
      .finally(() => setOpeningFile(null));
  };

  const saveEdit = (next: string) => {
    if (!editFile) return;
    setSaveState("pending");
    writeMemoryEntry(scopeTab, viewingCwd, editFile.name, next)
      .then(() => {
        setSaveState("saved");
        void fetchFiles();
      })
      .catch(() => setSaveState("error"));
  };

  /** 只读浏览：弹原生目录选择器，但不改主界面工作区（与子智能体页同款语义） */
  const pickBrowseDir = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({
        directory: true,
        multiple: false,
        title: t("settings.memory.browseDialogTitle"),
      });
      if (typeof dir === "string") setOverrideCwd(dir === workspaceCwd ? null : dir);
    } catch {
      // 非 桌面壳环境：无原生目录选择器
    }
  };

  /** 删除 = 移入回收站（可恢复；列表与检索立刻不再看到它） */
  const deleteFile = async (name: string) => {
    setRowBusy(name);
    try {
      await trashMemoryEntry(scopeTab, viewingCwd, name);
      toast.success(t("settings.memory.trashed", { name }));
      setTrashOpen(true);
      await fetchFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.memory.deleteFailed"));
    } finally {
      setRowBusy(null);
    }
  };

  const restoreTrash = async (entry: PiMemoryTrashEntry) => {
    setTrashBusy(entry.id);
    try {
      await restoreMemoryTrash(scopeTab, viewingCwd, entry.id);
      toast.success(t("settings.memory.restored", { name: entry.name }));
      await fetchFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.memory.restoreFailed"));
    } finally {
      setTrashBusy(null);
    }
  };

  const purgeTrash = async (entry: PiMemoryTrashEntry) => {
    setTrashBusy(entry.id);
    try {
      await deleteMemoryTrash(scopeTab, viewingCwd, entry.id);
      await fetchFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.memory.purgeFailed"));
    } finally {
      setTrashBusy(null);
    }
  };

  const emptyTrash = async () => {
    try {
      const removed = await emptyMemoryTrash(scopeTab, viewingCwd);
      toast.success(t("settings.memory.emptySuccess", { count: removed }));
      await fetchFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.memory.emptyFailed"));
    }
  };

  const cwdCandidates = Array.from(
    new Set([overrideCwd, workspaceCwd, ...recents].filter((d): d is string => Boolean(d))),
  );

  const statusText =
    saveState === "error"
      ? t("settings.memory.statusError")
      : saveState === "pending"
        ? t("settings.memory.statusPending")
        : t("settings.memory.statusSaved");

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.memory.title")}</h1>
          <span
            className={cn(
              "text-[13px] leading-5",
              saveState === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {statusText}
          </span>
        </div>

        {/* 总开关与检索 */}
        <section className="flex flex-col gap-3">
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.memory.enableMemory")}
              desc={t("settings.memory.enableMemoryDesc")}
            >
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
                aria-label={t("settings.memory.enableMemory")}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.memory.global")}
              desc={t("settings.memory.globalDesc")}
            >
              <Switch
                checked={config.global}
                onCheckedChange={(v) => update({ global: v })}
                aria-label={t("settings.memory.global")}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.memory.workspace")}
              desc={
                workspaceCwd
                  ? t("settings.memory.workspaceDesc")
                  : t("settings.memory.workspaceNoCwdDesc")
              }
            >
              <Switch
                disabled={!workspaceCwd}
                checked={config.workspace}
                onCheckedChange={(v) => update({ workspace: v })}
                aria-label={t("settings.memory.workspace")}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.memory.fileSearch")}
              desc={t("settings.memory.fileSearchDesc")}
            >
              <Switch
                disabled={!config.enabled}
                checked={config.fileSearch}
                onCheckedChange={(v) => update({ fileSearch: v })}
                aria-label={t("settings.memory.fileSearch")}
              />
            </SettingRow>
          </div>
        </section>

        {/* 文件浏览器：全局 / 工作区两页签共用一套列表 */}
        <MemoryFileBrowser
          scopeTab={scopeTab}
          onScopeTabChange={setScopeTab}
          workspaceCwd={viewingCwd}
          scopeState={activeState}
          files={files}
          dailyHint={
            dailyHintRow
              ? t("settings.memory.dailyHint", { name: dailyHintRow.name })
              : null
          }
          query={query}
          onQueryChange={setQuery}
          onRefresh={() => void fetchFiles()}
          refreshing={refreshing}
          memoryEnabled={config.enabled}
          fileOn={fileOn}
          onToggleFile={updateEnabledFile}
          onOpenFile={openFile}
          openingFile={openingFile}
          onOpenHistory={setHistoryFile}
          onDeleteFile={setConfirmDelete}
          rowBusy={rowBusy}
          following={!overrideCwd}
          followLabel={workspaceCwd ? pathBasename(workspaceCwd) : null}
          cwdCandidates={cwdCandidates}
          onSwitchCwd={(dir) => setOverrideCwd(dir === workspaceCwd ? null : dir)}
          onFollowCurrent={() => setOverrideCwd(null)}
          onBrowse={() => void pickBrowseDir()}
        />

        {/* 回收站：删除先落这里，可恢复/彻底删除/清空（彻底删除会连版本史一起清） */}
        {trash.length > 0 && (
          <section className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <div className="flex items-center gap-2 px-1 py-1">
              <button
                type="button"
                onClick={() => setTrashOpen((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1.5 text-sm transition-colors"
              >
                {trashOpen ? (
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0" />
                )}
                <Trash2Icon className="size-3.5 shrink-0" />
                {t("settings.memory.trashTitle", { count: trash.length })}
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive ml-auto h-7 px-2 text-[13px] leading-5"
                onClick={() => setConfirmEmpty(true)}
              >
                {t("settings.memory.emptyTrash")}
              </Button>
            </div>
            {trashOpen &&
              trash.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-xl px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{entry.name}</div>
                    <div className="text-muted-foreground text-[13px] leading-5">
                      {t("settings.memory.deletedAt", { time: formatTime(entry.ts) })}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-[13px] leading-5"
                      disabled={trashBusy !== null}
                      onClick={() => void restoreTrash(entry)}
                    >
                      {trashBusy === entry.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcwIcon className="size-3.5" />
                      )}
                      {t("settings.memory.restore")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-7 gap-1.5 px-2 text-[13px] leading-5"
                      disabled={trashBusy !== null}
                      onClick={() => void purgeTrash(entry)}
                    >
                      <Trash2Icon className="size-3.5" />
                      {t("settings.memory.purge")}
                    </Button>
                  </div>
                </div>
              ))}
            {trashOpen && (
              <div className="text-muted-foreground px-3 pb-1 text-[13px] leading-5">
                {t("settings.memory.purgeHint")}
              </div>
            )}
          </section>
        )}
      </div>

      {/* 点开记忆文件：预览 / 编辑两页签；保存走整体覆盖 + 提示词热替换 */}
      {editFile && (
        <MarkdownEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          title={t("settings.memory.editTitle", {
            scope:
              scopeTab === "global"
                ? t("settings.memory.globalShort")
                : t("settings.memory.workspaceShort"),
            name: editFile.name,
          })}
          value={editFile.content}
          maxLength={100_000}
          initialTab="preview"
          placeholder={t("settings.memory.editPlaceholder")}
          onSave={saveEdit}
        />
      )}

      {/* 版本历史：每次改动自动记一版，可预览/恢复/删单版 */}
      {historyFile && (
        <MemoryHistoryDialog
          open
          onOpenChange={(open) => {
            if (!open) setHistoryFile(null);
          }}
          scope={scopeTab}
          cwd={viewingCwd}
          file={historyFile}
          onRestored={() => void fetchFiles()}
        />
      )}

      {/* 删除确认：删 = 移入回收站，可恢复 */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.memory.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.memory.deleteConfirmDesc", {
                name: confirmDelete ?? "",
                scope:
                  scopeTab === "global"
                    ? t("settings.memory.globalShort")
                    : t("settings.memory.workspaceShort"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("settings.memory.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                const name = confirmDelete;
                setConfirmDelete(null);
                if (name) void deleteFile(name);
              }}
            >
              {t("settings.memory.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清空回收站确认：彻底删除不可恢复（连版本历史一起清） */}
      <AlertDialog
        open={confirmEmpty}
        onOpenChange={(open) => {
          if (!open) setConfirmEmpty(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.memory.emptyConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.memory.emptyConfirmDesc", { count: trash.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("settings.memory.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                setConfirmEmpty(false);
                void emptyTrash();
              }}
            >
              {t("settings.memory.clear")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
