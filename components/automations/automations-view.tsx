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

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { AnimatePresence, motion } from "framer-motion";
import { SPRING_LAYOUT } from "@/lib/ease";
import {
  AlertCircleIcon,
  BriefcaseBusinessIcon,
  CalendarDaysIcon,
  CheckIcon,
  ClockIcon,
  EraserIcon,
  HistoryIcon,
  HourglassIcon,
  LayersIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  RepeatIcon,
  SearchIcon,
  SquareCheckBigIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
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
  DropdownMenuSeparator,
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
  clearAutomationHistory,
  deleteAutomation,
  deleteAutomationHistory,
  fetchAutomationTemplates,
  getAutomationSessionForRun,
  refreshAutomations,
  runAutomationNow,
  setAutomationEnabled,
  useAutomationSessionForRun,
  useAutomations,
  type AutomationTask,
  type AutomationTemplate,
} from "@/lib/automations";
import { piRequest } from "@/lib/pi-bridge";
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
  scheduleKind,
} from "@/lib/automation-format";
import { cn } from "@/lib/utils";
import { Dock, DockItem, DockSeparator } from "@/components/custom-ui/dock";
import { Segmented } from "@/components/custom-ui/segmented";
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

/** 身份图标底座（Linear/Zapier 风格）：size-9 圆角色块按排期类型 tint
 *  （每日=蓝 business / 每周=紫 calendar / 一次性=琥珀 hourglass /
 *  分钟·小时级高频=青 repeated），运行中整块转主色；停用降灰但保留形状
 *  ——语义色要成面积，不能全页灰白 */
