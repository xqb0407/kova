"use client";

/** 收件箱「稍后提醒」预设：只负责算 ISO 时间，写入仍走 update_inbox。 */

export type SnoozePreset = "1h" | "tomorrow" | "1w";

/** 明天 09:00（本地时区）；已经过了今天 09:00 也仍是明天。 */
function tomorrowMorning(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

export function snoozeUntil(preset: SnoozePreset, now = Date.now()): string {
  const date = new Date(now);
  if (preset === "1h") date.setHours(date.getHours() + 1);
  else if (preset === "tomorrow") return tomorrowMorning(date).toISOString();
  else date.setDate(date.getDate() + 7);
  return date.toISOString();
}
