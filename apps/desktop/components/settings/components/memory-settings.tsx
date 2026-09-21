"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDownIcon,
  FileTextIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isTauri } from "@/lib/tauri";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace/workspace-store";
import {
  listMemoryFiles,
  readMemoryEntry,
  saveMemoryConfig,
  useMemoryConfig,
  writeMemoryEntry,
  type MemoryConfig,
} from "@/lib/memory/memory";
import type { PiMemoryFileEntry, PiMemoryScopeState } from "@/lib/pi/pi-bridge";

/* 重依赖（CodeMirror / Streamdown）走异步分块：点开文件才拉取，不进设置页首屏包 */
const MarkdownEditDialog = dynamic(() => import("./markdown-edit-dialog"), {
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
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <button
          type="button"
          title={value ?? undefined}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {value ? pathBasename(value) : "未选择工作区"}
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
        <div className="text-muted-foreground px-2 py-3 text-center text-xs">暂无记录</div>
      )}
      {!following && followLabel && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFollowCurrent}>
            跟随当前工作区 · {followLabel}
          </DropdownMenuItem>
        </>
      )}
      {showBrowse && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onBrowse}>
            <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
            浏览其他目录…
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

const formatTime = (ms: number): string => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  fileOn: (name: string) => boolean;
  onToggleFile: (name: string, on: boolean) => void;
  onOpenFile: (name: string) => void;
  openingFile: string | null;
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
    fileOn,
    onToggleFile,
    onOpenFile,
    openingFile,
    following,
    followLabel,
    cwdCandidates,
    onSwitchCwd,
    onFollowCurrent,
    onBrowse,
  } = props;

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
              全局记忆
            </TabsTrigger>
            <TabsTrigger value="workspace" className="rounded-full px-3 py-1 text-sm">
              工作区记忆
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {scopeTab === "workspace" && (
          <WorkspaceCwdMenu
            value={workspaceCwd}
            following={following}
            followLabel={followLabel}
            candidates={cwdCandidates}
            showBrowse={isTauri()}
            onChange={onSwitchCwd}
            onFollowCurrent={onFollowCurrent}
            onBrowse={onBrowse}
          />
        )}
        <span className="text-muted-foreground text-sm">{files.length} 个记忆文件</span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="h-9 w-56 bg-background"
            placeholder="搜索记忆文件…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="刷新"
          >
            <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {scopeTab === "workspace" && scopeState && (
        <div className="flex items-center gap-1">
          <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground truncate font-mono text-xs">{scopeState.dir}</span>
        </div>
      )}

      {/* 文件列表 */}
      <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        {workspaceUnavailable ? (
          <div className="text-muted-foreground px-3 py-3 text-sm">
            未选择工作区。选择工作区后，这里会显示该仓库 .xulux/memory 下的记忆文件；也可以点上方目录切换器「浏览其他目录…」直接查看任意目录。
          </div>
        ) : !scopeState ? (
          <div className="text-muted-foreground px-3 py-3 text-sm">正在加载…</div>
        ) : files.length === 0 ? (
          <div className="text-muted-foreground flex flex-col gap-1 px-3 py-3 text-sm">
            <span>
              {query.trim()
                ? `没有匹配「${query.trim()}」的记忆文件。`
                : "还没有记忆文件。点击右上角刷新，或让 AI 用 memory_write 写入第一条，也可以手动在目录下创建 .md 文件。"}
            </span>
            {!query.trim() && (
              <span className="flex items-center gap-1 font-mono text-xs">
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
                    <span className="text-muted-foreground ml-2 text-xs">打开中…</span>
                  )}
                </div>
                {f.mtime > 0 && (
                  <div className="text-muted-foreground text-xs">{formatTime(f.mtime)}</div>
                )}
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  size="sm"
                  checked={fileOn(f.name)}
                  onCheckedChange={(on) => onToggleFile(f.name, on)}
                  aria-label={`${f.name} 参与注入`}
                />
              </div>
            </div>
          ))
        )}
        {dailyHint && files.length > 0 && (
          <div className="text-muted-foreground px-3 py-1.5 text-xs">{dailyHint}</div>
        )}
      </div>
    </section>
  );
};

