"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CopyIcon,
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
import { pathBasename } from "@/lib/workspace/workspace-store";
import {
  sameProjectPath,
  useProjectWorkspaceDir,
} from "@/lib/pi/pi-projects";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import {
  ProjectScopeMenu,
  useProjectScopeOptions,
} from "@/components/settings/components/project-scope-menu";
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/custom-ui/segmented";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

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
  builtin: "settings.commands.builtin",
  workspace: "settings.commands.workspace",
  global: "settings.commands.global",
  plugin: "settings.commands.plugin",
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

export const CommandsSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
  const remoteWorkspace = useIsRemoteWorkspace(workspace);
  const { options: projectOptions } = useProjectScopeOptions();
  const projectDirs = useMemo(
    () => projectOptions.map((option) => option.primary),
    [projectOptions],
  );
  // 浏览态：层级 tab + 目标项目（工作区 tab）+ 列表搜索
  const [layer, setLayer] = useState<"global" | "workspace">("global");
  const [projectWs, setProjectWs] = useState<string | null | undefined>(undefined);
  const [listQuery, setListQuery] = useState("");
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

  /** 旧命令可能指向非项目目录：草稿的 Select 需要把它作为「历史目录」选项
   *  显示出来，否则编辑旧命令时值会回填成空。 */
  const draftDirs = useMemo(() => {
    const dirs = [...projectDirs];
    const cwd = draft?.cwd;
    if (cwd && !dirs.some((dir) => sameProjectPath(dir, cwd))) {
      dirs.push(cwd);
    }
    return dirs;
  }, [projectDirs, draft?.cwd]);

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

  const startNew = (scope: "workspace" | "global") => {
    setError("");
    const cwd =
      scope === "workspace"
        ? (effectiveCwd ?? projectOptions[0]?.primary ?? "")
        : "";
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
      setError(t("settings.commands.scopeError"));
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
          {t("settings.commands.remoteBanner")}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {t("settings.commands.desc")}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" className="shrink-0">
                <PlusIcon />
                {t("settings.commands.newCommand")}
                <ChevronDownIcon className="opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => startNew("global")}>
              {t("settings.commands.newGlobal")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => startNew("workspace")}
              disabled={projectDirs.length === 0}
            >
              {t("settings.commands.newWorkspace")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={layer}
          onChange={setLayer}
          options={[
            { value: "global", label: t("settings.commands.tabGlobal") },
            { value: "workspace", label: t("settings.commands.tabWorkspace") },
          ]}
        />
        {layer === "workspace" ? (
          <ProjectScopeMenu
            variant="outline"
            align="start"
            value={effectiveCwd}
            following={projectWs === undefined}
            onChange={(dir) => {
              setProjectWs(dir === workspace ? undefined : dir);
              setLayer("workspace");
            }}
            onFollowCurrent={() => setProjectWs(undefined)}
          />
        ) : null}
        <div className="relative ml-auto">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            placeholder={t("settings.commands.searchCommands")}
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
            <span className="text-muted-foreground w-14 shrink-0 text-sm">{t("settings.commands.fieldName")}</span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="text-muted-foreground">/</span>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("settings.commands.namePlaceholder")}
                disabled={Boolean(draft.replaceName)}
                className="w-56"
              />
              {draft.replaceName ? (
                <span className="text-muted-foreground text-xs">
                   {t("settings.commands.renameHint", { name: draft.replaceName })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">{t("settings.commands.fieldDescription")}</span>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder={t("settings.commands.descriptionPlaceholder")}
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">{t("settings.commands.fieldArguments")}</span>
            <Input
              value={draft.argumentHint}
              onChange={(e) => setDraft({ ...draft, argumentHint: e.target.value })}
              placeholder={t("settings.commands.argumentsPlaceholder")}
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground w-14 shrink-0 text-sm">{t("settings.commands.fieldIcon")}</span>
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
            <span className="text-muted-foreground w-14 shrink-0 text-sm">{t("settings.commands.fieldScope")}</span>
            {draft.scope === "workspace" ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground shrink-0 text-sm">
                  {t("settings.commands.scopeWorkspaceShared")}
                </span>
                <Select
                  value={draft.cwd}
                  items={draftDirs.map((dir) => {
                    const option = projectOptions.find((entry) =>
                      sameProjectPath(entry.primary, dir),
                    );
                    const label = option?.label ?? pathBasename(dir);
                    return {
                      value: dir,
                      label: option?.isCurrent
                        ? t("settings.commands.currentOption", { name: label })
                        : label,
                    };
                  })}
                  onValueChange={(v) => setDraft({ ...draft, cwd: v ?? "" })}
                >
                  <SelectTrigger size="sm" className="min-w-56">
                    <SelectValue placeholder={t("settings.commands.selectProject")} />
                  </SelectTrigger>
                  <SelectContent>
                    {draftDirs.map((dir) => {
                      const option = projectOptions.find((entry) =>
                        sameProjectPath(entry.primary, dir),
                      );
                      return (
                        <SelectItem key={dir} value={dir}>
                          {option?.label ?? pathBasename(dir)}
                          {option?.isCurrent
                            ? `（${t("settings.commands.current")}）`
                            : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">
                {t("settings.commands.scopeGlobal")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-sm">
              {t("settings.commands.fieldBody")}
            </span>
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={10}
              placeholder={t("settings.commands.bodyPlaceholder")}
              className="min-h-40 font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={busy || !draft.name.trim()}>
              {busy ? t("settings.commands.saving") : t("settings.commands.save")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t("settings.commands.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-3.5 py-6 text-center text-sm">
              {listQuery.trim()
                ? t("settings.commands.emptyNoQuery")
                : layer === "workspace"
                  ? effectiveCwd
                    ? t("settings.commands.emptyWorkspaceHasCwd")
                    : t("settings.commands.emptyWorkspaceNoCwd")
                  : t("settings.commands.emptyGlobal")}
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
                      <Badge variant="secondary">{t(SOURCE_BADGE[c.source])}</Badge>
                    </div>
                    <p className="text-muted-foreground truncate text-xs">
                      {c.description || t("settings.commands.customDescription")}
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
                            ? t("settings.commands.copyPluginTitle")
                            : t("settings.commands.copyTitle")
                        }
                      >
                        <CopyIcon />
                        {t("settings.commands.copy")}
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => startEdit(c)}
                          title={t("settings.commands.edit")}
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
                            {t("settings.commands.confirmDelete")}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setConfirmName(`${c.source}:${c.name}`)}
                            title={t("settings.commands.delete")}
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
