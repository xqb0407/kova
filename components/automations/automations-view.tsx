"use client";

/**
 * 自动化管理页（主区整页视图）：侧边栏「自动化」菜单激活时替换聊天区渲染。
 * 清单来自 lib/automations 镜像 store（sidecar 事实源）；实时运行态来自
 * lib/automation-live 帧投影。
 *
 * 两个 tab（形态参考同类定时任务产品）：
 * - 定时任务：卡片直排操作（立即运行/编辑/历史展开/⋯删除）+ 搜索/状态筛选 +
 *   批量管理（多选后启用/暂停/删除）；
 * - 运行记录：跨任务聚合的全局时间线（lib/automation-history 纯函数），
 *   条目经 run→session 映射跳回那一次执行的实际会话。
 */

import { useEffect, useMemo, useState, type FC } from "react";
import { useAui } from "@assistant-ui/react";
import {
  AlertCircleIcon,
  CheckIcon,
  ClockIcon,
  HistoryIcon,
  LayersIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteAutomation,
  fetchAutomationTemplates,
  refreshAutomations,
  runAutomationNow,
  setAutomationEnabled,
  useAutomationSessionForRun,
  useAutomations,
  type AutomationTask,
  type AutomationTemplate,
} from "@/lib/automations";
import { useAutomationRunning } from "@/lib/automation-live";
import {
  filterHistoryItems,
  filterTasks,
  flattenRunHistory,
  groupHistoryByDay,
  historyStatusLabel,
  TASK_FILTER_LABEL,
  type HistoryItem,
  type RunHistoryEntry,
  type TaskFilter,
} from "@/lib/automation-history";
import {
  describeSchedule,
  describeTemplateSchedule,
  formatDateTime,
  nextRunLabel,
  relativePast,
} from "@/lib/automation-format";
import { cn } from "@/lib/utils";
import { AutomationEditorDialog } from "./automation-editor-dialog";

/** 30s 心跳：倒计时/相对时间标签自然刷新（避免逐秒重渲染整页） */
function useNowTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function StatusDot({ task, running }: { task: AutomationTask; running: boolean }) {
  if (running) {
    return <Loader2Icon className="text-primary size-3.5 shrink-0 animate-spin" />;
  }
  const color =
    task.lastStatus === "success"
      ? "bg-emerald-500"
      : task.lastStatus === "error"
        ? "bg-red-500"
        : "bg-muted-foreground/40";
  return <span className={cn("size-2 shrink-0 rounded-full", color)} />;
}

/** 运行状态图标（卡片内历史与全局记录页共用一套语义） */
function RunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2Icon className="text-primary size-3 shrink-0 animate-spin" />;
    case "success":
      return <CheckIcon className="text-emerald-500 size-3 shrink-0" />;
    case "error":
      return <XIcon className="text-red-500 size-3 shrink-0" />;
    case "queued":
      // 本地扩展 M4.3：全局并发闸排队中的运行条目
      return <ClockIcon className="text-muted-foreground size-3 shrink-0" />;
    default:
      return <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" />;
  }
}

const HistoryRow: FC<{
  entry: RunHistoryEntry;
  now: number;
  onOpenSession: (sessionId: string) => void;
}> = ({ entry, now, onOpenSession }) => {
  // 条目里的 sessionId 是调度器标签；真实会话经帧记账映射回来
  const realSession = useAutomationSessionForRun(entry.id);
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        realSession && "hover:bg-muted cursor-pointer",
      )}
      title={entry.message}
      onClick={() => realSession && onOpenSession(realSession)}
    >
      <RunStatusIcon status={entry.status} />
      <span>{formatDateTime(entry.createdAt)}</span>
      <span>{historyStatusLabel(entry.status)}</span>
      {entry.status === "error" && entry.message && (
        <span className="text-red-500 min-w-0 flex-1 truncate">{entry.message}</span>
      )}
      <span className="ml-auto shrink-0 tabular-nums opacity-70">
        {relativePast(entry.createdAt, now)}
      </span>
      {realSession && <MessageSquareIcon className="size-3 shrink-0 opacity-50" />}
    </div>
  );
};

