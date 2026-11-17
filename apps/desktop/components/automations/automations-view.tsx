"use client";

/**
 * 自动化管理页（主区整页视图）：侧边栏「自动化」菜单激活时替换聊天区渲染。
 * 清单来自 lib/automations 镜像 store（sidecar 事实源）；实时运行态来自
 * lib/automation-live 帧投影。
 *
 * 版式按"标题 → 页签 → 检索 → 清单 → 模板"五段递进（与插件市场页同骨架）：
 * 主操作（新建任务）提到页头右，检索与批量动作留在贴近清单的工具条里。
 *
 * 两个 tab（形态参考同类定时任务产品）：
 * - 定时任务：行卡与插件市场同一套皮（细描边 + 40px 类型图标 + 单行描述 +
 *   行尾开关/立即运行/⋯）+ 搜索/状态筛选 + 批量管理（多选后启用/暂停/删除），
 *   清单下方常驻模板区（点卡片预置表单）；
 * - 运行记录：跨任务聚合的全局时间线（lib/automation-history 纯函数），
 *   条目经 run→session 映射跳回那一次执行的实际会话。
 */

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAui } from "@assistant-ui/react";
import { AnimatePresence, motion } from "framer-motion";
import { SPRING_LAYOUT } from "@/lib/motion/ease";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  EraserIcon,
  HistoryIcon,
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
  SearchIcon,
  SquareCheckBigIcon,
  Trash2Icon,
  WebhookIcon,
  XIcon,
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
  getAutomationSessionForRun,
  refreshAutomations,
  runAutomationNow,
  setAutomationEnabled,
  useAutomationSessionForRun,
  useAutomations,
  type AutomationTask,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import { piRequest } from "@/lib/pi/pi-bridge";
import { useAutomationRunning } from "@/lib/automation/automation-live";
import {
  filterHistoryItems,
  filterTasks,
  flattenRunHistory,
  groupHistoryByDay,
  type HistoryItem,
  type RunHistoryEntry,
  type TaskFilter,
} from "@/lib/automation/automation-history";
import {
  describeSchedule,
  formatDateTime,
  nextRunLabel,
  relativePast,
} from "@/lib/automation/automation-format";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Dock, DockItem, DockSeparator } from "@/components/custom-ui/dock";
import { Segmented } from "@/components/custom-ui/segmented";
import { AutomationEmptyState, HistoryEmptyState } from "./automation-empty";
import { AutomationEditorDialog } from "./automation-editor-dialog";
import { TemplateGallery } from "./template-gallery";
import TriggerDialog from "./trigger-dialog";

/** 任务状态筛选 / 运行状态文案 key（事实源仍在 automation-history） */
const TASK_FILTER_KEYS: Record<TaskFilter, string> = {
  all: "automation.view.filter.all",
  enabled: "automation.view.filter.enabled",
  paused: "automation.view.filter.paused",
  error: "automation.view.filter.error",
};
const HISTORY_STATUS_KEYS: Record<string, string> = {
  success: "automation.view.status.success",
  error: "automation.view.status.error",
  running: "automation.view.status.running",
  queued: "automation.view.status.queued",
  paused: "automation.view.status.paused",
  resumed: "automation.view.status.resumed",
};

