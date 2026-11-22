/** 更新日志查询入口：数据由构建脚本从 CHANGELOG.md / CHANGELOG_EN.md 生成。 */
import { CHANGELOG_ENTRIES, CHANGELOG_ENTRIES_EN } from "./generated";
import type { ChangelogEntry } from "./types";

export { CHANGELOG_ENTRIES, CHANGELOG_ENTRIES_EN };
export type { ChangelogEntry, ChangelogSection } from "./types";

/** 按界面语言取日志；英文缺失时回落中文，保证页面始终有内容 */
export function changelogForLocale(
  locale: string | null | undefined,
): readonly ChangelogEntry[] {
  return locale === "en" && CHANGELOG_ENTRIES_EN.length > 0
    ? CHANGELOG_ENTRIES_EN
    : CHANGELOG_ENTRIES;
}

/** 按版本号取一条日志（桌面端当前版本 = 应用版本，精确匹配） */
export function entryForVersion(
  version: string | null | undefined,
  locale: string | null | undefined = "zh",
): ChangelogEntry | null {
  if (!version) return null;
  const normalized = version.trim().replace(/^v/u, "");
  if (!normalized) return null;
  return (
    changelogForLocale(locale).find((entry) => entry.version === normalized) ??
    null
  );
}
