"use client";

/**
 * 自动化任务详情面板（内联编辑器，不再走弹窗）：右侧详情区即表单本体——
 * 头部是「名称输入框 + 主操作（重置/立即运行/保存）」，其下一条元信息行
 * （启用开关 + ⋯ 菜单）；执行指令输入框与会话 composer 同一张玻璃卡皮，
 * 工作空间/权限档/模型胶囊在输入框内的动作行（composer 同位）。已有任务多
 * 一页「运行记录」页签。全量覆盖语义不变：保存时提交完整记录，未填字段即清空。
 *
 * 触发统一在一节「触发」（统一触发模型 P1）：定时与事件（webhook/file/git/im）
 * 同列表，新建任务也走「添加触发器」——定时是其中一种档位（每任务至多一条），
 * 排期表单在卡片内联编辑；事件触发器先攒草稿（任务还没有 id），保存任务时
 * sidecar 一并落库。排期启停即任务启停。排期每次改动防抖拉 automation_preview
 * （sidecar 真算，本地时区），下几次触发时刻与调度器判定完全同源。
 *
 * 工作空间/权限档/模型胶囊只借用输入框的选择器构件（ModelSelector 本身会话
 * 无关），全部受控于任务字段——真嵌 ComposerPrimitive/Lexical/ModePicker 会
 * 把编辑动作泄漏到当前会话的草稿与会话偏好，故不做。新任务的目录默认落在
 * 当前对话选的工作区。
 */

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import {
  EraserIcon,
  FolderOpenIcon,
  CheckIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  MoreHorizontalIcon,
  PlayIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { AutomationPromptField } from "./automation-prompt-field";
import TriggerManager, { type DraftTrigger } from "./trigger-dialog";
import { EVENT_ONLY_CRON } from "@/lib/automation/triggers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  buildModelOptions,
  groupModelOptions,
  modelOptionId,
  splitModelOptionId,
} from "@/lib/pi/pi-model-groups";
import {
  getWorkspace,
  pathBasename,
} from "@/lib/workspace/workspace-store";
import {
  saveAutomation,
  type AutomationDraft,
  type AutomationTask,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import { usePiModels, refreshPiModels } from "@/lib/pi/pi-models";
import {
  projectDisplayName,
  projectPrimaryPath,
  sameProjectPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 权限档 → composer ModePicker 同款外观的胶囊选项（计划模式对无人值守不成立，不提供） */
const POLICY_META: Record<
  AutomationDraft["toolPolicyProfile"],
  { labelKey: string; descKey: string; icon: LucideIcon; warning?: boolean }
> = {
  "read-only": {
    labelKey: "automation.editor.policyReadOnly",
    descKey: "automation.editor.policyReadOnlyDesc",
    icon: HandIcon,
  },
  "workspace-write": {
    labelKey: "automation.editor.policyWorkspace",
    // 与底栏「工作区内自动」同名不同义：那个按路径判（能判断目标在不在工作区），
    // 这个按工具类别判（没人可问，只能一刀切）。描述里点破，免得看名字就选错
    descKey: "automation.editor.policyWorkspaceDesc",
    icon: SquarePenIcon,
  },
  full: {
    labelKey: "automation.editor.policyFull",
    descKey: "automation.editor.policyFullDesc",
    icon: LockOpenIcon,
    warning: true,
  },
};
const POLICY_ORDER: AutomationDraft["toolPolicyProfile"][] = [
  "read-only",
  "workspace-write",
  "full",
];

/** composer 触发钮同款外观（h-7 胶囊 + 图标 + 截断文字） */
const pillTriggerClass = (active: boolean, warning = false): string =>
  cn(
    "hover:bg-muted inline-flex h-7 min-w-0 max-w-56 items-center gap-1 rounded-full px-2.5 text-sm transition-colors",
    active ? "bg-muted/50 hover:bg-muted" : "",
    warning ? "text-red-600 dark:text-red-400" : "text-muted-foreground hover:text-foreground",
  );

/** 工作空间胶囊：与 composer 的工作空间菜单同一套结构——
 *  全部工作区（项目主目录）+ 搜索过滤 + 当前值兜底。
 *  每条解析成项目：名称 + 父目录提示，选中时同时写 projectId。 */
const TaskWorkspacePill: FC<{
  value: string;
  projectId?: string;
  onChange: (v: string, projectId?: string) => void;
}> = ({ value, projectId, onChange }) => {
  const t = useT();
  const projects = useProjectRegistry();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // 已移除项目不再作为新任务的可选项；编辑旧任务时保留它当前绑定的项目
  const activeProjects = projects.filter(
    (project) =>
      !project.archived &&
      (!project.hiddenFromSidebar || project.id === projectId),
  );
  const findProjectForDir = (dir: string) =>
    projectId && sameProjectPath(value, dir)
      ? activeProjects.find((project) => project.id === projectId)
      : activeProjects.find((project) =>
          sameProjectPath(projectPrimaryPath(project), dir),
        );

  type Entry = {
    key: string;
    path: string;
    projectId?: string;
    label: string;
    hint: string;
  };
  const entryFor = (dir: string): Entry => {
    const project = findProjectForDir(dir);
    const isPrimary = project
      ? sameProjectPath(projectPrimaryPath(project), dir)
      : false;
    return {
      key: `${project?.id ?? "dir"}:${dir}`,
      path: dir,
      ...(project ? { projectId: project.id } : {}),
      label: project
        ? isPrimary
          ? projectDisplayName(project)
          : pathBasename(dir)
        : pathBasename(dir),
      hint:
        project && !isPrimary
          ? projectDisplayName(project)
          : dir.split(/[\\/]/u).filter(Boolean).slice(-2).join("/"),
    };
  };
  // 全部工作区 = 每个项目的主目录一行（附加目录归在同一项目下，不单列）
  const entries: Entry[] = activeProjects.map((project) =>
    entryFor(projectPrimaryPath(project)),
  );
  // 当前值可能来自任务原有配置或在某个附加目录里：补在顶部保证有勾选行
  if (value && !entries.some((entry) => sameProjectPath(entry.path, value))) {
    entries.unshift(entryFor(value));
  }
  const needle = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(
    (entry) =>
      !needle ||
      entry.label.toLocaleLowerCase().includes(needle) ||
      entry.path.toLocaleLowerCase().includes(needle),
  );

  const selectedProject = projectId
    ? activeProjects.find((project) => project.id === projectId)
    : undefined;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={value || t("automation.editor.workspaceEmptyHint")}
            aria-label={t("automation.editor.workspaceAria")}
            className={pillTriggerClass(!!value)}
          >
            <FolderOpenIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {selectedProject
                ? projectDisplayName(selectedProject)
                : value
                  ? pathBasename(value)
                  : t("automation.editor.selectDir")}
            </span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-[21rem] p-0">
        <DropdownMenuGroup className="p-0">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-0 ring-0 bg-transparent focus-visible:outline-none focus-visible:ring-0"
            placeholder={t("automation.editor.searchWorkspace")}
          />
          <DropdownMenuSeparator className="mt-0" />
          <div className="px-1 pb-1">
            {visibleEntries.length > 0 ? (
              visibleEntries.map((entry) => {
                const active = sameProjectPath(entry.path, value);
                return (
                  <DropdownMenuItem
                    key={entry.key}
                    closeOnClick={false}
                    title={entry.path}
                    onClick={() => onChange(entry.path, entry.projectId)}
                    className="gap-2 pe-2"
                  >
                    {active ? (
                      <CheckIcon className="text-primary size-3.5 shrink-0" />
                    ) : (
                      <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {entry.label}
                    </span>
                    <span className="text-muted-foreground max-w-40 shrink-0 truncate text-end font-mono text-2xs">
                      {entry.hint}
                    </span>
                  </DropdownMenuItem>
                );
              })
            ) : (
              <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                {t("automation.editor.noRecentDirs")}
              </div>
            )}
          </div>
        </DropdownMenuGroup>
        {value && (
          <>
            <DropdownMenuSeparator />
            <div className="px-1 pb-1">
              <DropdownMenuItem onClick={() => onChange("")}>
                <XIcon className="text-muted-foreground size-3.5 shrink-0" />
                {t("automation.editor.clearDir")}
              </DropdownMenuItem>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 权限档胶囊：ModePicker 同款下拉形态，三档无人值守语义（存 task.toolPolicyProfile） */
const PolicyPill: FC<{
  value: AutomationDraft["toolPolicyProfile"];
  onChange: (v: AutomationDraft["toolPolicyProfile"]) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = POLICY_META[value];
  const currentLabel = t(current.labelKey);
  const currentDesc = t(current.descKey);
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={currentDesc}
            aria-label={t("automation.editor.policyAria")}
            className={pillTriggerClass(false, current.warning)}
          >
            <CurrentIcon className="size-3.5 shrink-0" />
            <span>{currentLabel}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          {POLICY_ORDER.map((k) => {
            const o = POLICY_META[k];
            return (
              <DropdownMenuItem
                key={k}
                onClick={() => {
                  onChange(k);
                  setOpen(false);
                }}
                className="gap-2.5 py-2"
              >
                <o.icon className={cn("size-4 shrink-0", o.warning ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} />
                <div className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      o.warning && k === value && "text-red-600 dark:text-red-400",
                    )}
                  >
                    {t(o.labelKey)}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">{t(o.descKey)}</span>
                </div>
                {k === value && <CheckIcon className="ml-auto size-4 shrink-0" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 模型胶囊：复用 composer 的 ModelSelector（会话无关，受控于任务字段）。
 *  "跟随全局默认"以伪选项身份进列表——运行时 runner 解析不到即用默认模型。
 *  选项/分组与 composer、设置页同源（pi-model-groups），mark 口径见 provider-brand。 */
const FOLLOW_ID = "follow";
const TaskModelPill: FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const t = useT();
  const followOption = useMemo<ModelOption>(
    () => ({
      id: FOLLOW_ID,
      name: t("automation.editor.followModel"),
      description: t("automation.editor.followModelDesc"),
    }),
    [t],
  );
  const models = usePiModels();
  // 与 composer 选择器同规则：只列已配置凭据且未被禁用的模型
  const list = useMemo(
    () => models.filter((m) => m.authed && m.enabled !== false),
    [models],
  );
  const byId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of list) map.set(modelOptionId(m), m.name || m.id);
    return map;
  }, [list]);
  const options = useMemo<ModelOption[]>(
    () => [followOption, ...buildModelOptions(list)],
    [followOption, list],
  );
  // "跟随全局默认"是伪选项，不进分组（没有服务可挂）
  const groups = useMemo(
    () =>
      groupModelOptions(
        list,
        options.filter((o) => o.id !== FOLLOW_ID),
      ),
    [options, list],
  );
  const selectedLabel =
    value === FOLLOW_ID
      ? t("automation.editor.followGlobal")
      : (byId.get(value) ?? (value || t("automation.editor.chooseModel")));
  // "跟随全局默认"没有具体模型可挂 mark，只显示文字
  const selectedModel =
    value === FOLLOW_ID ? undefined : splitModelOptionId(value);
  return (
    <ModelSelector.Root models={options} value={value} onValueChange={onChange}>
      <ModelSelector.Trigger
        variant="ghost"
        size="sm"
        className={cn(pillTriggerClass(value !== FOLLOW_ID), "max-w-48 [&>span]:min-w-0")}
        title={selectedLabel}
      >
        {selectedModel && (
          <ProviderIcon
            provider={selectedModel.provider}
            modelId={selectedModel.modelId}
            providerName={
              list.find((m) => modelOptionId(m) === value)?.providerName
            }
          />
        )}
        <span className="truncate">{selectedLabel}</span>
      </ModelSelector.Trigger>
      <ModelSelector.Content searchable className="w-80">
        <ModelSelector.Search placeholder={t("automation.editor.searchModels")} />
        <ModelSelector.List>
          <ModelSelector.Item model={followOption} />
          <ModelSelector.Empty>{t("automation.editor.noModels")}</ModelSelector.Empty>
          {groups.map((group) => (
            <ModelSelector.Group
              key={group.title}
              heading={group.title}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
            >
              {group.options.map((o) => (
                <ModelSelector.Item key={o.id} model={o} />
              ))}
            </ModelSelector.Group>
          ))}
        </ModelSelector.List>
      </ModelSelector.Content>
    </ModelSelector.Root>
  );
};

export const AutomationEditorPane: FC<{
  /** null = 新建 */
  task: AutomationTask | null;
  /** 从模板新建（与 task 互斥） */
  template?: AutomationTemplate | null;
  /** 已有任务时的「运行记录」页签内容；不传则只有设置一页 */
  historyTab?: ReactNode;
  /** 立即运行进行中（头部按钮禁用态） */
  running?: boolean;
  onRunNow?: () => void;
  onSaved: () => void;
  /** 新建态的取消（回模板选择页） */
  onCancel?: () => void;
  /** 已有任务：放弃本面板上的未保存修改（父层按 key 重建表单） */
  onReset?: () => void;
  onRequestClearHistory?: () => void;
  onRequestDelete?: () => void;
}> = ({
  task,
  template,
  historyTab,
  running,
  onRunNow,
  onSaved,
  onCancel,
  onReset,
  onRequestClearHistory,
  onRequestDelete,
}) => {
  const t = useT();
  const [name, setName] = useState(task?.name ?? template?.name ?? "");
  const [description, setDescription] = useState(task?.description ?? template?.description ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? template?.prompt ?? "");
  // 新任务/模板默认落在当前对话选的工作区（"composer 同款"的落点）；编辑保留任务原值
  const [workspaceDir, setWorkspaceDir] = useState(
    task ? (task.workspaceDir ?? "") : (getWorkspace() ?? ""),
  );
  const [projectId, setProjectId] = useState<string | undefined>(
    task?.projectId,
  );
  const [policy, setPolicy] = useState<AutomationDraft["toolPolicyProfile"]>(() => {
    const p = task?.toolPolicyProfile ?? template?.toolPolicyProfile;
    // 镜像类型里 toolPolicyProfile 是宽 string（sidecar 侧才收窄），三档外一律回默认
    return p === "workspace-write" || p === "full" ? p : "read-only";
  });
  const [modelSel, setModelSel] = useState(
    task?.model?.provider && task?.model?.model
      ? `${task.model.provider}/${task.model.model}`
      : FOLLOW_ID,
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  // 新建任务：触发器草稿（任务还没有 id，保存时随任务一并提交）。
  // 模板自带排期时先种一条 schedule 草稿，其余在「触发」一节里添加
  const [draftTriggers, setDraftTriggers] = useState<DraftTrigger[]>(() =>
    template
      ? [
          {
            key: "draft-template-schedule",
            type: "schedule" as const,
            config: { type: "schedule", scheduleType: template.type, schedule: template.schedule },
          },
        ]
      : [],
  );
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // 挂载即刷新模型目录（凭据/过滤可能在设置里改过）
  useEffect(() => {
    refreshPiModels();
  }, []);

  const hasHistoryTab = !!task && !!historyTab;
  const showingHistory = hasHistoryTab && tab === "history";

  const submit = async () => {
    if (!prompt.trim()) {
      setFormError(t("automation.editor.errorPrompt"));
      setTab("settings");
      return;
    }
    // 已有任务的排期事实源在 schedule 触发器（sidecar 保存时一律沿用任务记录上的
    // 排期，忽略表单值，避免旧快照把已改/已删的排期写回）；这里带上记录值只为满足
    // 草稿形状。新建任务仍取触发器草稿，没有排期 = 纯事件任务（P2），用哨兵 cron 占位。
    const draftSchedule = draftTriggers.find((d) => d.type === "schedule");
    const built = task
      ? { type: task.type, schedule: task.schedule }
      : draftSchedule
        ? {
            type: (draftSchedule.config.scheduleType ?? "cron") as "cron" | "once" | "interval",
            schedule: String(draftSchedule.config.schedule ?? ""),
          }
        : { type: "cron" as const, schedule: EVENT_ONLY_CRON };
    const sep = modelSel.indexOf("/");
    const model =
      modelSel === FOLLOW_ID || sep <= 0
        ? { provider: "", model: "" }
        : {
            provider: modelSel.slice(0, sep),
            model: modelSel.slice(sep + 1),
          };
    const draft: AutomationDraft = {
      ...(task ? { id: task.id } : {}),
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      prompt: prompt.trim(),
      type: built.type,
      schedule: built.schedule,
      enabled,
      model,
      toolPolicyProfile: policy,
      workspaceDir: workspaceDir.trim() || undefined,
      ...(projectId ? { projectId } : {}),
      // 新建任务：事件触发器草稿随任务一起提交（sidecar 建完任务后落库）；
      // 已有任务走「触发」里的实时增删改，不经表单
      ...(!task && draftTriggers.length > 0
        ? { triggers: draftTriggers.map(({ type, config }) => ({ type, config })) }
        : {}),
    };
    setSaving(true);
    setFormError("");
    try {
      await saveAutomation(draft);
      toast.add({
        type: "success",
        title: task ? t("automation.editor.toastUpdated") : t("automation.editor.toastCreated"),
        description: name.trim() || prompt.slice(0, 30),
      });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
      toast.add({ type: "error", title: t("automation.editor.toastSaveFailed"), description: msg });
    } finally {
      setSaving(false);
    }
  };

  const policyHint = t(POLICY_META[policy].descKey);

  return (
    // 注意不能是 <form>：指令输入框里的 composer（ComposerPrimitive.Root）
    // 自身渲染 <form>，HTML 不允许表单嵌套（会触发 React 水合报错）。
    // 保存按钮改为显式调用 submit()
    <div
      className="flex h-full min-h-0 flex-col"
    >
      {/* 头部：名称输入框 + 主操作；元信息行；已有任务多一排页签。
          内容列 max-w-5xl 居中（monocode 编辑器同款），头部横线通栏 */}
      <div className="shrink-0 ">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2.5 px-6 pt-10 md:px-8">
          <div className="flex items-center gap-3">
            <input
              aria-label={t("automation.editor.nameLabel")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("automation.editor.namePlaceholder")}
              spellCheck={false}
              autoComplete="off"
              className="text-foreground min-w-0 flex-1 rounded-none bg-transparent text-lg font-semibold leading-tight outline-none placeholder:text-muted-foreground/50 "
            />
            <div className="flex shrink-0 items-center gap-1.5">
              {task && onReset ? (
                <Button type="button" variant="ghost" onClick={onReset}>
                  {t("automation.view.resetEditor")}
                </Button>
              ) : null}
              {task && onRunNow ? (
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  disabled={running}
                  onClick={onRunNow}
                >
                  {running ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlayIcon className="size-3.5" />
                  )}
                  {t("automation.view.runNow")}
                </Button>
              ) : null}
                {!task && onCancel ? (
                <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
                  {t("automation.view.cancel")}
                </Button>
              ) : null}
              <Button type="button" onClick={() => void submit()} disabled={saving}>
                {saving && <Loader2Icon className="size-3.5 animate-spin" />}
                {task ? t("automation.editor.save") : t("automation.editor.create")}
              </Button>
            
            </div>
          </div>

          {/* 元信息行：启用开关 + 工作空间胶囊 + ⋯ 菜单；权限/模型胶囊留在
              指令输入框内的动作行（composer 的动作行同位） */}
          <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 pb-2.5 text-xs">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("automation.editor.enableAria")}
            />
            <span className={cn(enabled ? "text-foreground" : "")}>
              {enabled ? t("automation.view.activeLabel") : t("automation.view.paused")}
            </span>
            <TaskWorkspacePill
              value={workspaceDir}
              projectId={projectId}
              onChange={(dir, nextProjectId) => {
                setWorkspaceDir(dir);
                setProjectId(nextProjectId);
              }}
            />

            {(onRequestClearHistory || onRequestDelete) && (
              <span className="text-muted-foreground ml-auto flex min-w-0 items-center gap-1">
                {onRequestDelete ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0"
                          aria-label={t("automation.view.moreActions")}
                        >
                          <MoreHorizontalIcon className="size-3.5" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="w-44">
                      {onRequestClearHistory && (
                        <DropdownMenuItem
                          disabled={(task?.runHistory?.length ?? 0) === 0}
                          onClick={onRequestClearHistory}
                        >
                          <EraserIcon className="size-4" />
                          {t("automation.view.clearHistory")}
                        </DropdownMenuItem>
                      )}
                      {onRequestDelete && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={onRequestDelete}>
                            <Trash2Icon className="size-4" />
                            {t("automation.view.deleteTask")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </span>
            )}
          </div>

          {hasHistoryTab && (
            <div className="pb-2">
              <Segmented<"settings" | "history">
                value={tab}
                className="w-fit"
                options={[
                  { value: "settings", label: t("automation.view.tabSettings") },
                  { value: "history", label: t("automation.view.tabHistory") },
                ]}
                onChange={setTab}
              />
            </div>
          )}
        </div>
      </div>

      {/* 表单错误就近显示（提交校验/保存失败），不随内容滚走 */}
      {formError && !showingHistory && (
        <div className="mx-auto w-full max-w-7xl shrink-0 px-6 md:px-8">
          <p role="alert" className="text-red-500 pt-3 text-xs">{formError}</p>
        </div>
      )}

      {showingHistory ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none">
          {historyTab}
        </div>
      ) : (
        // overflow-x-hidden：表单组件各自负责自己的横向空间（cron 编辑器窄窗换列），
        // 绝不让整张表单长出横向滚动条；内容列 max-w-5xl 居中
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 md:px-8 md:py-8">
          <div className="grid gap-2">
            <Label>{t("automation.editor.promptLabel")}</Label>
            {/* 直接复用聊天 composer 的输入组件与触发菜单（面板自己的本地受控值，
                不串会话草稿）：@ 选子智能体、/ 选技能与 MCP 工具。工作空间/权限档/
                模型胶囊进外壳底部的动作行（composer 的动作行同位；受控于任务字段，
                不碰会话偏好） */}
            <AutomationPromptField
              value={prompt}
              onChange={setPrompt}
              placeholder={t("automation.editor.promptPlaceholder")}
              footer={
                <>
                  <PolicyPill value={policy} onChange={setPolicy} />
                  <TaskModelPill value={modelSel} onChange={setModelSel} />
                </>
              }
            />
            <p className="text-muted-foreground text-xs">{policyHint}</p>
          </div>

          {/* 「触发」一节（统一触发模型 P1）：定时与事件触发器同列表。
              新建任务也走「添加触发器」（定时是其中一种档位）；事件触发器先攒
              草稿（任务还没有 id），保存任务时 sidecar 一并落库；已有任务直接
              联服务端增删改 */}
          <div className="grid gap-2">
            <Label>{t("automation.editor.triggerSection")}</Label>
            {task ? (
              <TriggerManager
                taskId={task.id}
                taskEnabled={enabled}
                onTaskEnabledChange={setEnabled}
              />
            ) : (
              <div className="grid gap-1.5">
                <TriggerManager
                  draftTriggers={draftTriggers}
                  onDraftTriggersChange={setDraftTriggers}
                />
                <p className="text-muted-foreground text-xs">
                  {t("automation.editor.initialScheduleHint")}
                </p>
              </div>
            )}
          </div>
          </div>
        </div>
      )}
    </div>
  );
};