/** 记忆配置页：总开关 / 双作用域叠加 / 文件检索 / 以文件列表为中心的浏览
 *  （点开文件 = 预览 + 编辑，编辑保存走 sidecar 整体覆盖并热替换提示词）。
 *  事实源在 sidecar（SQLite kv 持久化），这里只镜像；开关即改即存（乐观更新）。 */
export const MemorySettings: FC = () => {
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
  const latest = useRef(config);

  useEffect(() => {
    latest.current = config;
  }, [config]);

  const fetchFiles = useCallback(() => {
    setRefreshing(true);
    return listMemoryFiles(viewingCwd)
      .then((s) => setScopes(s))
      .catch(() => setScopes(null))
      .finally(() => setRefreshing(false));
  }, [viewingCwd]);

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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "浏览工作区记忆目录" });
      if (typeof dir === "string") setOverrideCwd(dir === workspaceCwd ? null : dir);
    } catch {
      // 非 Tauri 环境：无原生目录选择器
    }
  };

  const cwdCandidates = Array.from(
    new Set([overrideCwd, workspaceCwd, ...recents].filter((d): d is string => Boolean(d))),
  );

  const statusText =
    saveState === "error" ? "操作失败，请重试" : saveState === "pending" ? "保存中…" : "已自动保存";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">记忆</h1>
          <span
            className={cn(
              "text-xs",
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
              label="启用记忆"
              desc="开启后，AI 在每轮对话携带下方启用的记忆文件，并可用 memory_write / memory_search 管理与检索记忆。"
            >
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
                aria-label="启用记忆"
              />
            </SettingRow>
            <SettingRow
              label="全局记忆"
              desc="所有会话共享的长期记忆（~/.xulux/memory）。"
            >
              <Switch
                checked={config.global}
                onCheckedChange={(v) => update({ global: v })}
                aria-label="全局记忆"
              />
            </SettingRow>
            <SettingRow
              label="工作区记忆"
              desc={
                workspaceCwd
                  ? "仅当前工作区的会话生效（<工作区>/.xulux/memory）。"
                  : "当前未选择工作区，开启后也不会生效。"
              }
            >
              <Switch
                disabled={!workspaceCwd}
                checked={config.workspace}
                onCheckedChange={(v) => update({ workspace: v })}
                aria-label="工作区记忆"
              />
            </SettingRow>
            <SettingRow
              label="文件检索"
              desc="memory_search 按关键词检索两个作用域的全部记忆文件（含 daily 日志）。关闭后只能整读文件。"
            >
              <Switch
                disabled={!config.enabled}
                checked={config.fileSearch}
                onCheckedChange={(v) => update({ fileSearch: v })}
                aria-label="文件检索"
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
          dailyHint={dailyHintRow ? `另有 ${dailyHintRow.name}（仅参与检索，AI 可用 memory_search 查到）` : null}
          query={query}
          onQueryChange={setQuery}
          onRefresh={() => void fetchFiles()}
          refreshing={refreshing}
          fileOn={fileOn}
          onToggleFile={updateEnabledFile}
          onOpenFile={openFile}
          openingFile={openingFile}
          following={!overrideCwd}
          followLabel={workspaceCwd ? pathBasename(workspaceCwd) : null}
          cwdCandidates={cwdCandidates}
          onSwitchCwd={(dir) => setOverrideCwd(dir === workspaceCwd ? null : dir)}
          onFollowCurrent={() => setOverrideCwd(null)}
          onBrowse={() => void pickBrowseDir()}
        />
      </div>

      {/* 点开记忆文件：预览 / 编辑两页签；保存走整体覆盖 + 提示词热替换 */}
      {editFile && (
        <MarkdownEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          title={`记忆 · ${scopeTab === "global" ? "全局" : "工作区"} / ${editFile.name}`}
          value={editFile.content}
          maxLength={100_000}
          initialTab="preview"
          placeholder="记忆内容支持 Markdown。"
          onSave={saveEdit}
        />
      )}
    </div>
  );
};
