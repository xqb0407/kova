"use client";

/**
 * 自动化任务创建/编辑弹窗（M3.4）：全量覆盖语义 —— 保存时提交完整记录，
 * 未填字段即清空（sidecar 的 automation_save 对 name/description/workspaceDir
 * 用显式 undefined 删除，与表单"所见即全部"一致）。
 *
 * 频率表单不直接暴露 cron 语法：每天/每周/每月三档预设拼表达式，"自定义"档开
 * 结构化编辑器（custom-ui/cron-editor，逐字段点选，认不出的高级写法落原始输入）；
 * 每次改动防抖拉 automation_preview（sidecar 真算，本地时区），用户看到的下几次
 * 触发时刻与调度器判定完全同源。
 *
 * 执行指令下方是 composer 同款胶囊配置行（工作目录/权限档/模型）：只借用输入框
 * 的外观与选择器构件（ModelSelector 本身会话无关），全部受控于任务字段——
 * 真嵌 ComposerPrimitive/Lexical/ModePicker 会把编辑动作泄漏到当前会话的草稿与
 * 会话偏好，故不做。新任务的目录默认落在当前对话选的工作区。
 */

import { useEffect, useMemo, useState, type FC } from "react";
import {
  CalendarClockIcon,
  CheckIcon,
  FolderOpenIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  SquarePenIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CronEditor } from "@/components/custom-ui/cron-editor";
