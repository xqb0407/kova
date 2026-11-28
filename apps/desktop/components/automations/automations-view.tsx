"use client";

/**
 * 自动化管理页（主区整页视图）：侧边栏「自动化」菜单激活时替换聊天区渲染。
 * 清单来自 lib/automations 镜像 store（sidecar 事实源）；实时运行态来自
 * lib/automation-live 帧投影。
 *
 * 版式为「左列表 + 右详情」双栏（参考同类自动化产品的 master-detail）：
 * - 左栏：检索 + 新建按钮 + 任务清单（紧凑行卡：排期一行 / 名称一行 /
 *   下次运行或上次运行一行，行尾常驻启用开关）；
 * - 右栏两态：
 *   1. 详情/内联编辑器（AutomationEditorPane，选中即编辑，头部名称输入框 +
 *      重置/立即运行/保存，设置与运行记录两页签）；
 *   2. 新建态模板选择页（空白/会话创建两张卡 + TemplateGallery）。
 *
 * 批量管理保留：左栏清单勾选 + 底部悬浮 Dock（启停/删除）。运行记录只在
 * 详情页签内按任务查看。
 */

import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAui } from "@assistant-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { SPRING_LAYOUT } from "@/lib/motion/ease";
import {
  AlertCircleIcon,
  CheckIcon,
  ClockIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  PauseIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareCheckBigIcon,
  Trash2Icon,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  filterTasks,
  type RunHistoryEntry,
} from "@/lib/automation/automation-history";
import {
  describeSchedule,
  formatDateTime,
  nextRunLabel,
  relativePast,
} from "@/lib/automation/automation-format";
import { isEventOnlySchedule } from "@/lib/automation/triggers";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Dock, DockItem, DockSeparator } from "@/components/custom-ui/dock";
import { AutomationEditorPane } from "./automation-editor-pane";
import { TemplateGrid } from "./template-gallery";

/** 运行状态文案 key（事实源仍在 automation-history） */
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

/** 左栏清单行卡：排期一行 / 名称一行 / 运行态一行，行尾常驻启用开关（monocode 同构） */
const TaskListItem: FC<{
  task: AutomationTask;
  now: number;
  active: boolean;
  highlighted: boolean;
  batchMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}> = ({ task, now, active, highlighted, batchMode, selected, onSelect, onToggleSelect, onToggleEnabled }) => {
  const t = useT();
  const running = useAutomationRunning(task.id);
  const errored = task.lastStatus === "error";
  // 减弱动效偏好：勾选列进出退化为纯 opacity（项目惯例，见 todo-list）
  const reduce = useReducedMotion() ?? false;

  const countdown =
    task.enabled && task.nextRunAt ? nextRunLabel(task.nextRunAt, now) : "";
  // 纯事件任务（P2）：排期是内部哨兵，列表按「事件触发」展示
  const scheduleText = isEventOnlySchedule(task.schedule)
    ? t("automation.trigger.eventOnly")
    : describeSchedule(task);
  const statusLine = running
    ? t("automation.view.running")
    : task.enabled
      ? countdown
        ? t("automation.view.nextRun", { countdown })
        : scheduleText
      : task.lastRunAt
        ? t("automation.view.lastRun", { time: relativePast(task.lastRunAt, now) })
        : t("automation.view.neverRun");

  return (
    <div
      className={cn(
        "group relative rounded-md border border-transparent",
        active ? "bg-selected" : "hover:bg-muted/50",
        highlighted && "ring-2 ring-primary/60",
        batchMode && selected && "ring-1 ring-primary/50",
        batchMode && "cursor-pointer",
      )}
      onClick={batchMode ? onToggleSelect : undefined}
      role={batchMode ? "button" : undefined}
      aria-pressed={batchMode ? selected : undefined}
    >
      <div className="flex min-w-0 items-center">
        {/* 批量勾选列：进出只动 transform/opacity */}
        <AnimatePresence initial={false} mode="popLayout">
          {batchMode && (
            <motion.div
              key="list-check"
              className="flex shrink-0 items-center pl-2"
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -12 }}
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
        <button
          type="button"
          aria-current={active && !batchMode ? "true" : undefined}
          aria-label={t("automation.view.editTask")}
          onClick={onSelect}
          className="min-w-0 flex-1 px-2 py-2 pr-14 text-left"
        >
          {/* 第一行：排期描述（失败时换成最近失败提示，最显眼的信号优先） */}
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs",
              errored ? "text-red-500" : "text-muted-foreground",
            )}
          >
            {errored ? (
              <AlertCircleIcon className="size-3 shrink-0" />
            ) : running ? (
              <Loader2Icon className="text-primary size-3 shrink-0 animate-spin" />
            ) : (
              <ClockIcon className="size-3 shrink-0" />
            )}
            <span className="min-w-0 truncate">
              {errored ? t("automation.view.filter.error") : scheduleText}
            </span>
          </span>
          <span className="text-foreground mt-1 block truncate text-sm font-semibold">
            {task.name || t("automation.view.unnamedTask")}
          </span>
          <span className="text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="min-w-0 truncate tabular-nums">{statusLine}</span>
            {!running && task.enabled && countdown && task.lastRunAt && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0">
                  {t("automation.view.lastRun", { time: relativePast(task.lastRunAt, now) })}
                </span>
              </>
            )}
          </span>
        </button>
        {/* 开关常驻行尾（不随悬停消失）：清单页最重要的就是启停态；
            点击不冒泡到行（避免批量/选中态误触发） */}
        {!batchMode && (
          <span
            className="absolute top-2.5 right-2 flex"
            onClick={(e) => e.stopPropagation()}
          >
            <Switch
              size="sm"
              checked={task.enabled}
              onCheckedChange={onToggleEnabled}
              aria-label={t("automation.view.enableTaskAria", {
                name: task.name || t("automation.view.unnamedTask"),
              })}
            />
          </span>
        )}
      </div>
    </div>
  );
};

