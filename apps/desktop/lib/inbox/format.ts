"use client";

import type { useT } from "@/lib/i18n";

/** 收件箱相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relativeTime(
  iso: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return t("inbox.time.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("inbox.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("inbox.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("inbox.time.daysAgo", { n: days });
  return new Date(at).toLocaleDateString();
}