/** 全局运行记录页的一行：带归属任务名 */
const GlobalHistoryRow: FC<{
  item: HistoryItem;
  now: number;
  onOpenSession: (sessionId: string) => void;
}> = ({ item, now, onOpenSession }) => {
  const realSession = useAutomationSessionForRun(item.runId);
  return (
    <div
      className={cn(
        "hover:bg-muted/60 flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        realSession ? "cursor-pointer" : "cursor-default",
      )}
      title={item.message}
      onClick={() => realSession && onOpenSession(realSession)}
    >
      <RunStatusIcon status={item.status} />
      <span className="min-w-0 max-w-56 truncate font-medium">{item.taskName}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {historyStatusLabel(item.status)}
      </span>
      {item.status === "error" && item.message && (
        <span className="text-red-500 min-w-0 flex-1 truncate text-xs">{item.message}</span>
      )}
      <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
        {formatDateTime(item.createdAt)}
      </span>
      <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums opacity-70">
        {relativePast(item.createdAt, now)}
      </span>
      {realSession && <MessageSquareIcon className="size-3.5 shrink-0 opacity-50" />}
    </div>
  );
};

const TaskCard: FC<{
  task: AutomationTask;
  onEdit: (t: AutomationTask) => void;
  onOpenSession: (sessionId: string) => void;
  highlighted: boolean;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}> = ({ task, onEdit, onOpenSession, highlighted, batchMode, selected, onToggleSelect }) => {
  const running = useAutomationRunning(task.id);
  const now = useNowTick();
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const runNow = act(async () => {
    // 暂停任务立即运行：sidecar execute 对未启用任务静默跳过
    // （防重入/排队复验同样按 enabled），先恢复调度再触发，
    // 卡片开关会同步回弹，状态变化对用户可见而非无声失败
    if (!task.enabled) await setAutomationEnabled(task.id, true);
    await runAutomationNow(task.id);
  });

  const toggleHistory = () => {
    // 展开历史前刷一次清单（runHistory 在任务记录里）。刷新是 store 副作用，
    // 必须留在 updater 外：updater 会在渲染期执行，emit 落到父组件即触发
    // "Cannot update a component while rendering a different component"。
    if (!showHistory) void refreshAutomations();
    setShowHistory((v) => !v);
  };

  const countdown =
    task.enabled && task.nextRunAt ? nextRunLabel(task.nextRunAt, now) : "";
  const promptExcerpt =
    task.prompt.length > 90 ? `${task.prompt.slice(0, 90)}…` : task.prompt;
  const history = [...(task.runHistory ?? [])].reverse().slice(0, 25);

  return (
    <div
      id={`automation-card-${task.id}`}
      onClick={batchMode ? onToggleSelect : undefined}
      className={cn(
        "border-border bg-card flex flex-col gap-2 rounded-xl border p-3.5",
        highlighted && "ring-2 ring-primary/60",
        batchMode && "cursor-pointer",
        batchMode && selected && "border-primary ring-1 ring-primary/50",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {batchMode && (
          <Checkbox
            checked={selected}
            aria-label={`选择 ${task.name || "任务"}`}
            // 阻止冒泡：勾选本身已由 onCheckedChange 处理，卡片 onClick 会再翻一次
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={() => onToggleSelect()}
          />
        )}
        <StatusDot task={task} running={running} />
        <span className="truncate text-sm font-medium">{task.name || "未命名任务"}</span>
        {!batchMode && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Switch
              checked={task.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void act(() => setAutomationEnabled(task.id, checked))()
              }
              aria-label={`${task.name || "任务"} 启用`}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="立即运行一次"
              aria-label="立即运行一次"
              disabled={busy || running}
              onClick={runNow}
            >
              <PlayIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="编辑"
              aria-label="编辑任务"
              disabled={busy}
              onClick={() => onEdit(task)}
            >
              <PencilIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7", showHistory && "bg-muted")}
              title={showHistory ? "收起运行历史" : "展开运行历史"}
              aria-label="运行历史"
              aria-pressed={showHistory}
              disabled={busy}
              onClick={toggleHistory}
            >
              <HistoryIcon className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="更多操作"
                    disabled={busy}
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                {/* 本地 dropdown 封装基于 base-ui：条目回调只认 onClick。
                    onSelect 是 Radix 惯例，落到底层是原生 text-selection 事件，
                    点了静默不触发（删除曾因此完全没反应） */}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void act(() => deleteAutomation(task.id))()}
                >
                  <Trash2Icon className="size-4" />
                  删除任务
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
        {task.description || promptExcerpt}
      </p>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>{describeSchedule(task)}</span>
        {running ? (
          <span className="text-primary flex items-center gap-1">
            <Loader2Icon className="size-3 animate-spin" />
            运行中
          </span>
        ) : countdown ? (
          <span className="flex items-center gap-1">
            <ClockIcon className="size-3" />
            {countdown === "即将触发" ? countdown : `下次 ${countdown}`}
          </span>
        ) : !task.enabled ? (
          // once 跑完自动停用（vendor 语义）：与手动暂停区分开
          task.type === "once" && task.lastStatus === "success" ? (
            <span className="opacity-60">已完成</span>
          ) : (
            <span>已暂停</span>
          )
        ) : null}
        {task.lastRunAt && <span>上次 {relativePast(task.lastRunAt, now)}</span>}
        {task.lastStatus === "error" && task.lastError && (
          <span className="text-red-500 flex min-w-0 items-center gap-1" title={task.lastError}>
            <AlertCircleIcon className="size-3 shrink-0" />
            <span className="truncate">{task.lastError.slice(0, 40)}</span>
          </span>
        )}
        {task.runCount > 0 && <span className="tabular-nums">共 {task.runCount} 次</span>}
      </div>

      {showHistory && !batchMode && (
        <div className="border-border/60 mt-1 flex flex-col gap-0.5 border-t pt-2">
          {history.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">还没有运行记录</p>
          ) : (
            history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                now={now}
                onOpenSession={onOpenSession}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 模板选择弹窗（M3.7）：清单来自 sidecar automation_templates 应答
 * （lib 里模块级缓存，这里每次打开仍走一次 fetch 命中缓存即可）；
 * 点选只是给编辑器预置初值，不直接落库。
 */
const TemplatePickerDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (t: AutomationTemplate) => void;
}> = ({ open, onOpenChange, onPick }) => {
  const [templates, setTemplates] = useState<AutomationTemplate[] | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    setTemplates(null);
    fetchAutomationTemplates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>从模板新建</DialogTitle>
          <DialogDescription>挑一个常见场景起步，表单里的内容都可以再改。</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="text-red-500 bg-red-500/5 border-red-500/20 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={load}>
              重试
            </Button>
          </div>
        ) : templates === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="hover:bg-muted/60 focus-visible:ring-ring/50 rounded-lg border px-3 py-2.5 text-start outline-none focus-visible:ring-1"
                onClick={() => {
                  onOpenChange(false);
                  onPick(t);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                    {describeTemplateSchedule(t)}
                  </span>
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
                  {t.description}
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export const AutomationsView: FC<{
  /** 跳转会话后回到聊天（清菜单选中） */
  onBackToChat?: () => void;
  /** 侧边栏 ⚡ 徽标定位请求（nonce 保证重复点击同一任务也重新滚动） */
  focusTask?: { taskId: string; nonce: number } | null;
  onFocusConsumed?: () => void;
}> = ({ onBackToChat, focusTask, onFocusConsumed }) => {
  const snap = useAutomations();
  const aui = useAui();
  const [tab, setTab] = useState<"tasks" | "history">("tasks");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<AutomationTask | null>(null);
  const [editorTemplate, setEditorTemplate] = useState<AutomationTemplate | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 批量删除两段式确认（点一次变"确认删除"，3 秒不点自动回退）
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const now = useNowTick();

  // 每次进入页面主动拉一次：sidecar 可能在会话后台被 LLM 工具改过任务表
  useEffect(() => {
    void refreshAutomations();
  }, []);

  // 徽标定位：滚动到卡片 + 短暂描边。清单可能还在加载（首进页面），
  // 找不到卡片时按帧重试几次；用完通知宿主清请求（延迟到动效结束，
  // 不在 effect 里同步清 —— 那会立刻重跑本 effect 并掐掉计时器）
  useEffect(() => {
    if (!focusTask) return;
    setTab("tasks");
    let cancelled = false;
    let tries = 0;
    const locate = () => {
      if (cancelled) return;
      const el = document.getElementById(`automation-card-${focusTask.taskId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightId(focusTask.taskId);
      } else if (tries++ < 8) {
        setTimeout(locate, 250);
      }
    };
    locate();
    const t1 = setTimeout(() => setHighlightId(null), 2600);
    const t2 = setTimeout(() => onFocusConsumed?.(), 2800);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTask?.nonce]);

  const openSession = (sessionId: string) => {
    void (async () => {
      try {
        // 与"打开分支"同款：先 reload 让列表就位，避免物化无标题临时行
        await aui.threads.reload();
        await aui.threads.switchToThread(sessionId);
        onBackToChat?.();
      } catch {
        // 会话已删：静默（sidecar 清单随后会反映）
      }
    })();
  };

  const openEditor = (t: AutomationTask | null) => {
    setEditingTask(t);
    setEditorTemplate(null);
    setEditorOpen(true);
  };
  const openFromTemplate = (t: AutomationTemplate) => {
    setEditingTask(null);
    setEditorTemplate(t);
    setEditorOpen(true);
  };

  const enabledCount = snap.tasks.filter((t) => t.enabled).length;
  const visibleTasks = useMemo(
    () => filterTasks(snap.tasks, query, statusFilter),
    [snap.tasks, query, statusFilter],
  );
  const historyGroups = useMemo(
    () => groupHistoryByDay(filterHistoryItems(flattenRunHistory(snap.tasks), query), now),
    [snap.tasks, query, now],
  );

  const exitBatch = () => {
    setBatchMode(false);
    setSelected(new Set());
    setConfirmBatchDelete(false);
  };
  const toggleSelect = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // 清单刷新后剔除已不存在的选中项（比如别处删了任务）
  useEffect(() => {
    if (!batchMode || selected.size === 0) return;
    const alive = new Set(snap.tasks.map((t) => t.id));
    const stale = [...selected].some((id) => !alive.has(id));
    if (stale) setSelected((cur) => new Set([...cur].filter((id) => alive.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.tasks]);

  const batchSetEnabled = async (enabled: boolean) => {
    setBatchBusy(true);
    for (const id of selected) {
      try {
        await setAutomationEnabled(id, enabled);
      } catch {
        // 单条失败不中断其余（错误已进镜像 store 横幅）
      }
    }
    setBatchBusy(false);
    exitBatch();
  };
  const batchDelete = async () => {
    if (!confirmBatchDelete) {
      setConfirmBatchDelete(true);
      setTimeout(() => setConfirmBatchDelete(false), 3000);
      return;
    }
    setBatchBusy(true);
    for (const id of selected) {
      try {
        await deleteAutomation(id);
      } catch {
        // 同上
      }
    }
    setBatchBusy(false);
    exitBatch();
  };

  const totalHistoryCount = snap.tasks.reduce((n, t) => n + (t.runHistory?.length ?? 0), 0);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* 版式对齐设置页各分区（子智能体/技能同款）：居中限宽、大标题+右侧状态、
          说明文字+操作按钮行 */}
      <div className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-4 px-8 pt-8 pb-2">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">自动化</h1>
          <span
            className={cn(
              "text-xs",
              snap.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {snap.error
              ? "任务清单加载失败，可重试"
              : snap.loaded
                ? `${snap.tasks.length} 个任务（${enabledCount} 个启用）`
                : ""}
          </span>
        </div>
        <p className="text-muted-foreground text-sm">
          按计划自动运行 Agent 任务，每次执行开一个独立会话
        </p>

        {/* tab：定时任务 | 运行记录 */}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={tab === "tasks" ? "secondary" : "ghost"}
            className="gap-1.5"
            onClick={() => setTab("tasks")}
          >
            <ClockIcon className="size-3.5" />
            定时任务
          </Button>
          <Button
            size="sm"
            variant={tab === "history" ? "secondary" : "ghost"}
            className="gap-1.5"
            onClick={() => setTab("history")}
          >
            <HistoryIcon className="size-3.5" />
            运行记录
            {totalHistoryCount > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {totalHistoryCount}
              </span>
            )}
          </Button>
        </div>

        {/* 工具栏：搜索 + 筛选 + 刷新/批量/模板/新建 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-52">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === "tasks" ? "搜索任务名称/指令" : "搜索运行记录（任务名/状态）"}
              className="h-8 pl-8 text-sm"
              aria-label="搜索"
            />
          </div>
          {tab === "tasks" && (
            <Select
              value={statusFilter}
              onValueChange={(v) => v && setStatusFilter(v as TaskFilter)}
            >
              <SelectTrigger size="sm" className="w-28 border bg-background">
                <SelectValue>{TASK_FILTER_LABEL[statusFilter]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TASK_FILTER_LABEL) as TaskFilter[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {TASK_FILTER_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="刷新"
            title="刷新"
            onClick={() => void refreshAutomations()}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
          {tab === "tasks" && (
            <Button
              variant={batchMode ? "secondary" : "outline"}
              className="h-8 shrink-0 gap-1.5"
              disabled={snap.tasks.length === 0}
              onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
            >
              <ListChecksIcon className="size-4" />
              批量管理
            </Button>
          )}
          <Button
            variant="outline"
            className="h-8 shrink-0 gap-1.5"
            onClick={() => setTemplatesOpen(true)}
          >
            <LayersIcon className="size-4" />
            模板
          </Button>
          <Button className="h-8 shrink-0 gap-1.5" onClick={() => openEditor(null)}>
            <PlusIcon className="size-4" />
            新建任务
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl flex-1 px-8 pb-8">
        {snap.error && (
          <div className="text-red-500 bg-red-500/5 border-red-500/20 mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{snap.error}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => void refreshAutomations()}
            >
              重试
            </Button>
          </div>
        )}

        {tab === "history" ? (
          !snap.loaded && !snap.error ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-lg" />
              ))}
            </div>
          ) : historyGroups.length === 0 ? (
            <div className="border-border/60 text-muted-foreground mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
              <HistoryIcon className="size-8 opacity-40" />
              <p className="text-sm font-medium">
                {query ? "没有匹配的运行记录" : "还没有运行记录"}
              </p>
              {!query && (
                <p className="text-xs">任务触发后，每一次执行（含排队与暂停排期）都会记在这里</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {historyGroups.map((g) => (
                <div key={g.key}>
                  <p className="text-muted-foreground px-3 pb-1 text-xs font-medium">{g.label}</p>
                  <div className="flex flex-col">
                    {g.items.map((item) => (
                      <GlobalHistoryRow
                        key={item.runId}
                        item={item}
                        now={now}
                        onOpenSession={openSession}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : !snap.loaded && !snap.error ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : snap.loaded && snap.tasks.length === 0 ? (
          <div className="border-border/60 text-muted-foreground mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
            <ZapIcon className="size-8 opacity-40" />
            <div>
              <p className="text-sm font-medium">还没有自动化任务</p>
              <p className="mt-1 text-xs">
                也可以在对话里直接说"每天早上 9 点给我发一份昨日总结"，让 Agent 帮你建
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openEditor(null)}>
                <PlusIcon className="size-4" />
                新建第一个任务
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => setTemplatesOpen(true)}
              >
                <LayersIcon className="size-4" />
                从模板挑一个
              </Button>
            </div>
          </div>
        ) : visibleTasks.length === 0 ? (
          <p className="text-muted-foreground mt-6 text-center text-sm">
            没有匹配的任务{query && `（关键词「${query}」）`}
            {statusFilter !== "all" && `（${TASK_FILTER_LABEL[statusFilter]}）`}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visibleTasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                onEdit={openEditor}
                onOpenSession={openSession}
                highlighted={highlightId === t.id}
                batchMode={batchMode}
                selected={selected.has(t.id)}
                onToggleSelect={() => toggleSelect(t.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 批量操作条：选中态常驻底部 */}
      {batchMode && tab === "tasks" && (
        <div className="bg-background border-border/60 sticky bottom-0 z-10 border-t">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-8 py-3">
            <span className="text-sm tabular-nums">已选 {selected.size} 项</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={batchBusy}
              onClick={() =>
                setSelected(
                  selected.size === visibleTasks.length
                    ? new Set()
                    : new Set(visibleTasks.map((t) => t.id)),
                )
              }
            >
              {selected.size === visibleTasks.length && visibleTasks.length > 0 ? "清空" : "全选"}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void batchSetEnabled(true)}
              >
                启用
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void batchSetEnabled(false)}
              >
                暂停
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 gap-1.5 text-xs"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void batchDelete()}
              >
                {confirmBatchDelete ? `确认删除 ${selected.size} 项` : `删除 (${selected.size})`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={batchBusy}
                onClick={exitBatch}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}

      <AutomationEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        task={editingTask}
        template={editorTemplate}
      />
      <TemplatePickerDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        onPick={openFromTemplate}
      />
    </div>
  );
};
