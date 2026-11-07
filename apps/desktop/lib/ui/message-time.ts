/**
 * 消息时间戳展示（纯函数，便于单测）。
 *
 * 消息流里给的是绝对时刻，不是侧栏那种「3天前」：读历史时「昨天 21:06」比
 * 「1天前」有用得多。当天只给时刻，跨天才补日期——绝大多数消息都在当天，
 * 天天带日期只是噪音。
 *
 * 双语（lib/i18n）：中文沿用自拼模板；英文走 Intl.DateTimeFormat（12 小时制、
 * "Nov 1, 9:06 PM" 式）。locale 由调用方传入，缺省取当前界面语言。
 */
import { getLocale, type Locale } from "@/lib/i18n";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 消息时间：今天 "21:06" / 昨天 "昨天 21:06" / 跨年带年份（英文 12 小时制） */
export function formatMessageTime(
  ms: number,
  now = Date.now(),
  locale: Locale = getLocale(),
): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const n = new Date(now);
  if (Number.isNaN(d.getTime()) || Number.isNaN(n.getTime())) return null;
  // 按自然日取整（不是 24h 差）：凌晨刚过时「昨天 23:50」才读得对。
  // 负值（时间戳在未来，时钟偏差/脏数据）按今天处理，别显示成明天的日期
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000);
  if (locale === "en") {
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
    if (dayDiff <= 0) return time;
    if (dayDiff === 1) return `Yesterday ${time}`;
    const date = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(d);
    const dated =
      d.getFullYear() === n.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
    return `${dated}, ${time}`;
  }
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (dayDiff <= 0) return clock;
  if (dayDiff === 1) return `昨天 ${clock}`;
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (d.getFullYear() === n.getFullYear()) return `${date} ${clock}`;
  return `${d.getFullYear()}年${date} ${clock}`;
}

/** 悬停提示用的完整时刻："2026年11月7日 21:06" / "Nov 7, 2026, 9:06 PM" */
export function formatMessageTimeFull(
  ms: number,
  locale: Locale = getLocale(),
): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  if (locale === "en") {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** Date → ms；无效/缺失一律 0（formatMessageTime 会返回 null） */
export function messageTimeMs(value: Date | number | undefined): number {
  const ms = value instanceof Date ? value.getTime() : value;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}