const TaskIdentity: FC<{ task: AutomationTask; running: boolean }> = ({ task, running }) => {
  const kind = scheduleKind(task);
  const Icon =
    kind === "once"
      ? HourglassIcon
      : kind === "weekly"
        ? CalendarDaysIcon
        : kind === "repeated"
          ? RepeatIcon
          : BriefcaseBusinessIcon;
  const tone = running
    ? "bg-primary text-primary-foreground"
    : !task.enabled
      ? "bg-muted text-muted-foreground"
      : kind === "once"
        ? "bg-amber-500 text-white"
        : kind === "weekly"
          ? "bg-purple-500 text-white"
          : kind === "repeated"
            ? "bg-teal-500 text-white"
            : "bg-blue-500 text-white";
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
        tone,
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  );
};

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
  onDelete: () => void;
}> = ({ entry, now, onOpenSession, onDelete }) => {
  // 条目里的 sessionId 是调度器标签；真实会话经帧记账映射回来
  const realSession = useAutomationSessionForRun(entry.id);
  return (
    <div
      className={cn(
        "text-muted-foreground group hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        realSession && "cursor-pointer",
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
      <button
        type="button"
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        title="删除这条记录"
        aria-label="删除这条记录"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2Icon className="size-3" />
      </button>
    </div>
  );
};

/** 全局运行记录页的一行：带归属任务名 */
const GlobalHistoryRow: FC<{
  item: HistoryItem;
  now: number;
  onOpenSession: (sessionId: string) => void;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
}> = ({ item, now, onOpenSession, batchMode, selected, onToggleSelect, onDelete }) => {
  const realSession = useAutomationSessionForRun(item.runId);
  return (
    <div
      className={cn(
        "group hover:bg-muted/60 flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        (batchMode || realSession) && "cursor-pointer",
      )}
      title={item.message}
      onClick={
        batchMode
          ? onToggleSelect
          : () => {
              if (realSession) onOpenSession(realSession);
            }
      }
    >
      {/* 批量勾选列：与任务卡同款"宽度推入 + 负边距补 gap 槽"动效；
          行高由文字决定（勾选框 16px 不会撑动），无需等高补偿 */}
      <AnimatePresence initial={false}>
        {batchMode && (
          <motion.div
            key="hist-check"
            className="flex shrink-0 items-center overflow-hidden"
            initial={{ width: 0, opacity: 0, marginRight: -12 }}
            animate={{ width: "auto", opacity: 1, marginRight: 0 }}
            exit={{ width: 0, opacity: 0, marginRight: -12 }}
            transition={SPRING_LAYOUT}
          >
            <Checkbox
              className="shrink-0"
              checked={selected}
              aria-label={`选择 ${item.taskName} 的运行记录`}
              // 冒泡会再触发整行的 onToggleSelect（同任务卡勾选的惯例）
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={onToggleSelect}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <RunStatusIcon status={item.status} />
      <span
        className={cn(
          "min-w-0 max-w-56 truncate font-medium",
          batchMode && selected && "text-primary",
        )}
      >
        {item.taskName}
      </span>
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
      {/* 悬停浮现单条删除；批量模式不摆（删除统一走坞，避免行内误点） */}
      {!batchMode && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          title="删除这条记录"
          aria-label="删除这条记录"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2Icon className="text-muted-foreground size-3.5" />
        </Button>
      )}
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
  /** 删该任务的历史条目（进统一确认框）；清空也经它传单条 id 列表即可 */
  onRequestEntryDelete: (runId: string) => void;
  onRequestClearHistory: () => void;
}> = ({
  task,
  onEdit,
  onOpenSession,
  highlighted,
  batchMode,
  selected,
  onToggleSelect,
  onRequestEntryDelete,
  onRequestClearHistory,
}) => {
  const running = useAutomationRunning(task.id);
  const now = useNowTick();
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [askDeleteOpen, setAskDeleteOpen] = useState(false);

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
  const errored = task.lastStatus === "error";

  return (
    <div
      id={`automation-card-${task.id}`}
      onClick={batchMode ? onToggleSelect : undefined}
      className={cn(
        // mt-auto 的元信息行让网格拉伸时各卡的排期/统计对齐在同一基线；
        // box-shadow 也进过渡：批量选中态的 ring 淡入而非闪现
        "flex flex-col gap-2.5 rounded-xl border p-4",
        // 上次运行失败的卡整卡淡红底+红边：状态语义色上面积，问题卡一眼扫到
        errored ? "bg-red-500/[0.02] border-red-500/30" : "bg-card border-border",
        "transition-[border-color,box-shadow] duration-150 hover:border-foreground/15",
        highlighted && "ring-2 ring-primary/60",
        batchMode && "cursor-pointer",
        batchMode && selected && "border-primary ring-1 ring-primary/50",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 批量模式切换动效：勾选框以宽度弹簧推入/抽回（标题平滑让位），
            右侧操作组同步收拢——否则两列控件硬替换很突兀。
            h-7 与操作组按钮行等高：切换瞬间标题行高度不变，网格不重排、卡片不跳 */}
        <AnimatePresence initial={false}>
          {batchMode && (
            <motion.div
              key="batch-check"
              className="flex h-7 shrink-0 items-center overflow-hidden"
              // marginRight 补偿父级 gap-2 空槽：宽度收拢的同时把 8px 间隙
              // 一并抽走，卸载那一帧标题行不再整体横跳（关闭批量时的抖动源）
              initial={{ width: 0, opacity: 0, marginRight: -8 }}
              animate={{ width: "auto", opacity: 1, marginRight: 0 }}
              exit={{ width: 0, opacity: 0, marginRight: -8 }}
              transition={SPRING_LAYOUT}
            >
              <Checkbox
                className="shrink-0"
                checked={selected}
                aria-label={`选择 ${task.name || "任务"}`}
                // 阻止冒泡：勾选本身已由 onCheckedChange 处理，卡片 onClick 会再翻一次
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={() => onToggleSelect()}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <TaskIdentity task={task} running={running} />
        <span
          className={cn(
            "truncate text-sm font-medium",
            // 停用态让标题变灰：一眼分清"在排期的"和"躺着的"
            !task.enabled && !running && "text-muted-foreground",
          )}
        >
          {task.name || "未命名任务"}
        </span>
        <AnimatePresence initial={false}>
          {!batchMode && (
            <motion.div
              key="card-actions"
              // 进出不对称：退场（进批量）收拢宽度配合勾选框推入做"让位"交接；
              // 进场（退批量）只淡入——ml-auto 右缘锚定，整宽直接就位零回流。
              // 进场若也从 0 展开，98px 的横扫会把标题区抖一遍
              className="ml-auto flex h-7 shrink-0 items-center gap-0.5 overflow-hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={SPRING_LAYOUT}
            >
              <Switch
                className="shrink-0"
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
                className="size-7 shrink-0"
                title="立即运行一次"
                aria-label="立即运行一次"
                disabled={busy || running}
                onClick={runNow}
              >
                <PlayIcon className="size-4" />
              </Button>
              {/* 次级操作全部收进 ⋯ 菜单：标题行常驻控件只有 开关/▶/⋯ 三个 */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
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
                      点了静默不触发（删除曾因此完全没反应）。删除走确认弹窗 */}
                  <DropdownMenuItem onClick={() => onEdit(task)}>
                    <PencilIcon className="size-4" />
                    编辑任务
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleHistory}>
                    <HistoryIcon className="size-4" />
                    {showHistory ? "收起运行历史" : "展开运行历史"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={history.length === 0}
                    onClick={onRequestClearHistory}
                  >
                    <EraserIcon className="size-4" />
                    清空运行历史
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setAskDeleteOpen(true)}
                  >
                    <Trash2Icon className="size-4" />
                    删除任务
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <p className="text-muted-foreground line-clamp-2 min-w-0 text-xs leading-relaxed">
        {task.description || promptExcerpt}
      </p>

      {/* 元信息行：排期胶囊 + 运行态 + 统计右靠齐；错误不再挤本行、
          另起红字行（长报错截断后 title 可看全文） */}
      <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span
          className={cn(
            // 排期胶囊主题色 tint：全页灰白底是"素"感的根因之一；停用降灰
            "rounded-full px-2 py-0.5 tabular-nums",
            task.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {describeSchedule(task)}
        </span>
        {running ? (
          <span className="text-primary inline-flex items-center gap-1">
            <Loader2Icon className="size-3 animate-spin" />
            运行中
          </span>
        ) : countdown ? (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <ClockIcon className="size-3" />
            {countdown === "即将触发" ? countdown : `下次 ${countdown}`}
          </span>
        ) : !task.enabled ? (
          // once 跑完自动停用（vendor 语义）：与手动暂停区分开
          task.type === "once" && task.lastStatus === "success" ? (
            <span className="bg-emerald-500/10 text-emerald-600 rounded-full px-2 py-0.5 dark:text-emerald-400">
              已完成
            </span>
          ) : (
            <span className="bg-muted rounded-full px-2 py-0.5">已暂停</span>
          )
        ) : null}
        <span className="text-muted-foreground/70 ml-auto shrink-0 tabular-nums">
          {task.lastRunAt ? `上次 ${relativePast(task.lastRunAt, now)}` : "从未运行"}
          {task.runCount > 0 && ` · 共 ${task.runCount} 次`}
        </span>
      </div>
      {task.lastStatus === "error" && task.lastError && (
        <div
          className="text-red-500 flex min-w-0 items-center gap-1 text-xs"
          title={task.lastError}
        >
          <AlertCircleIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{task.lastError.slice(0, 60)}</span>
        </div>
      )}

      {showHistory && !batchMode && (
        // 限高滚动：25 条记录全展开会把卡片撑成半屏，网格随之错位
        <div className="border-border/60 mt-1 flex max-h-60 flex-col gap-0.5 overflow-y-auto border-t pt-2">
          {history.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">还没有运行记录</p>
          ) : (
            history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                now={now}
                onOpenSession={onOpenSession}
                onDelete={() => onRequestEntryDelete(entry.id)}
              />
            ))
          )}
        </div>
      )}

      {/* 删除二次确认：确认后立即关窗再发请求（成功应答刷掉整卡，失败经
          store 错误横幅呈现）；与侧边栏删会话的 AlertDialog 形态一致 */}
      <AlertDialog open={askDeleteOpen} onOpenChange={setAskDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除定时任务？</AlertDialogTitle>
            <AlertDialogDescription>
              {`将永久删除「${task.name || "未命名任务"}」及其全部运行记录，此操作无法撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                setAskDeleteOpen(false);
                void act(() => deleteAutomation(task.id))();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  // 批量坞状态：全选判定只看筛选后可见的卡（与原"全选/清空"按钮同语义）
  const allVisibleSelected = visibleTasks.length > 0 && selected.size === visibleTasks.length;
  const batchActionDisabled = batchBusy || selected.size === 0;

  // —— 运行记录删除（单条 / 记录页批量 / 卡片清空共用一个确认框）——
  // 事实源删条目（all 走服务端整清）；"同时删除执行会话"是可选项：
  // 真实会话 id 由 run→session 帧记账映射得来，删侧边栏条目走 runtime
  // （自动切走当前会话），列表里没有的落回 delete_session 直删
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const threadItemsRef = useRef(threadItems);
  threadItemsRef.current = threadItems;

  type HistoryDeleteOp = { taskId: string; runIds?: string[]; all?: boolean };
  const [historyDeleteReq, setHistoryDeleteReq] = useState<{
    ops: HistoryDeleteOp[];
    count: number;
    label: string;
    sessionIds: string[];
  } | null>(null);
  const [historyAlsoSession, setHistoryAlsoSession] = useState(false);

  const requestHistoryDelete = (ops: HistoryDeleteOp[]) => {
    const runIds = ops.flatMap((o) => o.runIds ?? []);
    const allTaskIds = ops.filter((o) => o.all).map((o) => o.taskId);
    const allRunIds = snap.tasks
      .filter((t) => allTaskIds.includes(t.id))
      .flatMap((t) => (t.runHistory ?? []).map((e) => e.id));
    const count = runIds.length + allRunIds.length;
    const sessionIds = [...runIds, ...allRunIds]
      .map((rid) => getAutomationSessionForRun(rid))
      .filter((s): s is string => typeof s === "string");
    const names = [
      ...new Set(
        ops.map((o) => snap.tasks.find((t) => t.id === o.taskId)?.name || "未命名任务"),
      ),
    ];
    setHistoryAlsoSession(false);
    setHistoryDeleteReq({
      ops,
      count,
      label: names.length === 1 ? `「${names[0]}」` : `全部 ${names.length} 个任务`,
      sessionIds,
    });
  };

  const removeRunSessions = async (sessionIds: string[]) => {
    for (const sid of sessionIds) {
      try {
        const item = threadItemsRef.current.find((i) => i.remoteId === sid);
        if (item) {
          await (aui.threads.item({ id: item.id }).delete() as unknown as Promise<void>);
        } else {
          await piRequest({ type: "delete_session", sessionId: sid });
        }
      } catch {
        // 单个会话删失败不阻断其余（记录已删，会话残留无害）
      }
    }
    if (sessionIds.length > 0) void aui.threads.reload().catch(() => {});
  };

  const confirmHistoryDelete = async () => {
    const req = historyDeleteReq;
    if (!req) return;
    setHistoryDeleteReq(null);
    setHistoryBusy(true);
    for (const op of req.ops) {
      try {
        if (op.all) await clearAutomationHistory(op.taskId);
        else if (op.runIds?.length) await deleteAutomationHistory(op.taskId, op.runIds);
      } catch {
        // 单任务失败继续其余（错误进镜像 store 横幅）
      }
    }
    if (historyAlsoSession) await removeRunSessions(req.sessionIds);
    setHistoryBusy(false);
    exitHistoryBatch();
  };

  // —— 记录页批量管理模式（与任务卡批量互不相干）——
  const [historyBatch, setHistoryBatch] = useState(false);
  const [historySelected, setHistorySelected] = useState<ReadonlySet<string>>(new Set());
  const [historyBusy, setHistoryBusy] = useState(false);
  const exitHistoryBatch = () => {
    setHistoryBatch(false);
    setHistorySelected(new Set());
  };
  const toggleHistorySelect = (runId: string) =>
    setHistorySelected((cur) => {
      const next = new Set(cur);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  // 清单/筛选变化后剔除已不可见或已不存在的选中项
  const historyVisibleItems = useMemo(
    () => historyGroups.flatMap((g) => g.items),
    [historyGroups],
  );
  useEffect(() => {
    if (historySelected.size === 0) return;
    const alive = new Set(historyVisibleItems.map((i) => i.runId));
    if ([...historySelected].some((id) => !alive.has(id))) {
      setHistorySelected((cur) => new Set([...cur].filter((id) => alive.has(id))));
    }
  }, [historyVisibleItems, historySelected]);
  const historyAllSelected =
    historyVisibleItems.length > 0 && historySelected.size === historyVisibleItems.length;
  // 选中项按任务分组成分条删除命令（一天里可以横跨多个任务的记录）
  const selectedDeleteOps = (): HistoryDeleteOp[] => {
    const byTask = new Map<string, string[]>();
    for (const item of historyVisibleItems) {
      if (!historySelected.has(item.runId)) continue;
      const list = byTask.get(item.taskId) ?? [];
      list.push(item.runId);
      byTask.set(item.taskId, list);
    }
    return [...byTask].map(([taskId, runIds]) => ({ taskId, runIds }));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* 版式对齐设置页各分区（子智能体/技能同款）：居中限宽、大标题+右侧状态、
          说明文字+操作按钮行。环境光层抬到 base.tsx 主内容区根（透明 header 条
          也能被照到），这里不再叠一份，避免双层光带 */}
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

        {/* tab：定时任务 | 运行记录。分段器与设置页各分区同款；计数并入文案 */}
        <Segmented<"tasks" | "history">
          value={tab}
          className="w-fit self-start"
          options={[
            { value: "tasks", label: "定时任务" },
            {
              value: "history",
              label:
                totalHistoryCount > 0 ? `运行记录 ${totalHistoryCount}` : "运行记录",
            },
          ]}
          onChange={(v) => {
            setTab(v);
            exitBatch();
            exitHistoryBatch();
          }}
        />

        {/* 工具栏：搜索 + 筛选 + 刷新/批量/模板/新建 */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 搜索框固定紧凑宽度（设置页同款 w-56），不再 flex-1 撑满整行 */}
          <div className="relative w-56 max-w-full shrink-0">
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
          {/* 动作组靠右（ml-auto），左侧只剩搜索+筛选两个紧凑控件 */}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 shrink-0"
            aria-label="刷新"
            title="刷新"
            onClick={() => void refreshAutomations()}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
          {(() => {
            // 批量管理按当前 tab 接管对应模式（任务卡 / 运行记录各一套状态）
            const isTasks = tab === "tasks";
            const active = isTasks ? batchMode : historyBatch;
            const disabled = isTasks ? snap.tasks.length === 0 : totalHistoryCount === 0;
            return (
              <Button
                variant={active ? "secondary" : "outline"}
                className="h-8 shrink-0 gap-1.5"
                disabled={disabled}
                onClick={() => {
                  if (isTasks) {
                    batchMode ? exitBatch() : setBatchMode(true);
                  } else {
                    historyBatch ? exitHistoryBatch() : setHistoryBatch(true);
                  }
                }}
              >
                <ListChecksIcon className="size-4" />
                批量管理
              </Button>
            );
          })()}
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
            /* 日期标题贴到滚动视口边框外（首个组）；跨天时次级日期仍作为组头
               留在面板内随内容滚。固定高度滚动面板是唯一一圈 border，组内不
               再各自套卡——双层框叠着很难看 */
            <>
              <p className="text-muted-foreground px-1 pb-1.5 text-xs font-semibold">
                {historyGroups[0]?.label}
              </p>
              <div className="border-border/60 bg-card flex h-[480px] flex-col gap-4 overflow-y-auto rounded-2xl border p-3">
                {historyGroups.map((g, gi) => (
                  <div key={g.key}>
                    {gi > 0 && (
                      <p className="text-muted-foreground px-1 pb-1.5 text-xs font-semibold">
                        {g.label}
                      </p>
                    )}
                    <div>
                      {g.items.map((item) => (
                        <GlobalHistoryRow
                          key={item.runId}
                          item={item}
                          now={now}
                          onOpenSession={openSession}
                          batchMode={historyBatch}
                          selected={historySelected.has(item.runId)}
                          onToggleSelect={() => toggleHistorySelect(item.runId)}
                          onDelete={() =>
                            requestHistoryDelete([{ taskId: item.taskId, runIds: [item.runId] }])
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
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
                onRequestEntryDelete={(runId) =>
                  requestHistoryDelete([{ taskId: t.id, runIds: [runId] }])
                }
                onRequestClearHistory={() => requestHistoryDelete([{ taskId: t.id, all: true }])}
              />
            ))}
          </div>
        )}
      </div>

      {/* 批量操作坞：底部居中的悬浮图标条（Dock 风格）。外层 pointer-events-none
          只让坞本体可点，悬浮不遮两侧内容的滚轮操作；sticky 让它随滚动常驻。
          外层槽位常驻两个 tab、高度固定（坞 38px + 24px 边距）：坞本体进出
          不改变文档流高度，避免批量切换时列表尾部回流错位（另一种"抖"） */}
      <div className="pointer-events-none sticky bottom-0 z-20 h-[62px]">
        <AnimatePresence initial={false}>
          {batchMode && tab === "tasks" && (
            <motion.div
              key="batch-dock"
              className="flex justify-center pb-6"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 18 }}
              transition={SPRING_LAYOUT}
            >
              {/* Dock 容器 items-end 底对齐（为悬停放大图标设计），短文本必须
                  self-center 才不坠底；计数做成药丸胶囊和图标格呼应 */}
              <Dock size={36} className="pointer-events-auto">
                <span className="bg-muted text-muted-foreground self-center rounded-full px-2 py-0.5 text-xs tabular-nums">
                  已选 {selected.size}
                </span>
                {/* 方框勾=全选语义；全选态用主色图标提示（active pill 那块灰底
                    孤悬在图标行里很怪，且只有这一项有底色更显得像渲染故障） */}
                <DockItem
                  title={allVisibleSelected ? "清空" : "全选"}
                  aria-label={allVisibleSelected ? "清空" : "全选"}
                  onClick={
                    batchBusy || visibleTasks.length === 0
                      ? undefined
                      : () =>
                          setSelected(
                            allVisibleSelected
                              ? new Set()
                              : new Set(visibleTasks.map((t) => t.id)),
                          )
                  }
                  className={cn(
                    batchBusy || visibleTasks.length === 0
                      ? "opacity-40"
                      : "cursor-pointer",
                    allVisibleSelected && "text-primary",
                  )}
                >
                  <SquareCheckBigIcon className="size-4" />
                </DockItem>
                <DockSeparator />
                <DockItem
                  title="批量启用"
                  aria-label="批量启用"
                  onClick={batchActionDisabled ? undefined : () => void batchSetEnabled(true)}
                  className={cn(batchActionDisabled ? "opacity-40" : "cursor-pointer")}
                >
                  <PowerIcon className="size-4" />
                </DockItem>
                <DockItem
                  title="批量暂停"
                  aria-label="批量暂停"
                  onClick={batchActionDisabled ? undefined : () => void batchSetEnabled(false)}
                  className={cn(batchActionDisabled ? "opacity-40" : "cursor-pointer")}
                >
                  <PauseIcon className="size-4" />
                </DockItem>
                <DockItem
                  title={confirmBatchDelete ? `确认删除 ${selected.size} 项` : "批量删除"}
                  aria-label="批量删除"
                  onClick={batchActionDisabled ? undefined : () => void batchDelete()}
                  className={cn(
                    "relative",
                    batchActionDisabled ? "opacity-40" : "cursor-pointer",
                    confirmBatchDelete && "text-destructive",
                  )}
                >
                  {/* 一次点击进 3 秒确认态：红底描边框提示再点一次真删 */}
                  {confirmBatchDelete && (
                    <span className="bg-destructive/10 ring-destructive/40 absolute inset-1 -z-10 rounded-xl ring-1" />
                  )}
                  <Trash2Icon className="size-4" />
                </DockItem>
                <DockItem
                  title="退出批量管理"
                  aria-label="退出批量管理"
                  onClick={batchBusy ? undefined : exitBatch}
                  className={cn(batchBusy ? "opacity-40" : "cursor-pointer")}
                >
                  <XIcon className="size-4" />
                </DockItem>
              </Dock>
            </motion.div>
          )}
          {historyBatch && tab === "history" && (
            <motion.div
              key="history-dock"
              className="flex justify-center pb-6"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 18 }}
              transition={SPRING_LAYOUT}
            >
              <Dock size={36} className="pointer-events-auto">
                <span className="bg-muted text-muted-foreground self-center rounded-full px-2 py-0.5 text-xs tabular-nums">
                  已选 {historySelected.size}
                </span>
                <DockItem
                  title={historyAllSelected ? "清空" : "全选"}
                  aria-label={historyAllSelected ? "清空" : "全选"}
                  onClick={
                    historyBusy || historyVisibleItems.length === 0
                      ? undefined
                      : () =>
                          setHistorySelected(
                            historyAllSelected
                              ? new Set()
                              : new Set(historyVisibleItems.map((i) => i.runId)),
                          )
                  }
                  className={cn(
                    historyBusy || historyVisibleItems.length === 0
                      ? "opacity-40"
                      : "cursor-pointer",
                    historyAllSelected && "text-primary",
                  )}
                >
                  <SquareCheckBigIcon className="size-4" />
                </DockItem>
                <DockSeparator />
                <DockItem
                  title="批量删除记录"
                  aria-label="批量删除记录"
                  onClick={
                    historyBusy || historySelected.size === 0
                      ? undefined
                      : () => requestHistoryDelete(selectedDeleteOps())
                  }
                  className={cn(
                    historyBusy || historySelected.size === 0
                      ? "opacity-40"
                      : "cursor-pointer",
                  )}
                >
                  <Trash2Icon className="size-4" />
                </DockItem>
                <DockItem
                  title="退出批量管理"
                  aria-label="退出批量管理"
                  onClick={historyBusy ? undefined : exitHistoryBatch}
                  className={cn(historyBusy ? "opacity-40" : "cursor-pointer")}
                >
                  <XIcon className="size-4" />
                </DockItem>
              </Dock>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 删除运行记录的统一确认框：单条剔除 / 清空 / 批量选中都汇到这里。
          sidecar 只删日志条目；关联的执行会话默认可保留，是否连带删除交给
          这个可选勾选（有可定位会话时才出现该行） */}
      <AlertDialog
        open={!!historyDeleteReq}
        onOpenChange={(open) => {
          if (!open) setHistoryDeleteReq(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除运行记录？</AlertDialogTitle>
            <AlertDialogDescription>
              {`将删除${historyDeleteReq?.label ?? ""}的 ${historyDeleteReq?.count ?? 0} 条运行记录，此操作无法撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {historyDeleteReq && historyDeleteReq.sessionIds.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={historyAlsoSession}
                onCheckedChange={(checked) => setHistoryAlsoSession(checked === true)}
              />
              同时删除对应的 {historyDeleteReq.sessionIds.length} 个执行会话
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => void confirmHistoryDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
