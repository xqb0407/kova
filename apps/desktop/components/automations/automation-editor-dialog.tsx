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
  CheckIcon,
  FolderOpenIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  PencilIcon,
  PlusIcon,
  SquarePenIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CronEditor } from "@/components/custom-ui/cron-editor";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { fmtContextWindow } from "@/lib/model/model-format";
import {
  getWorkspace,
  openWorkspacePicker,
  pathBasename,
  useWorkspaceRecents,
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
import { cn } from "@/lib/utils";

type FreqMode = "daily" | "weekly" | "monthly" | "interval" | "once" | "cron";

const FREQ_LABELS: { mode: FreqMode; label: string }[] = [
  { mode: "daily", label: "每天" },
  { mode: "weekly", label: "每周" },
  { mode: "monthly", label: "每月" },
  { mode: "interval", label: "间隔" },
  { mode: "once", label: "一次性" },
  { mode: "cron", label: "自定义" },
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 权限档 → composer ModePicker 同款外观的胶囊选项（计划模式对无人值守不成立，不提供） */
const POLICY_META: Record<
  AutomationDraft["toolPolicyProfile"],
  { label: string; desc: string; icon: LucideIcon; warning?: boolean }
> = {
  "read-only": {
    label: "只读",
    desc: "只能读取与检索，写/命令自动拒绝（默认）",
    icon: HandIcon,
  },
  "workspace-write": {
    label: "工作区可写",
    desc: "可在指定工作目录内写文件与执行命令",
    icon: SquarePenIcon,
  },
  full: {
    label: "完全访问",
    desc: "全部工具放开，仅在你完全信任该任务时使用",
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
    warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground hover:text-foreground",
  );

/** 工作目录胶囊：最近目录 + 浏览 + 手动输入（composer WorkspacePill 同款交互，但受控于任务字段） */
const TaskWorkspacePill: FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const recents = useWorkspaceRecents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualValue, setManualValue] = useState("");

  const browse = async () => {
    setBusy(true);
    try {
      const dir = await openWorkspacePicker();
      if (dir) onChange(dir);
      setOpen(false);
    } catch {
      // 非 Tauri 环境：手动输入路径兜底
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setManual(false);
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={value || "留空 = 每次运行使用独立临时目录"}
            aria-label="任务工作目录"
            className={pillTriggerClass(!!value)}
          >
            {busy ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <FolderOpenIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{value ? pathBasename(value) : "选择目录"}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-72 p-0">
        <DropdownMenuGroup className="p-0">
          <div className="px-1 py-1">
            {recents.length > 0 ? (
              recents.map((dir) => (
                <DropdownMenuCheckboxItem
                  key={dir}
                  checked={dir === value}
                  onCheckedChange={(checked) => {
                    if (checked) onChange(dir);
                  }}
                  // base-ui 条目只认 onClick（无 Radix 的 onSelect），选中后保持
                  // 菜单展开要靠 closeOnClick=false
                  closeOnClick={false}
                  title={dir}
                >
                  <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate">{pathBasename(dir)}</span>
                </DropdownMenuCheckboxItem>
              ))
            ) : (
              <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                暂无最近目录
              </div>
            )}
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-1 pb-1">
          {value && (
            <DropdownMenuItem onClick={() => onChange("")}>
              <XIcon className="text-muted-foreground size-3.5 shrink-0" />
              取消选择
            </DropdownMenuItem>
          )}
          {manual ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Input
                autoFocus
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder="绝对路径"
                className="h-7 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onChange(manualValue.trim());
                    setManual(false);
                    setOpen(false);
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() => {
                  onChange(manualValue.trim());
                  setManual(false);
                  setOpen(false);
                }}
              >
                确定
              </Button>
            </div>
          ) : (
            <DropdownMenuItem
              // 就地切到手输路径行，菜单保持展开：base-ui 无 onSelect，
              // 保开靠 closeOnClick=false
              closeOnClick={false}
              onClick={() => {
                setManualValue(value);
                setManual(true);
              }}
            >
              <PencilIcon className="text-muted-foreground size-3.5 shrink-0" />
              手动输入路径…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void browse()} disabled={busy}>
            {busy ? (
              <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
            ) : (
              <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            浏览目录…
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 权限档胶囊：ModePicker 同款下拉形态，三档无人值守语义（存 task.toolPolicyProfile） */
const PolicyPill: FC<{
  value: AutomationDraft["toolPolicyProfile"];
  onChange: (v: AutomationDraft["toolPolicyProfile"]) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const current = POLICY_META[value];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={current.desc}
            aria-label="工具权限"
            className={pillTriggerClass(false, current.warning)}
          >
            <CurrentIcon className="size-3.5 shrink-0" />
            <span>{current.label}</span>
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
                <o.icon className={cn("size-4 shrink-0", o.warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
                <div className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      o.warning && k === value && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {o.label}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">{o.desc}</span>
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
 *  "跟随全局默认"以伪选项身份进列表——运行时 runner 解析不到即用默认模型。 */
const FOLLOW_ID = "follow";
const FOLLOW_OPTION: ModelOption = {
  id: FOLLOW_ID,
  name: "跟随全局默认",
  description: "运行时使用当前默认模型",
};
const TaskModelPill: FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const models = usePiModels();
  // 与 composer 选择器同规则：只列已配置凭据且未被禁用的模型
  const list = useMemo(
    () => models.filter((m) => m.authed && m.enabled !== false),
    [models],
  );
  const byId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of list) map.set(`${m.provider}/${m.id}`, m.name || m.id);
    return map;
  }, [list]);
  const options = useMemo<ModelOption[]>(
    () => [
      FOLLOW_OPTION,
      ...list.map((m) => ({
        id: `${m.provider}/${m.id}`,
        name: m.name || m.id,
        keywords: [m.provider, m.providerName],
        description: `${m.providerName} · ${fmtContextWindow(m.contextWindow)}`,
      })),
    ],
    [list],
  );
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const o of options) {
      if (o.id === FOLLOW_ID) continue;
      const id = o.id;
      const providerName = list.find((m) => `${m.provider}/${m.id}` === id)?.providerName ?? id;
      const arr = map.get(providerName);
      if (arr) arr.push(o);
      else map.set(providerName, [o]);
    }
    return [...map.entries()];
  }, [options, list]);
  const selectedLabel =
    value === FOLLOW_ID ? "跟随全局" : (byId.get(value) ?? (value || "选择模型"));
  return (
    <ModelSelector.Root models={options} value={value} onValueChange={onChange}>
      <ModelSelector.Trigger
        variant="ghost"
        size="sm"
        className={cn(pillTriggerClass(value !== FOLLOW_ID), "max-w-48 [&>span]:min-w-0")}
        title={selectedLabel}
      >
        <span className="truncate">{selectedLabel}</span>
      </ModelSelector.Trigger>
      <ModelSelector.Content searchable className="w-80">
        <ModelSelector.Search placeholder="搜索模型…" />
        <ModelSelector.List>
          <ModelSelector.Item model={FOLLOW_OPTION} />
          <ModelSelector.Empty>没有可用模型，请在设置 → 模型里添加服务</ModelSelector.Empty>
          {groups.map(([providerName, opts]) => (
            <ModelSelector.Group
              key={providerName}
              heading={providerName}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
            >
              {opts.map((o) => (
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
      setFormError("请填写要执行的指令");
      return;
    }
    if (!built) {
      setFormError(mode === "weekly" ? "每周至少选一天" : "请填写完整的运行时间");
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
    };
    setSaving(true);
    setFormError("");
    try {
      await saveAutomation(draft);
      toast.add({
        type: "success",
        title: task ? "任务已更新" : "任务已创建",
        description: name.trim() || prompt.slice(0, 30),
      });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
      toast.add({ type: "error", title: "保存失败", description: msg });
    } finally {
      setSaving(false);
    }
  };

  const policyHint = POLICY_META[policy].desc;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {task
            ? "编辑自动化任务"
            : template
              ? `从模板新建${template.name ? `：${template.name}` : ""}`
              : "新建自动化任务"}
        </DialogTitle>
        <DialogDescription>
          {template?.description ||
            "到点后 Agent 会在独立会话中自动执行这条指令；也可以在对话里直接让它帮你建。"}
        </DialogDescription>
      </DialogHeader>

      <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto py-1">
        <div className="grid gap-1.5">
          <Label htmlFor="auto-name">任务名称（可选）</Label>
          <Input
            id="auto-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：每日晨报"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="auto-prompt">
            执行指令 <span className="text-red-500">*</span>
          </Label>
          <Textarea
            id="auto-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="要 Agent 做什么？写清楚范围和输出要求，无人值守时没人能追问你。"
            rows={4}
          />
          {/* composer 同款配置行：工作目录 / 权限档 / 模型（受控于任务字段，不碰会话偏好） */}
          <div className="flex flex-wrap items-center gap-1">
            <TaskWorkspacePill value={workspaceDir} onChange={setWorkspaceDir} />
            <PolicyPill value={policy} onChange={setPolicy} />
            <TaskModelPill value={modelSel} onChange={setModelSel} />
          </div>
          <p className="text-muted-foreground text-xs">{policyHint}</p>
        </div>

        <div className="grid gap-1.5">
          <Label>运行频率</Label>
          <div className="flex flex-wrap gap-1">
            {FREQ_LABELS.map((f) => (
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
                {f.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {(mode === "daily" || mode === "weekly" || mode === "monthly") && (
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-32"
                aria-label="运行时刻"
              />
            )}
            {mode === "weekly" && (
              <div className="flex items-center gap-1">
                {WEEKDAYS.map((label, i) => (
                  <Button
                    key={label}
                    type="button"
                    size="icon"
                    variant={days.includes(i) ? "secondary" : "ghost"}
                    className={cn("size-7 text-xs", days.includes(i) && "bg-selected")}
                    onClick={() =>
                      setDays((cur) =>
                        cur.includes(i) ? cur.filter((d) => d !== i) : [...cur, i].sort(),
                      )
                    }
                    aria-label={`周${label}`}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            {mode === "monthly" && (
              <Select value={String(monthDay)} onValueChange={(v) => v && setMonthDay(Number(v))}>
                <SelectTrigger size="sm" className="w-28 border bg-background">
                  <SelectValue>每月 {monthDay} 日</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      每月 {d} 日
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
                  aria-label="间隔数值"
                />
                <Select
                  value={intervalUnit}
                  onValueChange={(v) => v && setIntervalUnit(v as "s" | "m" | "h" | "d")}
                >
                  <SelectTrigger size="sm" className="w-24 border bg-background">
                    <SelectValue>
                      {{ s: "秒", m: "分钟", h: "小时", d: "天" }[intervalUnit]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="s">秒</SelectItem>
                    <SelectItem value="m">分钟</SelectItem>
                    <SelectItem value="h">小时</SelectItem>
                    <SelectItem value="d">天</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
            {mode === "once" && (
              <>
                <Input
                  type="datetime-local"
                  value={onceValue}
                  onChange={(e) => setOnceValue(e.target.value)}
                  className="w-52"
                  aria-label="一次性运行时间"
                />
                <div className="flex gap-1">
                  {[
                    { label: "10 分钟后", ms: 10 * 60_000 },
                    { label: "1 小时后", ms: 3_600_000 },
                    { label: "明天", ms: 24 * 3_600_000 },
                  ].map((q) => (
                    <Button
                      key={q.label}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => setOnceValue(toLocalInputValue(new Date(Date.now() + q.ms).toISOString()))}
                    >
                      {q.label}
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
                ? "选择一次性运行时间"
                : "每周至少选择一天"
            ) : preview === null ? (
              <span className="flex items-center gap-1.5">
                <Loader2Icon className="size-3 animate-spin" />
                计算下几次触发…
              </span>
            ) : "error" in preview ? (
              <span className="text-red-500">{preview.error}</span>
            ) : (
              <div className="flex flex-col gap-0.5">
                <span>下几次运行：</span>
                {preview.runs.map((r) => (
                  <span key={r}>{formatDateTime(r)}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div>
            <p className="text-sm">创建后立即启用</p>
            <p className="text-muted-foreground text-xs">关闭则保存为暂停态，可随时再开</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用任务" />
        </div>

        {formError && <p className="text-red-500 text-xs">{formError}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={saving}>
          {saving && <Loader2Icon className="size-4 animate-spin" />}
          {task ? "保存" : "创建任务"}
        </Button>
      </DialogFooter>
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
      <DialogContent className="sm:max-w-xl">
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