/** 30s 心跳：倒计时/相对时间标签自然刷新（避免逐秒重渲染整页） */
function useNowTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
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
  onDelete: () => void;
}> = ({ entry, now, onOpenSession, onDelete }) => {
  const t = useT();
  // 条目里的 sessionId 是调度器标签；真实会话经帧记账映射回来
  const realSession = useAutomationSessionForRun(entry.id);
  return (
    <div
      className={cn(
        "text-muted-foreground group hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        realSession && "cursor-pointer",
      )}
      title={entry.message}
      role={realSession ? "button" : undefined}
      tabIndex={realSession ? 0 : undefined}
      onClick={() => realSession && onOpenSession(realSession)}
      onKeyDown={(e) => {
        if (!realSession) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenSession(realSession);
        }
      }}
    >
      <RunStatusIcon status={entry.status} />
      <span>{formatDateTime(entry.createdAt)}</span>
      <span>{HISTORY_STATUS_KEYS[entry.status] ? t(HISTORY_STATUS_KEYS[entry.status]!) : entry.status}</span>
      {entry.status === "error" && entry.message && (
        <span className="text-red-500 min-w-0 flex-1 truncate">{entry.message}</span>
      )}
      <span className="ml-auto shrink-0 tabular-nums opacity-70">
        {relativePast(entry.createdAt, now)}
      </span>
      {realSession && <MessageSquareIcon className="size-3 shrink-0 opacity-50" />}
      <button
        type="button"
        className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        title={t("automation.view.deleteThisRecord")}
        aria-label={t("automation.view.deleteThisRecord")}
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
  const t = useT();
  const realSession = useAutomationSessionForRun(item.runId);
  return (
    <div
      className={cn(
        "group hover:bg-muted/60 relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        (batchMode || realSession) && "cursor-pointer",
      )}
      title={item.message}
      role={batchMode || realSession ? "button" : undefined}
      tabIndex={batchMode || realSession ? 0 : undefined}
      aria-label={
        batchMode ? t("automation.view.selectRunRecordAria", { name: item.taskName }) : undefined
      }
      aria-pressed={batchMode ? selected : undefined}
      onClick={
        batchMode
          ? onToggleSelect
          : () => {
              if (realSession) onOpenSession(realSession);
            }
      }
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (!batchMode && !realSession) return;
        e.preventDefault();
        if (batchMode) onToggleSelect();
        else if (realSession) onOpenSession(realSession);
      }}
    >
      {/* 批量勾选列：进出只动 transform/opacity，退场 popLayout 即时出流；
          与任务卡同款。行高由文字决定（勾选框 16px 不会撑动），无需等高补偿 */}
      <AnimatePresence initial={false} mode="popLayout">
        {batchMode && (
          <motion.div
            key="hist-check"
            className="flex shrink-0 items-center"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={SPRING_LAYOUT}
          >
            <Checkbox
              className="shrink-0"
              checked={selected}
              aria-label={t("automation.view.selectRunRecordAria", { name: item.taskName })}
              // 冒泡会再触发整行的 onToggleSelect（同任务卡勾选的惯例）
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={onToggleSelect}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* 左段整体挂 layout 投影：勾选槽进出引发的一次重排被画成滑动，
          全程合成层动画。右段时间簇 ml-auto 锚定右缘，本就不受槽位增减影响 */}
      <motion.div
        layout="position"
        className="flex min-w-0 flex-1 items-center gap-3"
      >
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
          {HISTORY_STATUS_KEYS[item.status] ? t(HISTORY_STATUS_KEYS[item.status]!) : item.status}
        </span>
        {item.status === "error" && item.message && (
          <span className="text-red-500 min-w-0 flex-1 truncate text-xs">{item.message}</span>
        )}
      </motion.div>
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
          className="size-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          title={t("automation.view.deleteThisRecord")}
          aria-label={t("automation.view.deleteThisRecord")}
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
  onOpenTriggers: (t: AutomationTask) => void;
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
  onOpenTriggers,
  onOpenSession,
  highlighted,
  batchMode,
  selected,
  onToggleSelect,
  onRequestEntryDelete,
  onRequestClearHistory,
}) => {
  const t = useT();
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

  /** 状态行 tooltip：排期 + 上次运行 + 次数（卡面只留一条状态文本） */
  const lastRunText = task.lastRunAt
    ? t("automation.view.lastRun", { time: relativePast(task.lastRunAt, now) })
    : t("automation.view.neverRun");
  const metaTitle = `${describeSchedule(task)} · ${lastRunText}${
    task.runCount > 0
      ? t("automation.view.runCount", { count: task.runCount })
      : ""
  }`;

  return (
    <div
      id={`automation-card-${task.id}`}
      onClick={batchMode ? onToggleSelect : undefined}
      className={cn(
        // 与插件市场同一套行卡：透明底 + 细描边，只有悬停才铺灰；
        // 内容只留「标题 / 描述 / 状态」三行，操作组悬停才出现
        "group border-border/50 hover:bg-muted/40 flex flex-col rounded-xl border p-3 transition-[background-color,box-shadow] duration-150",
        errored && "border-red-500/40",
        highlighted && "ring-2 ring-primary/60",
        batchMode && "cursor-pointer",
        batchMode && selected && "ring-1 ring-primary/50",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* 批量模式勾选框：进出只动 transform/opacity */}
        <AnimatePresence initial={false} mode="popLayout">
          {batchMode && (
            <motion.div
              key="batch-check"
              className="flex h-6 shrink-0 items-center"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={SPRING_LAYOUT}
            >
              <Checkbox
                className="shrink-0"
                checked={selected}
                aria-label={t("automation.view.selectTaskAria", {
                  name: task.name || t("automation.view.unnamedTask"),
                })}
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={() => onToggleSelect()}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="min-w-0 flex-1">
          {/* 标题恒用前景色：停用态由下方「已暂停」承担，和插件市场/模板卡
              的名称颜色保持一致，不能因为暂停就把整张卡读灰 */}
          <span className="block truncate text-sm font-medium">
            {task.name || t("automation.view.unnamedTask")}
          </span>
          <p
            className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5"
            title={task.description || promptExcerpt}
          >
            {task.description || promptExcerpt}
          </p>
          <p
            className="text-muted-foreground mt-3 truncate text-xs leading-5 tabular-nums"
            title={metaTitle}
          >
            {running ? (
              <span className="text-primary inline-flex items-center gap-1">
                <Loader2Icon className="size-3 animate-spin" />
                {t("automation.view.running")}
              </span>
            ) : task.enabled ? (
              countdown
                ? t("automation.view.nextRun", { countdown })
                : describeSchedule(task)
            ) : task.type === "once" && task.lastStatus === "success" ? (
              <>
                {t("automation.view.completed")} · {describeSchedule(task)}
              </>
            ) : (
              <>
                {t("automation.view.paused")} · {describeSchedule(task)}
              </>
            )}
          </p>
          {task.lastStatus === "error" && task.lastError && (
            <div
              className="text-red-500 mt-1 flex min-w-0 items-center gap-1 text-xs"
              title={task.lastError}
            >
              <AlertCircleIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {task.lastError.slice(0, 60)}
              </span>
            </div>
          )}
        </div>

        {/* 操作组悬停出现：平时卡面只留内容（同 MiniMax） */}
        {!batchMode && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <Switch
              size="sm"
              className="shrink-0"
              checked={task.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void act(() => setAutomationEnabled(task.id, checked))()
              }
              aria-label={t("automation.view.enableTaskAria", {
                name: task.name || t("automation.view.unnamedTask"),
              })}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              title={t("automation.view.runNow")}
              aria-label={t("automation.view.runNow")}
              disabled={busy || running}
              onClick={runNow}
            >
              <PlayIcon className="size-3.5" />
            </Button>
            {/* 次级操作全部收进 ⋯ 菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label={t("automation.view.moreActions")}
                    disabled={busy}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                {/* 本地 dropdown 封装基于 base-ui：条目回调只认 onClick。
                    onSelect 是 Radix 惯例，落到底层是原生 text-selection 事件，
                    点了静默不触发（删除曾因此完全没反应）。删除走确认弹窗 */}
                <DropdownMenuItem onClick={() => onEdit(task)}>
                  <PencilIcon className="size-4" />
                  {t("automation.view.editTask")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenTriggers(task)}>
                  <WebhookIcon className="size-4" />
                  {t("automation.trigger.menuLabel")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleHistory}>
                  <HistoryIcon className="size-4" />
                  {showHistory
                    ? t("automation.view.collapseHistory")
                    : t("automation.view.expandHistory")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={history.length === 0}
                  onClick={onRequestClearHistory}
                >
                  <EraserIcon className="size-4" />
                  {t("automation.view.clearHistory")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setAskDeleteOpen(true)}
                >
                  <Trash2Icon className="size-4" />
                  {t("automation.view.deleteTask")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {showHistory && !batchMode && (
        // 限高滚动：25 条记录全展开会把卡片撑成半屏，网格随之错位
        <div className="border-border/50 mt-3 flex max-h-60 flex-col gap-0.5 overflow-y-auto border-t pt-2">
          {history.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">
              {t("automation.view.noRunHistory")}
            </p>
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
            <AlertDialogTitle>{t("automation.view.deleteTaskTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automation.view.deleteTaskDesc", {
                name: task.name || t("automation.view.unnamedTask"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("automation.view.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                setAskDeleteOpen(false);
                void act(() => deleteAutomation(task.id))();
              }}
            >
              {t("automation.view.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export const AutomationsView: FC<{
  /** 跳转会话后回到聊天（清菜单选中） */
  onBackToChat?: () => void;
  /** 侧边栏 ⚡ 徽标定位请求（nonce 保证重复点击同一任务也重新滚动） */
  focusTask?: { taskId: string; nonce: number } | null;
  onFocusConsumed?: () => void;
}> = ({ onBackToChat, focusTask, onFocusConsumed }) => {
  const t = useT();
  const snap = useAutomations();
  const aui = useAui();
  const [tab, setTab] = useState<"tasks" | "history">("tasks");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<AutomationTask | null>(null);
  const [editorTemplate, setEditorTemplate] = useState<AutomationTemplate | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 批量删除两段式确认（点一次变"确认删除"，3 秒不点自动回退）
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  /** 触发器弹窗当前任务（null = 关闭） */
  const [triggerTask, setTriggerTask] = useState<AutomationTask | null>(null);
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

  // 会话创建：退回聊天并把引导语预填进输入框。agent 模式的对话 run 挂了
  // scheduler_create/list/get/update/delete/run_now 工具组（sidecar
  // automation/mgmt-tools.ts，plan 模式与无人值守 run 不挂），直接说需求即可。
  // setText 落在 runtime 层与视图挂卸无关，但晚一帧等视图切完再注入更稳
  const startViaChat = () => {
    onBackToChat?.();
    requestAnimationFrame(() => {
      aui.composer.setText(t("automation.view.promptPrefill"));
    });
  };

  const openEditor = (next: AutomationTask | null) => {
    setEditingTask(next);
    setEditorTemplate(null);
    setEditorOpen(true);
  };
  const openFromTemplate = (template: AutomationTemplate) => {
    setEditingTask(null);
    setEditorTemplate(template);
    setEditorOpen(true);
  };

  const enabledCount = snap.tasks.filter((task) => task.enabled).length;
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
    const alive = new Set(snap.tasks.map((task) => task.id));
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

  const totalHistoryCount = snap.tasks.reduce(
    (n, task) => n + (task.runHistory?.length ?? 0),
    0,
  );
  // 批量坞状态：全选判定只看筛选后可见的卡（与原"全选/清空"按钮同语义）
  const allVisibleSelected = visibleTasks.length > 0 && selected.size === visibleTasks.length;
  const batchActionDisabled = batchBusy || selected.size === 0;

  // —— 运行记录删除（单条 / 记录页批量 / 卡片清空共用一个确认框）——
  // 事实源删条目（all 走服务端整清）；"同时删除执行会话"是可选项：
  // 真实会话 id 由 run→session 帧记账映射得来，删侧边栏条目走 runtime
  // （自动切走当前会话），列表里没有的落回 delete_session 直删
  // 内容稳定切片：数组身份随发布重建时不触发本页重渲
  const threadItems = useThreadItems();
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
      .filter((task) => allTaskIds.includes(task.id))
      .flatMap((task) => (task.runHistory ?? []).map((e) => e.id));
    const count = runIds.length + allRunIds.length;
    const sessionIds = [...runIds, ...allRunIds]
      .map((rid) => getAutomationSessionForRun(rid))
      .filter((s): s is string => typeof s === "string");
    const names = [
      ...new Set(
        ops.map((o) => snap.tasks.find((task) => task.id === o.taskId)?.name || t("automation.view.unnamedTask")),
      ),
    ];
    setHistoryAlsoSession(false);
    setHistoryDeleteReq({
      ops,
      count,
      label:
        names.length === 1
          ? t("automation.view.taskLabel", { name: names[0] })
          : t("automation.view.allTasksLabel", { count: names.length }),
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
      {/* 版式对齐插件市场页：居中限宽、标题+右侧主操作、页签、检索条。
          环境光层抬到 base.tsx 主内容区根（透明 header 条也能被照到），
          这里不再叠一份，避免双层光带 */}
      <div className="mx-auto flex w-full max-w-7xl shrink-0 flex-col gap-4 px-8 pt-8 pb-2">
        {/* 页头：标题/副标题在左，主操作在右 —— 主操作不再和搜索框挤同一行 */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t("automation.view.title")}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("automation.view.subtitle")}
            </p>
          </div>
          {/* 新建拆两径：手动表单 or 回聊天让 agent 建（scheduler_* 工具） */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="shrink-0 gap-1">
                  <PlusIcon className="size-4" />
                  {t("automation.view.newTask")}
                  <ChevronDownIcon className="size-3 opacity-60" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEditor(null)}>
                <PencilIcon className="size-4" />
                {t("automation.view.manualCreate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={startViaChat}>
                <MessageSquareIcon className="size-4" />
                {t("automation.view.chatCreate")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 页签 + 检索/批量收在同一条工具行（参考插件市场页）：窄屏自动换行，
            既保留「列表读什么」和「怎么筛」的邻近关系，也少一层竖向堆叠 */}
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<"tasks" | "history">
            value={tab}
            className="w-fit"
            options={[
              {
                value: "tasks",
                label:
                  snap.tasks.length > 0
                    ? t("automation.view.tabTasksCount", { count: snap.tasks.length })
                    : t("automation.view.tabTasks"),
              },
              {
                value: "history",
                label:
                  totalHistoryCount > 0
                    ? t("automation.view.tabHistoryCount", { count: totalHistoryCount })
                    : t("automation.view.tabHistory"),
              },
            ]}
            onChange={(v) => {
              setTab(v);
              exitBatch();
              exitHistoryBatch();
            }}
          />
          <span
            className={cn(
              "shrink-0 text-xs",
              snap.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {snap.error
              ? t("automation.view.loadFailed")
              : snap.loaded
                ? t("automation.view.taskSummary", {
                    count: snap.tasks.length,
                    enabled: enabledCount,
                  })
                : ""}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative w-56 max-w-full shrink-0">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  tab === "tasks"
                    ? t("automation.view.searchTasksPlaceholder")
                    : t("automation.view.searchHistoryPlaceholder")
                }
                className="h-8 pl-8 text-sm"
                aria-label={t("automation.view.searchAria")}
              />
            </div>
            {tab === "tasks" && (
              <Select
                value={statusFilter}
                onValueChange={(v) => v && setStatusFilter(v as TaskFilter)}
              >
                <SelectTrigger size="sm" className="w-28 ">
                  <SelectValue>{t(TASK_FILTER_KEYS[statusFilter])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TASK_FILTER_KEYS) as TaskFilter[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(TASK_FILTER_KEYS[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("automation.view.refresh")}
              title={t("automation.view.refresh")}
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
                  {t("automation.view.batchManage")}
                </Button>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl flex-1 px-8 pb-8">
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
              {t("automation.view.retry")}
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
            <HistoryEmptyState
              title={
                query
                  ? t("automation.view.noMatchingHistory")
                  : t("automation.empty.historyTitle")
              }
              description={
                query ? undefined : t("automation.empty.historyDescription")
              }
            />
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
              // 骨架跟卡片同形：分层后卡高 ~160px，圆角同 rounded-2xl
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        ) : snap.loaded && snap.tasks.length === 0 ? (
          /* 空态版式在 automation-empty（瓷片 + 一句话 + 行动点）；这里只给行动点，
             因为"新建"要落回本页的编辑器状态 */
          <AutomationEmptyState
            action={
              <Button
                className="gap-1.5"
                onClick={() => openEditor(null)}
              >
                <PlusIcon className="size-4" />
                {t("automation.view.createFirstTask")}
              </Button>
            }
          />
        ) : visibleTasks.length === 0 ? (
          <p className="text-muted-foreground mt-6 text-center text-sm">
            {t("automation.view.noMatchingTasks")}
            {query && t("automation.view.noMatchingTasksQuery", { query })}
            {statusFilter !== "all" &&
              t("automation.view.noMatchingTasksStatus", {
                status: t(TASK_FILTER_KEYS[statusFilter]),
              })}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-2">
            {visibleTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onEdit={openEditor}
                onOpenTriggers={setTriggerTask}
                onOpenSession={openSession}
                highlighted={highlightId === task.id}
                batchMode={batchMode}
                selected={selected.has(task.id)}
                onToggleSelect={() => toggleSelect(task.id)}
                onRequestEntryDelete={(runId) =>
                  requestHistoryDelete([{ taskId: task.id, runIds: [runId] }])
                }
                onRequestClearHistory={() => requestHistoryDelete([{ taskId: task.id, all: true }])}
              />
            ))}
          </div>
        )}
        {/* 模板区沉到清单下方（只挂任务 tab）：这是新用户的第一条路径，
            不该和搜索框挤在同一条工具条里，也不再藏进二级弹窗 */}
        {tab === "tasks" && !batchMode && <TemplateGallery onPick={openFromTemplate} />}
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
                  {t("automation.view.batchSelected", { count: selected.size })}
                </span>
                {/* 方框勾=全选语义；全选态用主色图标提示（active pill 那块灰底
                    孤悬在图标行里很怪，且只有这一项有底色更显得像渲染故障） */}
                <DockItem
                  title={allVisibleSelected ? t("automation.view.clearSelection") : t("automation.view.selectAll")}
                  aria-label={allVisibleSelected ? t("automation.view.clearSelection") : t("automation.view.selectAll")}
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
                  title={t("automation.view.batchEnable")}
                  aria-label={t("automation.view.batchEnable")}
                  onClick={batchActionDisabled ? undefined : () => void batchSetEnabled(true)}
                  className={cn(batchActionDisabled ? "opacity-40" : "cursor-pointer")}
                >
                  <PowerIcon className="size-4" />
                </DockItem>
                <DockItem
                  title={t("automation.view.batchPause")}
                  aria-label={t("automation.view.batchPause")}
                  onClick={batchActionDisabled ? undefined : () => void batchSetEnabled(false)}
                  className={cn(batchActionDisabled ? "opacity-40" : "cursor-pointer")}
                >
                  <PauseIcon className="size-4" />
                </DockItem>
                <DockItem
                  title={
                    confirmBatchDelete
                      ? t("automation.view.confirmDeleteCount", { count: selected.size })
                      : t("automation.view.batchDelete")
                  }
                  aria-label={t("automation.view.batchDelete")}
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
                  title={t("automation.view.exitBatch")}
                  aria-label={t("automation.view.exitBatch")}
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
                  {t("automation.view.batchSelected", { count: historySelected.size })}
                </span>
                <DockItem
                  title={historyAllSelected ? t("automation.view.clearSelection") : t("automation.view.selectAll")}
                  aria-label={historyAllSelected ? t("automation.view.clearSelection") : t("automation.view.selectAll")}
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
                  title={t("automation.view.batchDeleteRecords")}
                  aria-label={t("automation.view.batchDeleteRecords")}
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
                  title={t("automation.view.exitBatch")}
                  aria-label={t("automation.view.exitBatch")}
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
            <AlertDialogTitle>{t("automation.view.deleteHistoryTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automation.view.deleteHistoryDesc", {
                label: historyDeleteReq?.label ?? "",
                count: historyDeleteReq?.count ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {historyDeleteReq && historyDeleteReq.sessionIds.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={historyAlsoSession}
                onCheckedChange={(checked) => setHistoryAlsoSession(checked === true)}
              />
              {t("automation.view.alsoDeleteSessions", {
                count: historyDeleteReq.sessionIds.length,
              })}
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("automation.view.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => void confirmHistoryDelete()}
            >
              {t("automation.view.delete")}
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

      {triggerTask ? (
        <TriggerDialog
          open
          taskId={triggerTask.id}
          taskName={triggerTask.name || t("automation.view.unnamedTask")}
          taskEnabled={triggerTask.enabled}
          onClose={() => setTriggerTask(null)}
        />
      ) : null}
    </div>
  );
};
