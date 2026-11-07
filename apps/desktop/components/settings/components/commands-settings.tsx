"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  GitGraphIcon,
  GlobeIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SquareTerminalIcon,
  TargetIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace/workspace-store";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import {
  piSessionCwdMap,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import {
  deleteCommand,
  fetchCustomCommands,
  saveCommand,
  useCustomCommands,
  type CustomCommand,
} from "@/lib/pi/pi-commands";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/custom-ui/segmented";
import { cn } from "@/lib/utils";

/**
 * 设置 → 命令（管理页「命令」分段）：自定义斜杠命令的增删改。
 * 事实源在 sidecar（.kova/commands 工作区 / ~/.kova/commands 全局 / 内置 / 插件），
 * 保存/删除应答即刷新后的清单。
 *
 * 浏览：Segmented tab 按层级筛选（全局 = 全局 + 内置 + 插件；工作区 = 所选项目），
 * 顶部搜索框按名字/描述过滤列表；工作区 tab 下用项目下拉（对照 composer 的
 * 「选择目录」）切换项目，支持项目内搜索与「添加目录…」。
 * 创建：新建命令入口先选层级（全局 / 工作区），工作区在表单里再选目标项目。
 * 组件纪律：表单/按钮/徽标/菜单一律走 @/components/ui 与 custom-ui，不用原生。
 */

type Draft = {
  name: string;
  description: string;
  argumentHint: string;
  /** 菜单图标键（小写；空 = 缺省 Zap） */
  icon: string;
  body: string;
  scope: "workspace" | "global";
  /** 工作区命令的落点项目目录（scope=global 时不用） */
  cwd: string;
  replaceName?: string;
};

/** 图标可选集：键与 composer-commands 的 CUSTOM_COMMAND_ICONS 一一对应 */
const ICON_CHOICES = [
  { key: "zap", Icon: ZapIcon },
  { key: "bookopen", Icon: BookOpenIcon },
  { key: "globe", Icon: GlobeIcon },
  { key: "target", Icon: TargetIcon },
  { key: "listtodo", Icon: ListTodoIcon },
  { key: "squareterminal", Icon: SquareTerminalIcon },
  { key: "gitgraph", Icon: GitGraphIcon },
  { key: "activity", Icon: ActivityIcon },
] as const;

const SOURCE_BADGE: Record<CustomCommand["source"], string> = {
  builtin: "内置",
  workspace: "工作区",
  global: "全局",
  plugin: "插件",
};

const emptyDraft = (scope: "workspace" | "global", cwd = ""): Draft => ({
  name: "",
  description: "",
  argumentHint: "",
  icon: "",
  body: "",
  scope,
  cwd,
});

/** 可选目标项目：当前工作区 → 最近使用 → 会话项目表（去重保序） */
function useProjectDirs(workspace: string | null): string[] {
  const recents = useWorkspaceRecents();
  const prefsVersion = useSessionPrefsVersion();
  return useMemo(() => {
    void prefsVersion; // 会话清单更新（项目表来源）时重算
    const dirs: string[] = [];
    const seen = new Set<string>();
    const push = (dir: string | undefined) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };
    push(workspace ?? undefined);
    for (const dir of recents) push(dir);
    for (const cwd of piSessionCwdMap.values()) push(cwd);
    return dirs;
  }, [workspace, recents, prefsVersion]);
}

