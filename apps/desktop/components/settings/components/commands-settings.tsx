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
  SquareTerminalIcon,
  TargetIcon,
  Trash2Icon,
  XIcon,
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
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * 设置 → 命令（管理页「命令」分段）：自定义斜杠命令的增删改。
 * 事实源在 sidecar（.kova/commands 工作区 / ~/.kova/commands 全局 / 内置 / 插件），
 * 保存/删除应答即刷新后的清单。
 *
 * 布局对齐 MCP / 技能页：一行工具条（层级页签 + 项目选择 + 计数 + 搜索 + 新建），
 * 下方为行卡清单；空态用点阵云 + 标题/说明 + 直达新建的次要动作。
 * 浏览：Segmented tab 按层级筛选（全局 = 全局 + 内置 + 插件；工作区 = 所选项目），
 * 搜索框按名字/描述过滤列表；工作区 tab 下用项目下拉切换项目。
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

  const closeDraft = () => {
    setDraft(null);
    setError("");
  };

  /** 空态文案与直达动作：按「搜索 / 工作区未选项目 / 工作区 / 全局」分流 */
  const empty = (() => {
    if (listQuery.trim()) {
      return {
        title: t("settings.commands.emptyNoQuery"),
        hint: t("settings.commands.emptyNoQueryHint"),
        action: null,
      };
    }
    if (layer === "workspace") {
      if (!effectiveCwd) {
        return {
          title: t("settings.commands.emptyWorkspaceNoCwd"),
          hint: t("settings.commands.emptyWorkspaceNoCwdHint"),
          action: null,
        };
      }
      return {
        title: t("settings.commands.emptyWorkspaceTitle"),
        hint: t("settings.commands.emptyWorkspaceHasCwd"),
        action: (
          <Button variant="outline" size="sm" onClick={() => startNew("workspace")}>
            <PlusIcon className="size-3.5" />
            {t("settings.commands.newWorkspace")}
          </Button>
        ),
      };
    }
    return {
      title: t("settings.commands.emptyGlobal"),
      hint: t("settings.commands.emptyGlobalHint"),
      action: (
        <Button variant="outline" size="sm" onClick={() => startNew("global")}>
          <PlusIcon className="size-3.5" />
          {t("settings.commands.newGlobal")}
        </Button>
      ),
    };
  })();

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {remoteWorkspace ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t("settings.commands.remoteBanner")}
        </p>
      ) : null}

      {/* 工具条：层级页签 + 项目选择 + 计数 + 搜索/新建（对齐 MCP / 技能页） */}
      <div className="flex flex-wrap items-center gap-3">
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
            value={effectiveCwd}
            following={projectWs === undefined}
            className="w-52 shrink-0"
            onChange={(dir) => {
              setProjectWs(dir === workspace ? undefined : dir);
              setLayer("workspace");
            }}
            onFollowCurrent={() => setProjectWs(undefined)}
          />
        ) : null}
        <span className="text-muted-foreground text-sm leading-relaxed">
          {t("settings.commands.count", { count: visible.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="h-8 w-56 bg-muted/50"
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && listQuery) setListQuery("");
            }}
            placeholder={t("settings.commands.searchCommands")}
            aria-label={t("settings.commands.searchCommands")}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="h-8 shrink-0 gap-1.5">
                  <PlusIcon className="size-4" />
                  {t("settings.commands.newCommand")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-44">
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
      </div>

      {error ? (
        <p
          role="alert"
          className="text-destructive border-destructive/30 bg-destructive/5 rounded-lg border px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}

      {draft ? (
        // 内联编辑器：不再套整块圆角描边框（页面本身已有边距，外框只会
        // 让表单相对标题/工具栏多缩进一圈）。表单左缘与页面内容对齐，
        // 底部操作行用一条分隔线与正文分开
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 py-4">
            {/* 表单头：模式 + 落点 + 关闭 */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold tracking-tight">
                  {draft.replaceName
                    ? t("settings.commands.edit")
                    : t("settings.commands.newCommand")}
                </h2>
                <p className="text-muted-foreground mt-1 truncate text-ui leading-5">
                  {draft.scope === "workspace"
                    ? t("settings.commands.scopeWorkspaceShared")
                    : t("settings.commands.scopeGlobal")}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground shrink-0"
                onClick={closeDraft}
                aria-label={t("settings.commands.cancel")}
                title={t("settings.commands.cancel")}
              >
                <XIcon />
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldName")}
                </span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-muted-foreground font-mono text-sm">/</span>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder={t("settings.commands.namePlaceholder")}
                    disabled={Boolean(draft.replaceName)}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-9 min-w-0 flex-1 font-mono"
                  />
                </div>
                {draft.replaceName ? (
                  <span className="text-muted-foreground text-xs leading-5">
                    {t("settings.commands.renameHint", { name: draft.replaceName })}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldDescription")}
                </span>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder={t("settings.commands.descriptionPlaceholder")}
                  className="h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldArguments")}
                </span>
                <Input
                  value={draft.argumentHint}
                  onChange={(e) =>
                    setDraft({ ...draft, argumentHint: e.target.value })
                  }
                  placeholder={t("settings.commands.argumentsPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldIcon")}
                </span>
                <div className="flex flex-wrap items-center gap-0.5">
                  {ICON_CHOICES.map(({ key, Icon }) => {
                    const selected = draft.icon === key;
                    return (
                      <Button
                        key={key}
                        type="button"
                        variant={selected ? "secondary" : "ghost"}
                        size="icon-sm"
                        title={key}
                        aria-label={key}
                        aria-pressed={selected}
                        onClick={() =>
                          setDraft({ ...draft, icon: selected ? "" : key })
                        }
                        className={cn(
                          "text-muted-foreground",
                          selected && "text-foreground ring-ring ring-1",
                        )}
                      >
                        <Icon />
                      </Button>
                    );
                  })}
                </div>
              </div>
              {draft.scope === "workspace" ? (
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldScope")}
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
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
              </div>
              ) : null}
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <span className="text-sm font-medium">
                  {t("settings.commands.fieldBody")}
                </span>
                <Textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={10}
                  placeholder={t("settings.commands.bodyPlaceholder")}
                  spellCheck={false}
                  className="min-h-40 font-mono"
                />
                <span className="text-muted-foreground text-xs leading-5">
                  {t("settings.commands.bodyHint")}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={closeDraft}>
                {t("settings.commands.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={save}
                disabled={busy || !draft.name.trim()}
              >
                {busy ? t("settings.commands.saving") : t("settings.commands.save")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
              <div className="relative mb-1 grid place-items-center">
                <DotCloud />
                <div className="bg-muted/50 absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                  <SquareTerminalIcon className="text-muted-foreground size-6" strokeWidth={1.75} />
                </div>
              </div>
              <p className="text-foreground text-sm font-medium">{empty.title}</p>
              <p className="max-w-md text-ui leading-5">{empty.hint}</p>
              {empty.action ? <div className="mt-2">{empty.action}</div> : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((c) => {
                const Icon =
                  ICON_CHOICES.find((choice) => choice.key === c.icon)?.Icon ??
                  ZapIcon;
                return (
                  <li
                    key={`${c.source}:${c.name}`}
                    className="group border-border/50 bg-background hover:bg-muted/40 flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors"
                  >
                    <div className="bg-muted/50 text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium">
                          /{c.name}
                        </span>
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1.5 py-0 text-2xs font-medium"
                        >
                          {t(SOURCE_BADGE[c.source])}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5 truncate text-xs leading-5">
                        {c.description || t("settings.commands.customDescription")}
                        {c.argumentHint ? (
                          <span className="text-muted-foreground/70 font-mono">
                            {" · "}
                            {c.argumentHint}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {c.source === "builtin" || c.source === "plugin" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
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
                            className="text-muted-foreground"
                            onClick={() => startEdit(c)}
                            title={t("settings.commands.edit")}
                            aria-label={t("settings.commands.edit")}
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
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirmName(`${c.source}:${c.name}`)}
                              title={t("settings.commands.delete")}
                              aria-label={t("settings.commands.delete")}
                            >
                              <Trash2Icon />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
