import type { ChangelogEntry } from "../apps/desktop/lib/changelog/types";

/** scripts/build-changelog.mjs 的解析入口（供单测从 TS 侧引用） */
export function parseChangelog(markdown: string): ChangelogEntry[];