export const CommandsSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const workspace = useWorkspace();
  const remoteWorkspace = useIsRemoteWorkspace(workspace);
  const projectDirsBase = useProjectDirs(workspace);
  const [addedDirs, setAddedDirs] = useState<string[]>([]);
  const projectDirs = useMemo(() => {
    const dirs = [...projectDirsBase];
    for (const dir of addedDirs) if (!dirs.includes(dir)) dirs.push(dir);
    return dirs;
  }, [projectDirsBase, addedDirs]);

  // 浏览态：层级 tab + 目标项目（工作区 tab）+ 列表搜索 + 项目内搜索
  const [layer, setLayer] = useState<"global" | "workspace">("global");
  const [projectWs, setProjectWs] = useState<string | null | undefined>(undefined);
  const [listQuery, setListQuery] = useState("");
  const [dirQuery, setDirQuery] = useState("");
  const effectiveCwd = projectWs === undefined ? workspace : projectWs;

  // 取数口径按 tab 分层：全局 tab 不带 cwd（不扫工作区层，init 显示为内置）；
  // 工作区 tab 带项目 cwd（工作区文件覆盖内置的语义只在项目语境里成立）
  const listCwd = layer === "workspace" ? effectiveCwd : null;
  const base = useCustomCommands(listCwd);
  const [items, setItems] = useState<CustomCommand[]>(base);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setItems(base), [base]);


  const visible = useMemo(() => {
    let list = items.filter((c) =>
      layer === "workspace" ? c.source === "workspace" : c.source !== "workspace",
    );
    const q = listQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, layer, listQuery]);

  const filteredDirs = useMemo(() => {
    const q = dirQuery.trim().toLowerCase();
    if (!q) return projectDirs;
    return projectDirs.filter((dir) => pathBasename(dir).toLowerCase().includes(q));
  }, [projectDirs, dirQuery]);

  const addDirectory = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof dir === "string") {
        setAddedDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
        setProjectWs(dir);
        setLayer("workspace");
      }
    } catch {
      /* 非桌面壳环境没有原生 dialog */
    }
  };

  const startNew = (scope: "workspace" | "global") => {
    setError("");
    const cwd = scope === "workspace" ? (effectiveCwd ?? projectDirs[0] ?? "") : "";
    setDraft(emptyDraft(scope, cwd));
  };

  const startEdit = (c: CustomCommand) => {
    setError("");
    // builtin / plugin 都是只读来源：动作 = 复制一份到工作区改
    if (c.source === "builtin" || c.source === "plugin") {
      setDraft({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint ?? "",
        icon: c.icon ?? "",
        body: c.body ?? "",
        scope: "workspace",
        cwd: effectiveCwd ?? projectDirs[0] ?? "",
      });
      return;
    }
    setDraft({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint ?? "",
      icon: c.icon ?? "",
      body: c.body ?? "",
      scope: c.source,
      cwd: c.source === "workspace" ? (effectiveCwd ?? "") : "",
      replaceName: c.name,
    });
  };

  const save = async () => {
    if (!draft || busy) return;
    if (draft.scope === "workspace" && !draft.cwd) {
      setError("工作区命令需要选择目标项目");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const list = await saveCommand({
        cwd: draft.scope === "workspace" ? draft.cwd : null,
        scope: draft.scope,
        name: draft.name,
        description: draft.description,
        argumentHint: draft.argumentHint || undefined,
        icon: draft.icon || undefined,
        body: draft.body,
        ...(draft.replaceName ? { replaceName: draft.replaceName } : {}),
      });
      setItems(list);
      setDraft(null);
      // 保存口径与当前 tab 口径不同（如工作区 tab 里存全局命令）：按 tab 口径
      // 补刷一次，避免响应快照让列表瞬态丢项（单槽缓存保证这里必然回源）
      const saveCwd = draft.scope === "workspace" ? draft.cwd : null;
      if (saveCwd !== listCwd) {
        void fetchCustomCommands(listCwd)
          .then((fresh) => setItems(fresh))
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string, scope: "workspace" | "global") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const list = await deleteCommand({ cwd: listCwd, scope, name });
      setItems(list);
      setConfirmName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {remoteWorkspace ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          远程项目：工作区命令不参与展开（只能扫描本机 .kova/commands）。远程会话里
          可用的只有全局、插件与内置命令。
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          自定义斜杠命令：菜单选中后展开为提示词模板（$ARGUMENTS 会被参数替换）。
          工作区命令随 git 共享，全局命令本机可用，内置 /init 可复制后改。
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" className="shrink-0">
                <PlusIcon />
                新建命令
                <ChevronDownIcon className="opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => startNew("global")}>
              新增全局命令
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => startNew("workspace")}
              disabled={projectDirs.length === 0}
            >
              新增工作区命令…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={layer}
          onChange={setLayer}
          options={[
            { value: "global", label: "全局" },
            { value: "workspace", label: "工作区" },
          ]}
        />
        {layer === "workspace" ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) setDirQuery("");
            }}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="min-w-48 justify-between font-normal"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FolderClosedIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">
                      {effectiveCwd ? pathBasename(effectiveCwd) : "选择项目…"}
                    </span>
                  </span>
                  <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-72 h-60 p-0 flex flex-col overflow-hidden">
               <div className="px-2 ">
                  <Input
                    value={dirQuery}
                    onChange={(e) => setDirQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") e.stopPropagation();
                    }}
                    placeholder="搜索"
                    className="border-0 bg-transparent focus-visible:ring-0"
                  />
                </div>
              <DropdownMenuGroup className="p-0 flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
                <DropdownMenuSeparator className="mt-0" />
                <div className="px-1 pb-1 flex-1 overflow-auto flex flex-col">
                  {filteredDirs.map((dir) => (
                    <DropdownMenuCheckboxItem
                      key={dir}
                      checked={effectiveCwd === dir}
                      onCheckedChange={(checked) => {
                        // 单选语义 + 可取消：再点当前项 → 取消选中（回到「先选择项目」）
                        setProjectWs(checked ? dir : null);
                      }}
                      closeOnClick={false}
                      title={dir}
                    >
                      <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate">{pathBasename(dir)}</span>
                      {dir === workspace ? (
                        <span className="text-muted-foreground ml-auto shrink-0 text-2xs">
                          当前
                        </span>
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {dirQuery.trim() && filteredDirs.length === 0 ? (
                    <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                      没有匹配的项目
                    </div>
                  ) : null}
                </div>
              </DropdownMenuGroup>
              {/* <DropdownMenuSeparator /> */}
              {/* <div className="px-1 pb-1 shrink-0">
                <DropdownMenuItem onClick={addDirectory}>
                  <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
                  添加目录…
                </DropdownMenuItem>
              </div> */}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <div className="relative ml-auto">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            placeholder="搜索命令"
            className="h-8 w-56 ps-8"
          />
        </div>
      </div>

      {error ? (
        <p className="text-destructive border-destructive/30 bg-destructive/5 rounded-lg border px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-2.5 rounded-xl border p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">命令名</span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="text-muted-foreground">/</span>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="my-command"
                disabled={Boolean(draft.replaceName)}
                className="w-56"
              />
              {draft.replaceName ? (
                <span className="text-muted-foreground text-xs">
                  改名保存后移除旧文件 /{draft.replaceName}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">描述</span>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="菜单里显示的说明"
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">参数提示</span>
            <Input
              value={draft.argumentHint}
              onChange={(e) => setDraft({ ...draft, argumentHint: e.target.value })}
              placeholder="（可选）如 <文件路径>"
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">图标</span>
            <div className="flex items-center gap-1">
              {ICON_CHOICES.map(({ key, Icon }) => {
                const selected = draft.icon === key;
                return (
                  <Button
                    key={key}
                    type="button"
                    variant={selected ? "secondary" : "ghost"}
                    size="icon-sm"
                    title={key}
                    aria-pressed={selected}
                    onClick={() => setDraft({ ...draft, icon: selected ? "" : key })}
                    className={cn(selected && "ring-ring ring-1")}
                  >
                    <Icon />
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">范围</span>
            {draft.scope === "workspace" ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground shrink-0 text-sm">
                  工作区（随 git 共享）
                </span>
                <Select
                  value={draft.cwd}
                  items={projectDirs.map((dir) => ({
                    value: dir,
                    label: pathBasename(dir) + (dir === workspace ? "（当前）" : ""),
                  }))}
                  onValueChange={(v) => setDraft({ ...draft, cwd: v ?? "" })}
                >
                  <SelectTrigger size="sm" className="min-w-56">
                    <SelectValue placeholder="选择项目…" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectDirs.map((dir) => (
                      <SelectItem key={dir} value={dir}>
                        {pathBasename(dir)}
                        {dir === workspace ? "（当前）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">
                全局（本机，所有项目通用）
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-sm">
              模板正文（$ARGUMENTS 会被命令后的参数替换；不写占位符则参数追加在尾部）
            </span>
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={10}
              placeholder="给模型的提示词模板…"
              className="min-h-40 font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={busy || !draft.name.trim()}>
              {busy ? "保存中…" : "保存"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-3.5 py-6 text-center text-sm">
              {listQuery.trim()
                ? "没有匹配的命令"
                : layer === "workspace"
                  ? effectiveCwd
                    ? "这个项目还没有工作区命令——新建一个，或在仓库里放 .kova/commands/*.md"
                    : "先选择一个项目"
                  : "还没有全局命令"}
            </p>
          ) : (
            <ul className="flex flex-col">
              {visible.map((c) => (
                <li
                  key={`${c.source}:${c.name}`}
                  className="hover:bg-muted/40 flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
                >
                  {(() => {
                    const Icon =
                      ICON_CHOICES.find((choice) => choice.key === c.icon)?.Icon ?? ZapIcon;
                    return <Icon className="text-muted-foreground size-4 shrink-0" />;
                  })()}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">/{c.name}</span>
                      <Badge variant="secondary">{SOURCE_BADGE[c.source]}</Badge>
                    </div>
                    <p className="text-muted-foreground truncate text-xs">
                      {c.description || "自定义命令"}
                      {c.argumentHint ? ` · ${c.argumentHint}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {c.source === "builtin" || c.source === "plugin" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => startEdit(c)}
                        title={
                          c.source === "plugin"
                            ? "复制到工作区改一份（插件命令由插件管理）"
                            : "复制到工作区改一份"
                        }
                      >
                        <CopyIcon />
                        复制
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => startEdit(c)}
                          title="编辑"
                        >
                          <PencilIcon />
                        </Button>
                        {confirmName === `${c.source}:${c.name}` ? (
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            onClick={() =>
                              remove(c.name, c.source === "global" ? "global" : "workspace")
                            }
                          >
                            确认删除
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setConfirmName(`${c.source}:${c.name}`)}
                            title="删除"
                            className={cn("text-muted-foreground hover:text-destructive")}
                          >
                            <Trash2Icon />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