/** 右栏 · 新建态：手动/会话创建卡与模板卡同池混排（monocode 的 picker 同构） */
const CreateCard: FC<{
  icon: ReactNode;
  title: string;
  desc: string;
  /** 空白起点卡用虚线（monocode 的 Start from scratch 同款） */
  dashed?: boolean;
  onClick: () => void;
}> = ({ icon, title, desc, dashed, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex min-h-36 flex-col rounded-xl border p-4 text-start outline-none transition-colors duration-150 focus-visible:ring-ring/50 focus-visible:ring-2",
      dashed
        ? "border-dashed border-border hover:border-border/80 hover:bg-muted/40"
        : "border-border/60 hover:border-border hover:bg-muted/40",
    )}
  >
    <div className="flex gap-3">
      <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="text-foreground block truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground mt-1 block text-xs leading-snug">{desc}</span>
      </span>
    </div>
  </button>
);

const PickerPane: FC<{
  onBlank: () => void;
  onChatCreate: () => void;
  onPickTemplate: (template: AutomationTemplate) => void;
}> = ({ onBlank, onChatCreate, onPickTemplate }) => {
  const t = useT();
  return (
    // monocode 的 AutomationPicker 同构：标题随内容滚（不独立页头）、
    // 2 列网格、min-h-36 高卡、空白卡虚线
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none">
      <div className="mx-auto @container w-full max-w-7xl px-6 py-10 md:px-8 md:py-12">
        <h1 className="text-foreground text-xl font-semibold leading-tight">
          {t("automation.editor.titleNew")}
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {t("automation.editor.descDefault")}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 @[640px]:grid-cols-2 @[1024px]:grid-cols-3">
          <CreateCard
            dashed
            icon={<PlusIcon className="size-4" strokeWidth={1.75} />}
            title={t("automation.view.manualCreate")}
            desc={t("automation.view.blankDesc")}
            onClick={onBlank}
          />
          <CreateCard
            icon={<MessageSquareIcon className="size-4" strokeWidth={1.75} />}
            title={t("automation.view.chatCreate")}
            desc={t("automation.view.chatCreateDesc")}
            onClick={onChatCreate}
          />
          <TemplateGrid onPick={onPickTemplate} />
        </div>
      </div>
    </div>
  );
};