import { DateTimePicker } from "@/components/custom-ui/date-time-picker";
import { TimePicker } from "@/components/custom-ui/time-picker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { AutomationPromptField } from "./automation-prompt-field";
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
  previewAutomationSchedule,
  saveAutomation,
  type AutomationDraft,
  type AutomationTask,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import {
  cronToPreset,
  formatDateTime,
  parseIntervalSeconds,
  presetToCron,
} from "@/lib/automation/automation-format";
import { usePiModels, refreshPiModels } from "@/lib/pi/pi-models";
import {
  projectDisplayName,
  projectPrimaryPath,
  sameProjectPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type FreqMode = "daily" | "weekly" | "monthly" | "interval" | "once" | "cron";

const FREQ_LABEL_KEYS: { mode: FreqMode; labelKey: string }[] = [
  { mode: "daily", labelKey: "automation.editor.freqDaily" },
  { mode: "weekly", labelKey: "automation.editor.freqWeekly" },
  { mode: "monthly", labelKey: "automation.editor.freqMonthly" },
  { mode: "interval", labelKey: "automation.editor.freqInterval" },
  { mode: "once", labelKey: "automation.editor.freqOnce" },
  { mode: "cron", labelKey: "automation.editor.freqCron" },
];

const WEEKDAY_SHORT_KEYS = [
  "weekdayShortSun",
  "weekdayShortMon",
  "weekdayShortTue",
  "weekdayShortWed",
  "weekdayShortThu",
  "weekdayShortFri",
  "weekdayShortSat",
] as const;
const WEEKDAY_FULL_KEYS = [
  "weekdaySun",
  "weekdayMon",
  "weekdayTue",
  "weekdayWed",
  "weekdayThu",
  "weekdayFri",
  "weekdaySat",
] as const;

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

/** ISO → "YYYY-MM-DDTHH:mm"（datetime-local 控件按本地时区取值） */
function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** once 的相对形态（模板 "+1d"）→ 此刻起算的 ISO；绝对 ISO 原样返回。
 *  （sidecar 保存时也对相对形态按当时时刻解析，这里仅为表单可视） */
function resolveOnceSchedule(schedule: string): string {
  const m = /^(\d+)(s|m|h|d)$/.exec(schedule.trim());
  if (!m || !m[1] || !m[2]) return schedule;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return new Date(Date.now() + Number(m[1]) * mult).toISOString();
}

/** 排期来源：已有任务记录或预置模板（两者字段形态一致，模板无 intervalSeconds 时回退解析文本） */
type ScheduleSource = {
  type: "cron" | "once" | "interval";
  schedule: string;
  intervalSeconds?: number;
};

/** 从排期来源反推表单初始频率态 */
function initFreq(source: ScheduleSource | null): {
  mode: FreqMode;
  time: string;
  days: number[];
  monthDay: number;
  intervalN: number;
  intervalUnit: "s" | "m" | "h" | "d";
  onceValue: string;
  cronExpr: string;
} {
  const base = {
    mode: "daily" as FreqMode,
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    monthDay: 1,
    intervalN: 60,
    intervalUnit: "m" as const,
    onceValue: "",
    cronExpr: "0 9 * * *",
  };
  if (!source) return base;
  if (source.type === "interval") {
    const s = source.intervalSeconds ?? parseIntervalSeconds(source.schedule) ?? 60;
    const unit = s % 86400 === 0 ? "d" : s % 3600 === 0 ? "h" : s % 60 === 0 ? "m" : "s";
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    return { ...base, mode: "interval", intervalN: Math.round(s / mult), intervalUnit: unit };
  }
  if (source.type === "once") {
    return {
      ...base,
      mode: "once",
      onceValue: toLocalInputValue(resolveOnceSchedule(source.schedule)),
    };
  }
  const p = cronToPreset(source.schedule);
  const hhmm = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  switch (p.mode) {
    case "daily":
      return { ...base, mode: "daily", time: hhmm(p.hour, p.minute) };
    case "weekly":
      return { ...base, mode: "weekly", time: hhmm(p.hour, p.minute), days: p.days };
    case "monthly":
      return { ...base, mode: "monthly", time: hhmm(p.hour, p.minute), monthDay: p.day };
    default:
      return { ...base, mode: "cron", cronExpr: source.schedule };
  }
}

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
                    <span className="text-muted-foreground max-w-40 shrink-0 truncate text-end font-mono text-3xs">
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

const ScheduleForm: FC<{
  task: AutomationTask | null;
  /** 从模板新建时的预置内容（与 task 互斥；表单只是初始值，照常可改） */
  template: AutomationTemplate | null;
  onSaved: () => void;
  onCancel: () => void;
}> = ({ task, template, onSaved, onCancel }) => {
  const t = useT();
  const [name, setName] = useState(task?.name ?? template?.name ?? "");
  const [description, setDescription] = useState(task?.description ?? template?.description ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? template?.prompt ?? "");
  const init = useMemo(
    () => initFreq(task ?? (template ? { type: template.type, schedule: template.schedule } : null)),
    [task, template],
  );
  const [mode, setMode] = useState<FreqMode>(init.mode);
  const [time, setTime] = useState(init.time);
  const [days, setDays] = useState<number[]>(init.days);
  const [monthDay, setMonthDay] = useState(init.monthDay);
  const [intervalN, setIntervalN] = useState(init.intervalN);
  const [intervalUnit, setIntervalUnit] = useState<"s" | "m" | "h" | "d">(init.intervalUnit);
  const [onceValue, setOnceValue] = useState(init.onceValue);
  const [cronExpr, setCronExpr] = useState(init.cronExpr);
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
  const [preview, setPreview] = useState<{ runs: string[] } | { error: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // —— 组装排期字符串（与 sidecar 三种 schedule 形态一一对应）——
  const built = useMemo((): { type: "cron" | "once" | "interval"; schedule: string } | null => {
    const [hRaw, mRaw] = time.split(":");
    const h = Number(hRaw);
    const m = Number(mRaw);
    switch (mode) {
      case "daily":
        return { type: "cron", schedule: presetToCron({ mode: "daily", hour: h, minute: m }) };
      case "weekly":
        if (days.length === 0) return null;
        return { type: "cron", schedule: presetToCron({ mode: "weekly", hour: h, minute: m, days }) };
      case "monthly":
        return {
          type: "cron",
          schedule: presetToCron({ mode: "monthly", hour: h, minute: m, day: monthDay }),
        };
      case "interval": {
        const n = Math.max(1, Math.round(intervalN));
        return { type: "interval", schedule: `${n}${intervalUnit}` };
      }
      case "once":
        if (!onceValue) return null;
        return { type: "once", schedule: new Date(onceValue).toISOString() };
      case "cron":
        return { type: "cron", schedule: cronExpr };
    }
  }, [mode, time, days, monthDay, intervalN, intervalUnit, onceValue, cronExpr]);

  // —— 防抖排期预览：下几次触发时刻由 sidecar 计算（与调度器同源同本地时区）——
  const previewKey = built ? `${built.type}:${built.schedule}` : "";
  useEffect(() => {
    if (!built) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      void previewAutomationSchedule({ type: built.type, schedule: built.schedule, count: 3 }).then(
        (r) => {
          if (!cancelled) setPreview(r);
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const submit = async () => {
    if (!prompt.trim()) {
      setFormError(t("automation.editor.errorPrompt"));
      return;
    }
    if (!built) {
      setFormError(
        mode === "weekly"
          ? t("automation.editor.errorNeedDay")
          : t("automation.editor.errorTime"),
      );
      return;
    }
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
    <>
      {/* 页头：与技能/MCP 编辑弹窗同款（图标 + 标题 + 说明），无分隔线 */}
      <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
        <div className="bg-violet-500/10 text-violet-600 dark:text-violet-400 grid size-12 shrink-0 place-items-center rounded-2xl">
          <CalendarClockIcon className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-md font-semibold tracking-tight">
            {task
              ? t("automation.editor.titleEdit")
              : template
                ? template.name
                  ? t("automation.editor.titleFromTemplate", { name: template.name })
                  : t("automation.editor.titleFromTemplateNoName")
                : t("automation.editor.titleNew")}
          </DialogTitle>
          <DialogDescription className="mt-1 line-clamp-2 text-sm">
            {template?.description || t("automation.editor.descDefault")}
          </DialogDescription>
        </div>
      </div>

      {/* overflow-x-hidden：表单组件各自负责自己的横向空间（cron 编辑器窄窗换列），
          绝不让整张表单长出横向滚动条 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-6 py-5">
        <div className="grid gap-1.5">
          <Label htmlFor="auto-name">{t("automation.editor.nameLabel")}</Label>
          <Input
            id="auto-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("automation.editor.namePlaceholder")}
          />
        </div>

        <div className="grid gap-1.5">
          <Label>{t("automation.editor.promptLabel")}</Label>
          {/* 直接复用聊天 composer 的输入组件与触发菜单（挂弹窗自己的本地 runtime，
              不串会话草稿）：@ 选子智能体、/ 选技能与 MCP 工具 */}
          <AutomationPromptField
            value={prompt}
            onChange={setPrompt}
            placeholder={t("automation.editor.promptPlaceholder")}
            // composer 同款配置行进外壳底部（与 composer 的动作行同位；受控于任务字段，不碰会话偏好）
            footer={
              <>
                <TaskWorkspacePill
                  value={workspaceDir}
                  projectId={projectId}
                  onChange={(dir, nextProjectId) => {
                    setWorkspaceDir(dir);
                    setProjectId(nextProjectId);
                  }}
                />
                <PolicyPill value={policy} onChange={setPolicy} />
                <TaskModelPill value={modelSel} onChange={setModelSel} />
              </>
            }
          />
          <p className="text-muted-foreground text-xs">{policyHint}</p>
        </div>

        <div className="grid gap-1.5">
          <Label>{t("automation.editor.freqLabel")}</Label>
          <div className="flex flex-wrap gap-1">
            {FREQ_LABEL_KEYS.map((f) => (
              <Button
                key={f.mode}
                type="button"
                size="sm"
                variant={mode === f.mode ? "secondary" : "outline"}
                className={cn("h-7 px-3 text-xs", mode === f.mode && "bg-selected")}
                onClick={() => {
                  // 切进「自定义」时把当前预设拼出的表达式种进编辑器：两个档位
                  // 各自持有状态，不种的话「每天 18:00 → 自定义」会看到陈旧的
                  // cronExpr。interval/once 拼不出 cron，保持原值不动。
                  if (f.mode === "cron" && built?.type === "cron") setCronExpr(built.schedule);
                  setMode(f.mode);
                }}
              >
                {t(f.labelKey)}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {(mode === "daily" || mode === "weekly" || mode === "monthly") && (
              <TimePicker
                value={time}
                onChange={setTime}
                aria-label={t("automation.editor.timeAria")}
              />
            )}
            {mode === "weekly" && (
              <div className="flex items-center gap-1">
                {WEEKDAY_SHORT_KEYS.map((key, i) => (
                  <Button
                    key={key}
                    type="button"
                    size="icon"
                    variant={days.includes(i) ? "secondary" : "ghost"}
                    className={cn("size-7 text-xs", days.includes(i) && "bg-selected")}
                    onClick={() =>
                      setDays((cur) =>
                        cur.includes(i) ? cur.filter((d) => d !== i) : [...cur, i].sort(),
                      )
                    }
                    aria-label={t("automation.editor.weekdayAria", {
                      day: t(`automation.cron.${WEEKDAY_FULL_KEYS[i]!}`),
                    })}
                  >
                    {t(`automation.cron.${key}`)}
                  </Button>
                ))}
              </div>
            )}
            {mode === "monthly" && (
              <Select value={String(monthDay)} onValueChange={(v) => v && setMonthDay(Number(v))}>
                <SelectTrigger size="sm" className="w-28 border bg-background">
                  <SelectValue>{t("automation.editor.monthlyDay", { day: monthDay })}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t("automation.editor.monthlyDay", { day: d })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {mode === "interval" && (
              <>
                <Input
                  type="number"
                  min={1}
                  value={String(intervalN)}
                  onChange={(e) => setIntervalN(Number(e.target.value) || 1)}
                  className="w-20"
                  aria-label={t("automation.editor.intervalValueAria")}
                />
                <Select
                  value={intervalUnit}
                  onValueChange={(v) => v && setIntervalUnit(v as "s" | "m" | "h" | "d")}
                >
                  <SelectTrigger size="sm" className="w-24 border bg-background">
                    <SelectValue>
                      {t(`automation.editor.unit${{ s: "Second", m: "Minute", h: "Hour", d: "Day" }[intervalUnit]}`)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="s">{t("automation.editor.unitSecond")}</SelectItem>
                    <SelectItem value="m">{t("automation.editor.unitMinute")}</SelectItem>
                    <SelectItem value="h">{t("automation.editor.unitHour")}</SelectItem>
                    <SelectItem value="d">{t("automation.editor.unitDay")}</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
            {mode === "once" && (
              <>
                <DateTimePicker
                  value={onceValue}
                  onChange={setOnceValue}
                  aria-label={t("automation.editor.onceAria")}
                />
                <div className="flex gap-1">
                  {[
                    { labelKey: "automation.editor.quick10m", ms: 10 * 60_000 },
                    { labelKey: "automation.editor.quick1h", ms: 3_600_000 },
                    { labelKey: "automation.editor.quickTomorrow", ms: 24 * 3_600_000 },
                  ].map((q) => (
                    <Button
                      key={q.labelKey}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => setOnceValue(toLocalInputValue(new Date(Date.now() + q.ms).toISOString()))}
                    >
                      {t(q.labelKey)}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {mode === "cron" && (
              <CronEditor value={cronExpr} onChange={setCronExpr} className="w-full" />
            )}
          </div>

          {/* 预览：sidecar 真算的下三次触发（croner 本地时区），非法排期红字提示 */}
          <div className="text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 text-xs">
            {built === null ? (
              mode === "once"
                ? t("automation.editor.previewPickOnce")
                : t("automation.editor.previewNeedDay")
            ) : preview === null ? (
              <span className="flex items-center gap-1.5">
                <Loader2Icon className="size-3 animate-spin" />
                {t("automation.editor.previewCalculating")}
              </span>
            ) : "error" in preview ? (
              <span className="text-red-500">{preview.error}</span>
            ) : (
              <div className="flex flex-col gap-0.5">
                <span>{t("automation.editor.previewRuns")}</span>
                {preview.runs.map((r) => (
                  <span key={r}>{formatDateTime(r)}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div>
            <p className="text-sm">{t("automation.editor.enableNow")}</p>
            <p className="text-muted-foreground text-xs">{t("automation.editor.enableDesc")}</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t("automation.editor.enableAria")} />
        </div>

      </div>

      {/* 页脚固定：错误就近显示，创建/保存键不随长表单滚走 */}
      <div className="shrink-0 px-6 py-4">
        {formError && <p className="text-red-500 mb-2 text-xs">{formError}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            {t("automation.editor.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2Icon className="size-4 animate-spin" />}
            {task ? t("automation.editor.save") : t("automation.editor.create")}
          </Button>
        </div>
      </div>
    </>
  );
};

export const AutomationEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  task: AutomationTask | null;
  /** 从模板新建（与 task 互斥） */
  template?: AutomationTemplate | null;
}> = ({ open, onOpenChange, task, template }) => {
  // 打开时刷新模型目录（凭据/过滤可能在设置里改过）
  useEffect(() => {
    if (open) refreshPiModels();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-3rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {open && (
          <ScheduleForm
            // 每次打开按目标任务/模板重建表单态（取消后重开不残留半途编辑）
            key={`${task?.id ?? template?.id ?? "new"}:${open ? "1" : "0"}`}
            task={task}
            template={template ?? null}
            onSaved={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
