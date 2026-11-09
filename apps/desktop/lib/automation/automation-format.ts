/**
 * 自动化任务的人话描述（纯函数，管理页/徽标/编辑器共用）：
 * 把 vendor 调度器的三种 schedule 字符串（cron 表达式 / "+30m|ISO" / "30m"）
 * 翻成当前语言摘要与倒计时。刻意不引 sidecar 依赖 —— 前端侧只做展示层翻译，
 * 合法性判定的事实源始终在 sidecar（preview/save 应答）。
 */

import { getLocale, t as tFn } from "@/lib/i18n";

export type ScheduleShape = {
  type: "cron" | "once" | "interval";
  schedule: string;
  intervalSeconds: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAY_KEY = [
  "weekdaySun",
  "weekdayMon",
  "weekdayTue",
  "weekdayWed",
  "weekdayThu",
  "weekdayFri",
  "weekdaySat",
] as const;

/** 星期文案：中文词典给单字（每周一、三），英文词典给完整名（Monday, Wednesday） */
function weekdayName(day: number): string {
  return tFn(`automation.format.${WEEKDAY_KEY[day % 7]!}`);
}

/** "3600" → "每 1 小时"；interval 人话化（整分/时/天优先，其余落秒） */
export function describeIntervalSeconds(sec: number): string {
  if (sec % 86400 === 0) {
    const n = sec / 86400;
    return tFn(`automation.format.intervalDay${n === 1 ? "One" : ""}`, { n });
  }
  if (sec % 3600 === 0) {
    const n = sec / 3600;
    return tFn(`automation.format.intervalHour${n === 1 ? "One" : ""}`, { n });
  }
  if (sec % 60 === 0) {
    const n = sec / 60;
    return tFn(`automation.format.intervalMinute${n === 1 ? "One" : ""}`, { n });
  }
  return tFn(`automation.format.intervalSecond${sec === 1 ? "One" : ""}`, { n: sec });
}

/** 把 5 字段 cron 尽力翻成当前语言；不认识的形态回退 "Cron: <expr>" */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return tFn("automation.format.cronFallback", { expr });
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s) ? Number(s) : undefined;
  const hm =
    num(min) !== undefined && num(hour) !== undefined
      ? `${pad(Number(hour))}:${pad(Number(min))}`
      : undefined;
  if (mon !== "*" ) return tFn("automation.format.cronFallback", { expr }); // 指定月份太少见，交回原始式

  // 每 N 分钟（*/10 * * * * 或 0/10）
  const everyMin = min.match(/^(\*|\d+)\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(everyMin[2]);
    return tFn(`automation.format.everyNMinutes${n === 1 ? "One" : ""}`, { n });
  }
  const everyHour = hour.match(/^(\*|\d+)\/(\d+)$/);
  if (everyHour && dom === "*" && mon === "*" && dow === "*" && min === "0") {
    const n = Number(everyHour[2]);
    return tFn(`automation.format.everyNHours${n === 1 ? "One" : ""}`, { n });
  }
  if (min === "*" && hour === "*" && dom === "*" && dow === "*") {
    return tFn("automation.format.everyMinute");
  }

  // 每天 / 工作日 / 每周几 / 每月几号 的固定时刻形态
  if (hm && dom === "*" && mon === "*") {
    if (dow === "*") return tFn("automation.format.dailyAt", { time: hm });
    if (dow === "1-5") return tFn("automation.format.weekdaysAt", { time: hm });
    const days = dow.match(/^\d+$/)
      ? [Number(dow)]
      : dow.split(",").every((d) => /^\d$/.test(d))
        ? dow.split(",").map(Number)
        : null;
    if (days) {
      return tFn("automation.format.weeklyAt", {
        days: days.map((d) => weekdayName(d)).join(getLocale() === "zh" ? "、" : ", "),
        time: hm,
      });
    }
  }
  const domNum = num(dom);
  if (hm && dow === "*" && domNum !== undefined) {
    return tFn("automation.format.monthlyAt", { day: domNum, time: hm });
  }
  return tFn("automation.format.cronFallback", { expr });
}

/** 排期摘要一行字（卡片副标题处用） */
export function describeSchedule(t: ScheduleShape): string {
  if (t.type === "interval") return describeIntervalSeconds(t.intervalSeconds);
  if (t.type === "once") {
    return tFn("automation.format.once", { time: formatDateTime(t.schedule) });
  }
  return describeCron(t.schedule);
}

export type ScheduleKind = "once" | "weekly" | "repeated" | "daily";

/**
 * 任务"身份"分类（卡片图标底座选色用）：
 * once=一次性；interval 与分钟/小时级 cron 归 repeated（高频节律）；
 * cron 指定星期几（工作日 1-5 除外）归 weekly；其余定点形态（每天、
 * 工作日、每月/每年几号）都落 daily。
 */
export function scheduleKind(t: ScheduleShape): ScheduleKind {
  if (t.type === "once") return "once";
  if (t.type === "interval") return "repeated";
  const fields = t.schedule.trim().split(/\s+/);
  if (fields.length !== 5) return "daily";
  const [min, hour, , , dow] = fields as [string, string, string, string, string];
  if (dow !== "*" && dow !== "1-5") return "weekly";
  if (hour === "*" || min === "*" || /^\d+\/\d+$|^\*\/\d+$/.test(min)) return "repeated";
  return "daily";
}

/** "6h" 形态的 interval 文本 → 秒；不合法回 undefined（vendor 同款正则） */
export function parseIntervalSeconds(schedule: string): number | undefined {
  const m = /^(\d+)(s|m|h|d)$/.exec(schedule.trim());
  if (!m || !m[1] || !m[2]) return undefined;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * mult;
}