/** 详情宿主：useAutomationRunning 按 taskId 订阅，包一层让主视图不必条件化调 hook */
const EditorPaneHost: FC<{
  formEpochKey: string;
  task: AutomationTask | null;
  template: AutomationTemplate | null;
  historyTab?: ReactNode;
  onRunNow?: () => void;
  onSaved: () => void;
  onCancel?: () => void;
  onReset?: () => void;
  onRequestClearHistory?: () => void;
  onRequestDelete?: () => void;
}> = ({
  formEpochKey,
  task,
  template,
  historyTab,
  onRunNow,
  onSaved,
  onCancel,
  onReset,
  onRequestClearHistory,
  onRequestDelete,
}) => {
  const running = useAutomationRunning(task?.id);
  return (
    <AutomationEditorPane
      key={formEpochKey}
      task={task}
      template={template}
      historyTab={historyTab}
      running={running}
      onRunNow={onRunNow}
      onSaved={onSaved}
      onCancel={onCancel}
      onReset={onReset}
      onRequestClearHistory={onRequestClearHistory}
      onRequestDelete={onRequestDelete}
    />
  );
};

export const AutomationsView: FC<{
  /** 跳转会话后回到聊天（清菜单选中） */
  onBackToChat?: () => void;
  /** 侧边栏 ⚡ 徽标定位请求（nonce 保证重复点击同一任务也重新选中） */
  focusTask?: { taskId: string; nonce: number } | null;
  onFocusConsumed?: () => void;
}> = ({ onBackToChat, focusTask, onFocusConsumed }) => {
  const t = useT();
  const snap = useAutomations();
  const aui = useAui();
  /** 右栏两态：detail = 详情/编辑器，picker = 新建选择页 */
  const [view, setView] = useState<"detail" | "picker">("picker");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 从模板新建的进行中编辑（与 selectedId 互斥优先） */
  const [draftTemplate, setDraftTemplate] = useState<AutomationTemplate | null>(null);
  /** 空白新建的进行中编辑（右栏直接铺空白表单） */
  const [blankCreate, setBlankCreate] = useState(false);
  /** 编辑器表单重建计数：保存成功 / 重置后按最新任务数据重挂表单 */
  const [formEpoch, setFormEpoch] = useState(0);
  const [query, setQuery] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // 批量删除两段式确认（点一次变"确认删除"，3 秒不点自动回退）
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  /** 删除任务确认框的目标（null = 关闭） */
  const [askDeleteTask, setAskDeleteTask] = useState<AutomationTask | null>(null);
  const now = useNowTick();
  // 减弱动效偏好：批量坞升降退化为纯 opacity（项目惯例，见 todo-list）
  const reduce = useReducedMotion() ?? false;

  const selectedTask = useMemo(
    () => snap.tasks.find((task) => task.id === selectedId) ?? null,
    [snap.tasks, selectedId],
  );

  /** 应用 Header 的页面槽位（资料库同款）：标题/摘要/刷新 portal 到顶栏 */
  /** 壳层共享侧栏槽位：桌面端把任务清单列 portal 进去（一个侧栏，随菜单换
   *  内容），主区只留详情/新建；没有槽位时留在页内两栏 */
  const [listSlot, setListSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      setListSlot(
        mq.matches
          ? document.querySelector<HTMLElement>('[data-slot="section-sidebar"]')
          : null,
      );
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 每次进入页面主动拉一次：sidecar 可能在会话后台被 LLM 工具改过任务表
  useEffect(() => {
    void refreshAutomations();
  }, []);

  // 选中的任务被删（别处删除）时回到新建选择页，不留死详情
  useEffect(() => {
    if (view === "detail" && !draftTemplate && !blankCreate && selectedId && !selectedTask) {
      setSelectedId(null);
      setView("picker");
    }
  }, [view, draftTemplate, blankCreate, selectedId, selectedTask]);

  // 徽标定位：切换到详情态选中目标任务 + 短暂描边。清单可能还在加载（首进页面），
  // 找不到任务时按帧重试几次；用完通知宿主清请求（延迟到动效结束）
  useEffect(() => {
    if (!focusTask) return;
    setDraftTemplate(null);
    setBlankCreate(false);
    setView("detail");
    let cancelled = false;
    let tries = 0;
    const locate = () => {
      if (cancelled) return;
      if (snap.tasks.some((task) => task.id === focusTask.taskId)) {
        setSelectedId(focusTask.taskId);
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
  // automation/mgmt-tools.ts），直接说需求即可。
  const startViaChat = () => {
    onBackToChat?.();
    requestAnimationFrame(() => {
      aui.composer.setText(t("automation.view.promptPrefill"));
    });
  };

  const selectTask = (task: AutomationTask) => {
    if (batchMode) return;
    setDraftTemplate(null);
    setBlankCreate(false);
    setSelectedId(task.id);
    setView("detail");
  };
  const openFromTemplate = (template: AutomationTemplate) => {
    setDraftTemplate(template);
    setBlankCreate(false);
    setSelectedId(null);
    setView("detail");
  };

  // 新建保存后定位新任务：保存前记录已知 id 集，store 刷新后多出来的那个即新任务
  const knownIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [pendingCreateLocate, setPendingCreateLocate] = useState(false);
  useEffect(() => {
    if (!pendingCreateLocate) return;
    const fresh = snap.tasks.find((task) => !knownIdsRef.current.has(task.id));
    if (fresh) {
      setPendingCreateLocate(false);
      setDraftTemplate(null);
      setSelectedId(fresh.id);
      setFormEpoch((e) => e + 1);
    }
  }, [pendingCreateLocate, snap.tasks]);

  const onEditorSaved = () => {
    if (draftTemplate || blankCreate) {
      // 模板/空白新建：定位新任务（找不到就回落到选择页，清单里点选）
      setBlankCreate(false);
      knownIdsRef.current = new Set(snap.tasks.map((task) => task.id));
      setPendingCreateLocate(true);
      void refreshAutomations();
      return;
    }
    if (selectedTask) {
      // 已有任务：原地重挂表单吃进最新数据（保存应答会刷清单）
      setFormEpoch((e) => e + 1);
    }
  };

  const runNow = (task: AutomationTask) => {
    // 暂停任务立即运行：sidecar execute 对未启用任务静默跳过
    // （防重入/排队复验同样按 enabled），先恢复调度再触发，
    // 清单开关与表单开关会同步回弹，状态变化对用户可见而非无声失败
    void (async () => {
      if (!task.enabled) await setAutomationEnabled(task.id, true);
      await runAutomationNow(task.id);
    })();
  };

  const visibleTasks = useMemo(
    () => filterTasks(snap.tasks, query, "all"),
    [snap.tasks, query],
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

  // 批量坞状态：全选判定只看筛选后可见的行
  const allVisibleSelected = visibleTasks.length > 0 && selected.size === visibleTasks.length;
  const batchActionDisabled = batchBusy || selected.size === 0;
  const batchToggleDisabled = snap.tasks.length === 0;
  const toggleBatch = () => {
    batchMode ? exitBatch() : setBatchMode(true);
  };
  const batchActive = batchMode;

  // —— 运行记录删除（详情页签的单条删除 / ⋯菜单清空，共用一个确认框）——
  // 事实源删条目（all 走服务端整清）；"同时删除执行会话"是可选项：
  // 真实会话 id 由 run→session 帧记账映射得来，删侧边栏条目走 runtime
  // （自动切走当前会话），列表里没有的落回 delete_session 直删
  // 内容稳定切片：数组身份随发布重建时不触发本页重渲
  const threadItems = useThreadItems();
  const threadItemsRef = useRef(threadItems);
  threadItemsRef.current = threadItems;
  const [historyBusy, setHistoryBusy] = useState(false);

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
  };

  /** 详情页签 · 运行记录：该任务的执行时间线（run→session 可跳回会话） */
  const taskHistoryNode: ReactNode = selectedTask ? (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-0.5 px-6 py-8 md:px-8">
      {selectedTask.lastStatus === "error" && selectedTask.lastError && (
        <div
          className="text-red-500 bg-red-500/5 border-red-500/20 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
          title={selectedTask.lastError}
        >
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{selectedTask.lastError}</span>
        </div>
      )}
      {[...(selectedTask.runHistory ?? [])].reverse().map((entry) => (
        <HistoryRow
          key={entry.id}
          entry={entry}
          now={now}
          onOpenSession={openSession}
          onDelete={() =>
            requestHistoryDelete([{ taskId: selectedTask.id, runIds: [entry.id] }])
          }
        />
      ))}
      {(selectedTask.runHistory?.length ?? 0) === 0 && (
        <p className="text-muted-foreground px-2 py-6 text-center text-xs">
          {t("automation.view.noRunHistory")}
        </p>
      )}
    </div>
  ) : null;

  /** 右栏详情态渲染的编辑器目标：模板新建 / 空白新建 > 已选任务 */
  const editorTask = draftTemplate || blankCreate ? null : selectedTask;
  const creating = !!draftTemplate || blankCreate;

  return (
    <div className="relative flex h-full min-h-0">
      {/* —— 左栏：检索 + 新建 + 全局记录入口 + 任务清单 ——
          桌面端 portal 进壳层共享侧栏（与首页会话列表同一个槽位），
          主区只留详情/新建；没有槽位时留在页内（移动端） */}
      {(() => {
        const list = (
      <aside
        className={cn(
          "border-border/60 flex shrink-0 flex-col border-r",
          listSlot ? "h-full w-full border-r-0" : "w-[288px]",
        )}
      >
        {/* 搜索：独立一行（参考图2 的留白行，不再贴顶做工具条） */}
        <div className="shrink-0 px-2 pt-2">
          <label className="border-border/60 bg-background relative flex h-8 items-center rounded-lg border px-2 transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute left-2 size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("automation.view.searchTasksPlaceholder")}
              aria-label={t("automation.view.searchAria")}
              spellCheck={false}
              autoComplete="off"
              className="text-foreground placeholder:text-muted-foreground/60 h-8 w-full bg-transparent pl-6 pr-1 text-xs outline-none"
            />
          </label>
        </div>

        {/* 新建定时任务：独立一行（参考图2；进模板选择页），批量/刷新收在
            这一行右端 */}
        <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1">
          <Button
            variant="ghost"
            className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 text-sm font-normal"
            onClick={() => {
              exitBatch();
              setDraftTemplate(null);
              setSelectedId(null);
              setView("picker");
            }}
          >
            <PlusIcon className="size-4 shrink-0" />
            <span className="whitespace-nowrap">
              {t("automation.view.sidebarNew")}
            </span>
          </Button>
          <Button
            variant={batchActive ? "secondary" : "ghost"}
            size="icon"
            className="size-7 shrink-0"
            aria-label={t("automation.view.batchManage")}
            title={t("automation.view.batchManage")}
            disabled={batchToggleDisabled}
            onClick={toggleBatch}
          >
            <ListChecksIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={t("automation.view.refresh")}
            title={t("automation.view.refresh")}
            onClick={() => void refreshAutomations()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!snap.loaded && !snap.error ? (
            <div className="flex flex-col gap-1.5 p-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-md" />
              ))}
            </div>
          ) : (
            <>
              {snap.error ? (
                <p className="text-muted-foreground px-2.5 py-3 text-xs">
                  {t("automation.view.loadFailed")}
                </p>
              ) : snap.loaded && snap.tasks.length === 0 ? (
                <p className="text-muted-foreground px-2.5 py-3 text-xs">
                  {query.trim()
                    ? t("automation.view.noMatchQuery", { query: query.trim() })
                    : t("automation.view.emptyTasks")}
                </p>
              ) : visibleTasks.length === 0 ? (
                <p className="text-muted-foreground px-2.5 py-3 text-xs">
                  {t("automation.view.noMatchQuery", { query })}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {visibleTasks.map((task) => (
                    <TaskListItem
                      key={task.id}
                      task={task}
                      now={now}
                      active={view === "detail" && !draftTemplate && task.id === selectedId}
                      highlighted={highlightId === task.id}
                      batchMode={batchMode}
                      selected={selected.has(task.id)}
                      onSelect={() => selectTask(task)}
                      onToggleSelect={() => toggleSelect(task.id)}
                      onToggleEnabled={(enabled) =>
                        void setAutomationEnabled(task.id, enabled)
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
        );
        return listSlot ? createPortal(list, listSlot) : list;
      })()}

      {/* —— 右栏：详情 / 新建选择页 —— */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {snap.error && (
          <div className="text-red-500 bg-red-500/5 border-red-500/20 mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <AlertCircleIcon className="size-3.5 shrink-0" />
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

        {view === "picker" ? (
          <PickerPane
            onBlank={() => {
              setDraftTemplate(null);
              setBlankCreate(true);
              setSelectedId(null);
              setView("detail");
              setFormEpoch((e) => e + 1);
            }}
            onChatCreate={startViaChat}
            onPickTemplate={openFromTemplate}
          />
        ) : !snap.loaded && !snap.error && !creating && !editorTask ? (
          <div className="grid flex-1 place-items-center text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
        ) : (
          <EditorPaneHost
            // 每次切目标/保存/重置都按最新数据重建表单态
            formEpochKey={`${editorTask?.id ?? draftTemplate?.id ?? "new"}:${formEpoch}`}
            task={editorTask}
            template={draftTemplate}
            historyTab={taskHistoryNode}
            onRunNow={editorTask ? () => runNow(editorTask) : undefined}
            onSaved={onEditorSaved}
            onCancel={
              creating
                ? () => {
                    setDraftTemplate(null);
                    setBlankCreate(false);
                    setSelectedId(null);
                    setView("picker");
                  }
                : undefined
            }
            onReset={editorTask ? () => setFormEpoch((e) => e + 1) : undefined}
            onRequestClearHistory={
              editorTask
                ? () => requestHistoryDelete([{ taskId: editorTask.id, all: true }])
                : undefined
            }
            onRequestDelete={editorTask ? () => setAskDeleteTask(editorTask) : undefined}
          />
        )}
      </main>

      {/* 批量操作坞：底部居中的悬浮图标条（Dock 风格）。外层 pointer-events-none
          只让坞本体可点，悬浮不遮两侧内容的滚轮操作；根容器不滚（滚动都在
          两侧栏内部），absolute 常驻底缘即可 */}
      <div className="pointer-events-none absolute bottom-4 left-0 right-0 z-20">
        <AnimatePresence initial={false}>
          {batchMode && (
            <motion.div
              key="batch-dock"
              className="flex justify-center"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 18 }}
              transition={SPRING_LAYOUT}
            >
              <Dock size={36} className="pointer-events-auto">
                <span className="bg-muted text-muted-foreground self-center rounded-full px-2 py-0.5 text-xs tabular-nums">
                  {t("automation.view.batchSelected", { count: selected.size })}
                </span>
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
        </AnimatePresence>
      </div>

      {/* 删除任务二次确认（详情 ⋯ 菜单进）：确认后立即关窗再发请求 */}
      <AlertDialog open={!!askDeleteTask} onOpenChange={(open) => !open && setAskDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("automation.view.deleteTaskTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automation.view.deleteTaskDesc", {
                name: askDeleteTask?.name || t("automation.view.unnamedTask"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("automation.view.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                const task = askDeleteTask;
                setAskDeleteTask(null);
                if (!task) return;
                void (async () => {
                  try {
                    await deleteAutomation(task.id);
                  } catch {
                    // 错误经镜像 store 横幅呈现
                  }
                  exitBatch();
                })();
              }}
            >
              {t("automation.view.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

    </div>
  );
};
