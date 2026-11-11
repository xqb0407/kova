"use client";

/**
 * 子智能体管理页。唯一入口：「插件 / 专家 / 技能」→ 管理 → 子智能体（分段器
 * 首位）。文件仍在 settings/components/ 下——组件本身无设置页依赖，是就近
 * 归档，不是残留入口。
 *
 * 事实源在 sidecar：三层定义（内置常量 / <app_data>/subagents / <cwd>/.kova/subagents）
 * + kv 里的启用开关；本页只渲染 useSubagents 镜像并发起变更命令。
 * 能力边界与 sidecar 对齐：内置只读（可查看/开关/复制为系统级）；系统/工作区
 * 可编辑可删除，工作区层随所选目录呈现。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import {
  buildModelOptions,
  groupModelOptions,
} from "@/lib/pi/pi-model-groups";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pathBasename } from "@/lib/workspace/workspace-store";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  deleteSubagent,
  refreshSubagents,
  setSubagentAvatar,
  setSubagentEnabled,
  setSubagentModel,
  useSubagents,
  type SubagentEntry,
} from "@/lib/subagent/subagents";
import { ReadonlyChips } from "./subagent-editor";
import { SubagentAvatarPicker } from "./subagent-avatar-picker";
import { SubagentAvatar } from "@/components/custom-ui/subagent-avatar";
import {
  SubagentEditorPage,
  type EditorTarget,
} from "./subagent-editor-page";
import { useT } from "@/lib/i18n";
import { ProjectScopeMenu } from "@/components/settings/components/project-scope-menu";

const MEMORY_LABEL: Record<string, string> = {
  none: "settings.subagents.memoryNone",
  private: "settings.subagents.memoryPrivate",
  shared: "settings.subagents.memoryShared",
};


// ---------------------------------------------------------------------------
// 编辑 / 查看弹窗
// ---------------------------------------------------------------------------

/** 内置定义的只读查看弹窗 */
const BuiltinViewDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: SubagentEntry | null;
  onCopy: (entry: SubagentEntry) => void;
}> = ({ open, onOpenChange, entry, onCopy }) => {
  const t = useT();
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SubagentAvatar name={entry.name} avatar={entry.avatar} className="size-7 rounded-lg" />
            {entry.name}
            <Badge variant="secondary" className="align-middle">
              {t("settings.subagents.builtinBadge")}
            </Badge>
          </DialogTitle>
          <DialogDescription>{entry.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5 text-[13px] leading-5">
          {entry.tools.map((tool) => (
            <span key={tool} className="bg-muted rounded-full px-2 py-0.5 font-mono">
              {tool}
            </span>
          ))}
          {entry.maxTurns !== undefined && (
            <span className="text-muted-foreground px-1">maxTurns: {entry.maxTurns}</span>
          )}
          {/* 内置定义自身不带 model，能出现在这里的只可能是 kv 里的本机覆盖 */}
          {entry.model && (
            <span className="text-muted-foreground px-1">
              {t("settings.subagents.modelPrefix", { model: entry.model })}
            </span>
          )}
          {entry.memory && entry.memory !== "none" && (
            <span className="text-muted-foreground px-1">
              {t("settings.subagents.memoryPrefix", {
                memory: t(MEMORY_LABEL[entry.memory] ?? MEMORY_LABEL.none),
              })}
            </span>
          )}
        </div>
        {/* 能力授予维度只读展示：内置不可编辑，但必须看得见自己有哪些能力——
            否则"为什么这个 agent 够不到我的 Notion"无从排查 */}
        <div className="flex flex-col gap-1.5">
          <ReadonlyChips label={t("settings.subagents.skillLabel")} items={entry.skills ?? []} />
          <ReadonlyChips label={t("settings.subagents.mcpLabel")} items={entry.mcpServers ?? []} mono />
          <ReadonlyChips
            label={t("settings.subagents.knowledgeLabel")}
            items={(entry.knowledge ?? []).map(
              (k) => `${k.name} ${k.path}`,
            )}
            mono
          />
        </div>
        <pre className="bg-muted/50 max-h-80 overflow-y-auto rounded-xl p-4 text-[13px] leading-5 whitespace-pre-wrap">
          {entry.prompt}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("settings.subagents.close")}
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onCopy(entry);
            }}
          >
            <CopyIcon className="size-3.5" />
            {t("settings.subagents.copyAsSystem")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 行内模型控件
// ---------------------------------------------------------------------------

/** 「跟随会话」的哨兵 id：空串在 cmdk 里语义不干净，用一个不会撞上 provider/modelId 的值 */
const FOLLOW_SESSION_ID = "__follow_session__";

/**
 * 子智能体的模型选择器。只读层（内置/插件）唯一的改模型入口——它们的定义永不落盘，
 * 选中的值存进 sidecar kv 的覆盖层；可编辑层的模型在编辑弹窗的输入框里改，
 * 不在这里给第二套持久化路径。
 *
 * 交互与同行的启用开关同款：改即存，不进弹窗。
 */
const SubagentModelControl: FC<{
  /** 当前生效的 "provider/modelId"；空 = 跟随会话模型 */
  value: string | undefined;
  onChange: (model: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const allModels = usePiModels();
  // 与对话页选择器同口径：没配凭据的服务不出现，被过滤隐藏的模型也不出现
  const models = useMemo(
    () => allModels.filter((m) => m.authed && m.enabled !== false),
    [allModels],
  );
  const options = useMemo(() => buildModelOptions(models), [models]);
  const groups = useMemo(
    () => groupModelOptions(models, options),
    [models, options],
  );

  const followSession: ModelOption = {
    id: FOLLOW_SESSION_ID,
    name: t("settings.subagents.followSession"),
    description: t("settings.subagents.followSessionDesc"),
  };
  const selectedId = value || FOLLOW_SESSION_ID;
  // 覆盖的模型可能已从目录里删掉（服务被移除），回落显示原始键而不是空占位
  const selectedLabel =
    selectedId === FOLLOW_SESSION_ID
      ? t("settings.subagents.followSession")
      : (options.find((o) => o.id === selectedId)?.name ?? selectedId);

  return (
    <ModelSelectorRoot
      models={[followSession, ...options]}
      value={selectedId}
      onValueChange={(v) => onChange(v === FOLLOW_SESSION_ID ? "" : v)}
      onOpenChange={(open) => open && refreshPiModels()}
    >
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 max-w-56 rounded-full text-[13px] leading-5 max-2xl:px-2"
        title={selectedLabel}
      >
        <span className="truncate">{selectedLabel}</span>
      </ModelSelectorTrigger>
      <ModelSelectorContent searchable className="w-80">
        <ModelSelectorSearch placeholder={t("settings.subagents.searchModels")} />
        <ModelSelectorList>
          <ModelSelectorEmpty>
            {t("settings.subagents.noModels")}
          </ModelSelectorEmpty>
          <ModelSelectorGroup>
            <ModelSelectorItem model={followSession} />
          </ModelSelectorGroup>
          {groups.map((group) => (
            <ModelSelectorGroup
              key={group.title}
              heading={group.title}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[13px] leading-5 [&_[cmdk-group-heading]]:font-medium"
            >
              {group.options.map((o) => (
                <ModelSelectorItem key={o.id} model={o} />
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
};

// ---------------------------------------------------------------------------
// 列表行
// ---------------------------------------------------------------------------

const SubagentRow: FC<{
  entry: SubagentEntry;
  workspaceCwd: string | null;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onModelChange: (model: string) => void;
  onAvatarChange: (avatar: string) => void;
}> = ({
  entry,
  workspaceCwd,
  confirmingDelete,
  onToggle,
  onView,
  onEdit,
  onCopy,
  onDelete,
  onConfirmDelete,
  onModelChange,
  onAvatarChange,
}) => {
  const t = useT();
  const relPath = entry.path
    ? entry.scope === "workspace" &&
      workspaceCwd &&
      entry.path.startsWith(workspaceCwd + "/")
      ? entry.path.slice(workspaceCwd.length + 1)
      : entry.path
    : null;
  return (
    <div className="group bg-background hover:border-foreground/20 hover:bg-muted/20 flex flex-col rounded-xl border transition-colors">
      <div className="relative flex items-start gap-4 px-3 py-4">
        {/* 头像即选择器入口：没设头像时回落名称散列色块 + Bot 图标（内置条目也能彼此区分） */}
        <SubagentAvatarPicker
          name={entry.name}
          avatar={entry.avatar}
          className="size-10"
          onChange={onAvatarChange}
        />

        <div className="min-w-0 flex-1">
          <div className="pr-10">
            <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-base font-medium">{entry.name}</span>
            {entry.enabled && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                title={t("settings.subagents.active")}
                aria-label={t("settings.subagents.active")}
              />
            )}
          </div>
          <p className="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-5">
            {entry.description || t("settings.subagents.noDescription")}
          </p>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            {entry.editable ? (
              <span className="text-muted-foreground/80 min-w-0 max-w-56 truncate text-[13px] leading-5">
                {t("settings.subagents.modelLabel", {
                  model: entry.model ?? t("settings.subagents.followSession"),
                })}
              </span>
            ) : (
              <SubagentModelControl value={entry.model} onChange={onModelChange} />
            )}
            {relPath && (
              <span
                className="text-muted-foreground hidden min-w-0 flex-1 truncate font-mono text-3xs sm:block"
                title={entry.path ?? undefined}
              >
                {relPath}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {!entry.editable && (
                <Button variant="ghost" size="icon" className="size-7" onClick={onView} title={t("settings.subagents.viewDefinition")}>
                  <EyeIcon className="size-3.5" />
                </Button>
              )}
              {entry.editable ? (
                <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title={t("settings.subagents.edit")}>
                  <PencilIcon className="size-3.5" />
                </Button>
              ) : (
                <Button variant="ghost" size="icon" className="size-7" onClick={onCopy} title={t("settings.subagents.copyAsSystem")}>
                  <CopyIcon className="size-3.5" />
                </Button>
              )}
              {entry.editable &&
                (confirmingDelete ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-[13px] leading-5"
                    onClick={onConfirmDelete}
                  >
                    <CheckIcon className="size-3.5" />
                    {t("settings.subagents.confirmDelete")}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7"
                    onClick={onDelete}
                    title={t("settings.subagents.delete")}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ))}
            </div>
          </div>
        </div>

        <Switch
          className="absolute top-4 right-3"
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={t("settings.subagents.enableAria", { name: entry.name })}
        />
      </div>

    </div>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区范围选择器：只列项目/工作区（含新建入口）。
 *  只切换本页查看的工作区级定义来源，不改动主界面的工作区选择。 */
export const SubagentsSettings: FC<{
  /** 编辑态上抛：父级（MarketplaceView）据此收掉自己的顶栏。
   *  不收会撞出两个「返回」——外层那个退出整个管理页，内层这个只返回列表，
   *  语义不同却长一样，用户点哪个全凭运气。 */
  onEditingChange?: (editing: boolean) => void;
  /** 嵌入管理页（应用顶栏承载页面身份）：不再重复大标题/外层留白 */
  embedded?: boolean;
}> = ({ onEditingChange, embedded = false }) => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
  // 工作区级区块允许浏览任意目录：overrideCwd 为 null 时跟随主界面当前工作区，
  // 手动切换/浏览仅改变本页查看与增删改的目标目录，不影响主界面选择。
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useSubagents(viewingCwd);
  // 编辑目标（非空即处于编辑态，容器渲染编辑器而非列表）
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [viewing, setViewing] = useState<SubagentEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** 应用顶栏槽位：编辑器打开时把「返回」提到左上角（与 MCP/技能管理页同款） */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /** 编辑器保存中：顶栏返回键同步禁用，避免保存途中退出 */
  const [editorBusy, setEditorBusy] = useState(false);
  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

  // 编辑态同步给父级（卸载时也上报一次 false，避免切走页面后顶栏一直藏著）
  useEffect(() => {
    onEditingChange?.(editorTarget !== null);
  }, [editorTarget, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);

  const groups = useMemo(
    () => ({
      builtin: snap.agents.filter((e) => e.scope === "builtin"),
      system: snap.agents.filter((e) => e.scope === "system"),
      workspace: snap.agents.filter((e) => e.scope === "workspace"),
    }),
    [snap.agents],
  );

  const toggle = (entry: SubagentEntry, enabled: boolean) => {
    void setSubagentEnabled(entry.scope, entry.name, enabled, viewingCwd).catch(() => {});
  };

  const remove = (entry: SubagentEntry) => {
    const scope = entry.scope === "workspace" ? "workspace" : "system";
    void deleteSubagent(scope, entry.name, viewingCwd).catch(() => {});
    setConfirmDelete(null);
  };

  /** 模型覆盖落 kv；失败已由 mutate 记到 snap.error，这里不重复处理 */
  const changeModel = (entry: SubagentEntry, model: string) => {
    void setSubagentModel(entry.scope, entry.name, model, viewingCwd, entry.pluginId).catch(
      () => {},
    );
  };

  /** 头像与模型覆盖同一条 kv 链路（空串 = 恢复默认） */
  const changeAvatar = (entry: SubagentEntry, avatar: string) => {
    void setSubagentAvatar(entry.scope, entry.name, avatar, viewingCwd, entry.pluginId).catch(
      () => {},
    );
  };

  const switchWorkspaceView = (dir: string) =>
    setOverrideCwd(dir === workspace ? null : dir);

  // 同步上报编辑态：父级同一帧收掉管理页顶栏，避免与顶栏返回键短暂并存
  const openEditor = (target: EditorTarget) => {
    setEditorTarget(target);
    onEditingChange?.(true);
  };
  const closeEditor = () => {
    setEditorTarget(null);
    onEditingChange?.(false);
  };

  const renderSection = (
    title: string,
    desc: string,
    entries: SubagentEntry[],
    actions?: ReactNode,
    empty?: ReactNode,
  ) => (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
          <span className="text-muted-foreground/80 min-w-0 text-[13px] leading-5">{desc}</span>
        </div>
        {actions}
      </div>
      {/* 列表：两列自适应行式（无外框，行间细分隔线） */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(480px,1fr))] gap-3">
        {entries.length === 0 ? (
          <div className="text-muted-foreground col-span-full rounded-2xl border border-dashed px-4 py-6 text-sm">
            {empty ?? t("settings.subagents.empty")}
          </div>
        ) : (
          entries.map((entry) => (
            <SubagentRow
              key={`${entry.scope}:${entry.name}`}
              entry={entry}
              workspaceCwd={snap.workspaceCwd}
              confirmingDelete={confirmDelete === `${entry.scope}:${entry.name}`}
              onToggle={(enabled) => toggle(entry, enabled)}
              onView={() => setViewing(entry)}
              onEdit={() => openEditor({ mode: "edit", entry })}
              onCopy={() => openEditor({ mode: "copy", entry })}
              onDelete={() => setConfirmDelete(`${entry.scope}:${entry.name}`)}
              onConfirmDelete={() => remove(entry)}
              onModelChange={(model) => changeModel(entry, model)}
              onAvatarChange={(avatar) => changeAvatar(entry, avatar)}
            />
          ))
        )}
      </div>
    </section>
  );

  // 编辑态：整页换成编辑器（与列表同一容器，返回即回到原处）
  if (editorTarget) {
    return (
      <>
        {headerSlot
          ? createPortal(
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground shrink-0 gap-1"
                onClick={closeEditor}
                disabled={editorBusy}
              >
                <ChevronLeftIcon className="size-4" />
                {t("settings.subagents.back")}
              </Button>,
              headerSlot,
            )
          : null}
        <div className={cn("h-full min-h-0", !embedded && "py-4")}>
          <SubagentEditorPage
            target={editorTarget}
            workspaceCwd={viewingCwd}
            grantableTools={snap.grantableTools}
            onBack={closeEditor}
            hideBack={headerSlot !== null}
            onBusyChange={setEditorBusy}
            renderModelControl={(value, onChange) => (
              <SubagentModelControl value={value} onChange={onChange} />
            )}
          />
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div
        className={cn(
          "flex w-full flex-col",
          embedded ? "gap-5 py-0" : "max-w-5xl gap-8 self-center px-0 py-8",
        )}
      >
        {/* 标题行：嵌入管理页时身份在应用顶栏，这里不再重复大标题（资料库同款） */}
        {!embedded && (
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.subagents.title")}</h1>
            <span
              className={cn("text-[13px] leading-5", snap.error ? "text-destructive" : "text-muted-foreground")}
            >
              {snap.error
                ? t("settings.subagents.loadFailedShort")
                : t("settings.subagents.count", {
                    count: snap.agents.length,
                    enabled: snap.agents.filter((e) => e.enabled).length,
                  })}
            </span>
          </div>
        )}

        {/* 工具行：说明文字 + 刷新/新建（技能/MCP 工具行同款位置） */}
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">
            {t("settings.subagents.description")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => void refreshSubagents(viewingCwd)}
              aria-label={t("settings.subagents.refresh")}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button className="h-8 shrink-0 gap-1.5" />}
              >
                <PlusIcon className="size-4" />
                {t("settings.subagents.new")}
                <ChevronDownIcon className="size-3.5 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem
                  onClick={() => openEditor({ mode: "create", scope: "system" })}
                >
                  {t("settings.subagents.scopeSystem")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!viewingCwd}
                  onClick={() => openEditor({ mode: "create", scope: "workspace" })}
                  title={viewingCwd ? undefined : t("settings.subagents.pickWorkspaceFirst")}
                >
                  {t("settings.subagents.scopeWorkspace")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 清单加载失败：镜像停留在旧值，明确提示并可重试（MCP 错误块同款样式） */}
        {snap.error && (
          <div className="text-destructive bg-destructive/5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 px-3 py-2.5 text-sm">
            <span>{t("settings.subagents.loadFailed", { error: snap.error })}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshSubagents(viewingCwd)}
            >
              {t("settings.subagents.retry")}
            </Button>
          </div>
        )}

        {renderSection(
          t("settings.subagents.sectionBuiltin"),
          t("settings.subagents.sectionBuiltinDesc"),
          groups.builtin,
        )}
        {renderSection(
          t("settings.subagents.sectionSystem"),
          t("settings.subagents.sectionSystemDesc"),
          groups.system,
        )}
        {renderSection(
          viewingCwd
            ? t("settings.subagents.sectionWorkspaceNamed", { name: pathBasename(viewingCwd) })
            : t("settings.subagents.sectionWorkspace"),
          viewingCwd
            ? t("settings.subagents.sectionWorkspaceDesc", { cwd: viewingCwd })
            : t("settings.subagents.sectionWorkspaceNoCwd"),
          groups.workspace,
          <ProjectScopeMenu
            value={viewingCwd}
            following={overrideCwd === null}
            onChange={switchWorkspaceView}
            onFollowCurrent={() => setOverrideCwd(null)}
          />,
          viewingCwd
            ? undefined
            : t("settings.subagents.workspaceEmptyNoCwd"),
        )}

        {/* 加载诊断：琥珀色告警面板，折叠放置，不与清单争视觉（坏文件警告不致命） */}
        {snap.diagnostics.length > 0 && (
          <details className="group border-amber-500/20 bg-amber-500/5 overflow-hidden rounded-xl border text-[13px] leading-5">
            <summary className="hover:bg-amber-500/10 flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 transition-colors [&::-webkit-details-marker]:hidden">
              <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-foreground font-medium">{t("settings.subagents.diagnostics")}</span>
              <Badge
                variant="secondary"
                className="bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1.5 py-0 text-3xs font-medium"
              >
                {snap.diagnostics.length}
              </Badge>
              <ChevronRightIcon className="text-muted-foreground/70 ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-90" />
            </summary>
            <ul className="border-amber-500/15 flex flex-col gap-1.5 border-t px-3.5 py-3">
              {snap.diagnostics.map((d) => (
                <li
                  key={d}
                  className="bg-background/70 border-amber-500/10 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2"
                >
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500/70" />
                  <span className="min-w-0 font-mono text-[13px] leading-5 break-all">{d}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <BuiltinViewDialog
          open={viewing !== null}
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          entry={viewing}
          onCopy={(entry) => openEditor({ mode: "copy", entry })}
        />
      </div>
    </div>
  );
};
