/**
 * 自动化「运行记录」全局视图的数据层（纯函数，无 React/tauri 依赖）：
 * 把各任务记录里的 runHistory 摊平成全局时间线、按天分组，并提供
 * 任务/记录两处搜索过滤。事实源仍在 sidecar 任务表（automation_list
 * 应答自带 runHistory），这里只做展示变换。
 */

export type RunHistoryEntry = {
  id: string;
  status: string;
  createdAt: string;
  sessionId?: string;
  message?: string;
};

export type HistoryTaskLike = {
  id: string;
  name?: string;
  runHistory?: RunHistoryEntry[];
};

/** 摊平后的一条全局记录：带上归属任务，供跨任务时间线渲染 */
export type HistoryItem = {
  /** entry.id 即 run→session 映射的键（automation-run-map） */
  runId: string;
  taskId: string;
  taskName: string;
  status: string;
  createdAt: string;
  message?: string;
};

const HISTORY_STATUS_LABEL: Record<string, string> = {
  success: "成功",
  error: "失败",
  running: "运行中",
  queued: "排队中",
  paused: "暂停排期",
  resumed: "恢复排期",
};

export function historyStatusLabel(status: string): string {
  return HISTORY_STATUS_LABEL[status] ?? status;
}

/** 全部任务的运行记录摊平 + 按 createdAt 倒序（非法时间自然沉底 NaN 比较） */
export function flattenRunHistory(tasks: HistoryTaskLike[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const t of tasks) {
    for (const e of t.runHistory ?? []) {
      items.push({
        runId: e.id,
        taskId: t.id,
        taskName: t.name || "未命名任务",
        status: e.status,
        createdAt: e.createdAt,
        message: e.message,
      });
    }
  }
  return items.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日历日 key（YYYY-MM-DD）；非法时间归入 "invalid" 组 */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type HistoryDayGroup = { key: string; label: string; items: HistoryItem[] };

/** 按本地日分组（保持入参的倒序）；标签：今天/昨天/N月N日/跨年带年份 */
export function groupHistoryByDay(items: HistoryItem[], nowMs = Date.now()): HistoryDayGroup[] {
  const todayKey = localDayKey(new Date(nowMs).toISOString());
  const yesterdayKey = localDayKey(new Date(nowMs - 86_400_000).toISOString());
  const groups: HistoryDayGroup[] = [];
  for (const item of items) {
    const key = localDayKey(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      continue;
    }
    let label: string;
    if (key === todayKey) label = "今天";
    else if (key === yesterdayKey) label = "昨天";
    else {
      const [y, m, d] = key.split("-").map(Number);
      if (!y) label = key;
      else label = y === new Date(nowMs).getFullYear() ? `${m}月${d}日` : `${y}年${m}月${d}日`;
    }
    groups.push({ key, label, items: [item] });
  }
  return groups;
}

// —— 搜索 / 筛选 ——

export type TaskFilter = "all" | "enabled" | "paused" | "error";

export const TASK_FILTER_LABEL: Record<TaskFilter, string> = {
  all: "全部状态",
  enabled: "启用中",
  paused: "已暂停",
  error: "最近失败",
};

export type FilterableTask = {
  id: string;
  name?: string;
  prompt: string;
  enabled: boolean;
  lastStatus?: string;
};

/** 任务清单过滤：关键词命中名称或指令（不区分大小写），状态按启用/暂停/最近失败 */
export function filterTasks<T extends FilterableTask>(
  tasks: T[],
  query: string,
  status: TaskFilter,
): T[] {
  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q && !`${t.name ?? ""} ${t.prompt}`.toLowerCase().includes(q)) return false;
    if (status === "enabled" && !t.enabled) return false;
    if (status === "paused" && t.enabled) return false;
    if (status === "error" && t.lastStatus !== "error") return false;
    return true;
  });
}

/** 运行记录过滤：关键词命中任务名或状态中文标签 */
export function filterHistoryItems(items: HistoryItem[], query: string): HistoryItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) =>
    `${i.taskName} ${historyStatusLabel(i.status)}`.toLowerCase().includes(q),
  );
}
