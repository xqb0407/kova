/**
 * 自动化任务的人话描述（纯函数，管理页/徽标/编辑器共用）：
 * 把 vendor 调度器的三种 schedule 字符串（cron 表达式 / "+30m|ISO" / "30m"）
 * 翻成中文摘要与倒计时。刻意不引 sidecar 依赖 —— 前端侧只做展示层翻译，
 * 合法性判定的事实源始终在 sidecar（preview/save 应答）。
 */

export type ScheduleShape = {
  type: "cron" | "once" | "interval";
  schedule: string;
  intervalSeconds: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** "3600" → "1 小时"；interval 人话化（整分/时/天优先，其余落秒） */
export function describeIntervalSeconds(sec: number): string {
  if (sec % 86400 === 0) return `每 ${sec / 86400} 天`;
  if (sec % 3600 === 0) return `每 ${sec / 3600} 小时`;
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟`;
  return `每 ${sec} 秒`;
}

/** 把 5 字段 cron 尽力翻成中文；不认识的形态回退 "Cron: <expr>" */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Cron: ${expr}`;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s) ? Number(s) : undefined;
  const hm =
    num(min) !== undefined && num(hour) !== undefined
      ? `${pad(Number(hour))}:${pad(Number(min))}`
      : undefined;
  if (mon !== "*" ) return `Cron: ${expr}`; // 指定月份太少见，交回原始式

  // 每 N 分钟（*/10 * * * * 或 0/10）
  const everyMin = min.match(/^(\*|\d+)\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && dow === "*") {
    return `每 ${everyMin[2]} 分钟`;
  }
  const everyHour = hour.match(/^(\*|\d+)\/(\d+)$/);
  if (everyHour && dom === "*" && mon === "*" && dow === "*" && min === "0") {
    return `每 ${everyHour[2]} 小时`;
  }
  if (min === "*" && hour === "*" && dom === "*" && dow === "*") return "每分钟";

  // 每天 / 工作日 / 每周几 / 每月几号 的固定时刻形态
  if (hm && dom === "*" && mon === "*") {
    if (dow === "*") return `每天 ${hm}`;
    if (dow === "1-5") return `工作日 ${hm}`;
    const days = dow.match(/^\d+$/)
      ? [Number(dow)]
      : dow.split(",").every((d) => /^\d$/.test(d))
        ? dow.split(",").map(Number)
        : null;
    if (days) return `每周${days.map((d) => WEEKDAY_CN[d % 7]).join("、")} ${hm}`;
  }
  if (hm && dow === "*" && num(dom) !== undefined) return `每月 ${num(dom)} 日 ${hm}`;
  return `Cron: ${expr}`;
}

/** 排期摘要一行字（卡片副标题处用） */
export function describeSchedule(t: ScheduleShape): string {
  if (t.type === "interval") return describeIntervalSeconds(t.intervalSeconds);
  if (t.type === "once") return `一次性 · ${formatDateTime(t.schedule)}`;
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

const UNIT_CN = { s: "秒", m: "分钟", h: "小时", d: "天" } as const;

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
    return sec ? describeIntervalSeconds(sec) : `间隔 ${t.schedule}`;
  }
  if (t.type === "once") {
    const m = /^\+(\d+)(s|m|h|d)$/.exec(t.schedule.trim());
    if (m && m[1] && m[2]) return `一次性 · ${m[1]} ${UNIT_CN[m[2] as keyof typeof UNIT_CN]}后`;
    return `一次性 · ${formatDateTime(t.schedule)}`;
  }
  return describeCron(t.schedule);
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  const ymd = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${ymd} ${time}`;
}

/** "刚刚 / N 分钟前 / N 小时前 / N 天前"（粗粒度，与会话列表同款口径） */
export function relativePast(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = nowMs - t;
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

/** 下次运行倒计时（"3 分钟后 / 2 小时 5 分后 / 明天 09:00"式）；无排期回 "" */
export function nextRunLabel(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = t - nowMs;
  if (diff <= 0) return "即将触发";
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒后`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟后`;
  if (diff < 6 * 3_600_000) {
    const h = Math.floor(diff / 3_600_000);
    const m = Math.round((diff % 3_600_000) / 60_000);
    return m > 0 ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
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
  if (dayGap === 0) return `今天 ${time}`;
  if (dayGap === 1) return `明天 ${time}`;
  if (dayGap === 2) return `后天 ${time}`;
  return `${dayGap} 天后 (${formatDateTime(iso)})`;
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