const UNIT_KEY = { s: "Second", m: "Minute", h: "Hour", d: "Day" } as const;

/**
 * 预置模板的排期摘要：模板 schedule 可能是相对形态（interval "6h" /
 * once "+1d"，保存时才由 sidecar 起算），这里翻成"每 6 小时 / 一天后"；
 * once 的绝对 ISO 走通用 formatDateTime，cron 走 describeCron。
 */
export function describeTemplateSchedule(t: {
  type: "cron" | "once" | "interval";
  schedule: string;
}): string {
  if (t.type === "interval") {
    const sec = parseIntervalSeconds(t.schedule);
    return sec
      ? describeIntervalSeconds(sec)
      : tFn("automation.format.intervalFallback", { schedule: t.schedule });
  }
  if (t.type === "once") {
    const m = /^\+(\d+)(s|m|h|d)$/.exec(t.schedule.trim());
    if (m && m[1] && m[2]) {
      const n = Number(m[1]);
      const unitKey = `unit${UNIT_KEY[m[2] as keyof typeof UNIT_KEY]}${n === 1 ? "" : "Plural"}`;
      return tFn("automation.format.onceIn", {
        n,
        unit: tFn(`automation.format.${unitKey}`),
      });
    }
    return tFn("automation.format.once", { time: formatDateTime(t.schedule) });
  }
  return describeCron(t.schedule);
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return tFn("automation.format.dash");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  if (getLocale() === "en") {
    return new Intl.DateTimeFormat("en-US", {
      ...(sameYear ? {} : { year: "numeric" }),
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  }
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const ymd = sameYear
    ? tFn("automation.format.dateMonthDay", { month, day })
    : tFn("automation.format.dateYearMonthDay", {
        year: d.getFullYear(),
        month,
        day,
      });
  return `${ymd} ${time}`;
}

/** "刚刚 / N 分钟前 / N 小时前 / N 天前"（粗粒度，与会话列表同款口径） */
export function relativePast(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = nowMs - t;
  if (diff < 45_000) return tFn("automation.format.justNow");
  if (diff < 3_600_000) return tFn("automation.format.minutesAgo", { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return tFn("automation.format.hoursAgo", { n: Math.round(diff / 3_600_000) });
  return tFn("automation.format.daysAgo", { n: Math.round(diff / 86_400_000) });
}

/** 下次运行倒计时（"3 分钟后 / 2 小时 5 分后 / 明天 09:00"式）；无排期回 "" */
export function nextRunLabel(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = t - nowMs;
  if (diff <= 0) return tFn("automation.format.dueNow");
  if (diff < 60_000) return tFn("automation.format.secondsLater", { n: Math.max(1, Math.floor(diff / 1000)) });
  if (diff < 3_600_000) return tFn("automation.format.minutesLater", { n: Math.floor(diff / 60_000) });
  if (diff < 6 * 3_600_000) {
    const h = Math.floor(diff / 3_600_000);
    const m = Math.round((diff % 3_600_000) / 60_000);
    return m > 0
      ? tFn("automation.format.hoursMinutesLater", { h, m })
      : tFn("automation.format.hoursLater", { h });
  }
  const d = new Date(t);
  const today = new Date(nowMs);
  const dayGap = Math.floor(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // 凌晨跨过 6h 档位后看当天排期（如 00:30 看当天 09:00）dayGap 为 0，
  // 不早退会漏进 "N 天后" 分支显示 "0 天后 (…)"
  if (dayGap === 0) return tFn("automation.format.todayAt", { time });
  if (dayGap === 1) return tFn("automation.format.tomorrowAt", { time });
  if (dayGap === 2) return tFn("automation.format.dayAfterAt", { time });
  return tFn("automation.format.daysLater", {
    n: dayGap,
    date: formatDateTime(iso),
  });
}

// —— 编辑器：cron 表达式 ↔ 预设形态 ——

export type CronPreset =
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; hour: number; minute: number; days: number[] }
  | { mode: "monthly"; hour: number; minute: number; day: number }
  | { mode: "raw"; expr: string };

/** 反解析已存 cron 到预设表单（识别不了走 raw 原样编辑） */
export function cronToPreset(expr: string): CronPreset {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { mode: "raw", expr };
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);
  const m = num(min);
  const h = num(hour);
  if (m === undefined || h === undefined || mon !== "*") return { mode: "raw", expr };
  if (dom === "*" && dow === "*") return { mode: "daily", hour: h, minute: m };
  if (dom === "*") {
    if (dow === "1-5") return { mode: "weekly", hour: h, minute: m, days: [1, 2, 3, 4, 5] };
    const parts = dow.split(",");
    if (parts.length > 0 && parts.every((p) => /^\d+$/.test(p))) {
      return { mode: "weekly", hour: h, minute: m, days: parts.map(Number) };
    }
  }
  const d = num(dom);
  if (d !== undefined && dow === "*") return { mode: "monthly", hour: h, minute: m, day: d };
  return { mode: "raw", expr };
}

export function presetToCron(p: CronPreset): string {
  switch (p.mode) {
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekly": {
      const sorted = [...new Set(p.days.map((d) => d % 7))].sort((a, b) => a - b);
      return `${p.minute} ${p.hour} * * ${sorted.join(",")}`;
    }
    case "monthly":
      return `${p.minute} ${p.hour} ${p.day} * *`;
    case "raw":
      return p.expr.trim();
  }
}
