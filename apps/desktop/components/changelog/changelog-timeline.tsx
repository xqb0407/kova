"use client";

/**
 * 更新日志时间线：设置页完整历史与升级弹窗共用同一套渲染。
 * 左侧一条竖线 + 版本节点，当前版本节点高亮。
 */
import type { FC } from "react";
import { InlineMarkdown } from "@/lib/changelog/inline";
import type { ChangelogEntry } from "@/lib/changelog";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** CHANGELOG 的分区标题是英文原文；展示时按界面语言映射，未知标题原样保留 */
const SECTION_LABEL_KEYS: Record<string, string> = {
  added: "settings.changelog.sections.added",
  changed: "settings.changelog.sections.changed",
  fixed: "settings.changelog.sections.fixed",
  removed: "settings.changelog.sections.removed",
  deprecated: "settings.changelog.sections.deprecated",
  security: "settings.changelog.sections.security",
};

export const ChangelogTimeline: FC<{
  entries: readonly ChangelogEntry[];
  /** 应用当前版本：对应条目显示「当前版本」徽标 */
  currentVersion?: string | null;
  className?: string;
}> = ({ entries, currentVersion, className }) => {
  const t = useT();

  return (
    <div className={cn("flex flex-col", className)}>
      {entries.map((entry, entryIndex) => {
        const isCurrent =
          currentVersion !== null &&
          currentVersion !== undefined &&
          currentVersion.trim().replace(/^v/u, "") === entry.version;
        const isLast = entryIndex === entries.length - 1;
        return (
          <div key={entry.version} className="flex gap-3">
            {/* 时间线轨道：节点 + 连接下一条的竖线 */}
            <div
              aria-hidden
              className="relative flex w-4 shrink-0 justify-center"
            >
              {!isLast ? (
                <span className="bg-border absolute top-7 -bottom-7 w-px" />
              ) : null}
              <span
                className={cn(
                  "relative z-10 mt-6 size-2.5 rounded-full border-2",
                  isCurrent
                    ? "border-primary bg-primary"
                    : "border-border bg-background",
                )}
              />
            </div>

            <article
              className={cn(
                "bg-muted/50 min-w-0 flex-1 rounded-2xl p-5",
                !isLast && "mb-4",
              )}
            >
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="font-mono text-base font-semibold tracking-tight">
                  v{entry.version}
                </h2>
                {entry.date ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {entry.date}
                  </span>
                ) : null}
                {isCurrent ? (
                  <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[11px] font-medium">
                    {t("settings.changelog.current")}
                  </span>
                ) : null}
              </header>

              {entry.intro ? (
                <p className="text-muted-foreground mt-3 text-sm leading-6">
                  <InlineMarkdown text={entry.intro} />
                </p>
              ) : null}

              <div className="mt-4 flex flex-col gap-4">
                {entry.sections.map((section, sectionIndex) => {
                  const labelKey =
                    SECTION_LABEL_KEYS[section.title.trim().toLowerCase()];
                  return (
                    <section
                      key={`${entry.version}-section-${sectionIndex}`}
                      className="flex flex-col gap-2"
                    >
                      <h3 className="text-muted-foreground text-xs font-medium tracking-wide">
                        {labelKey ? t(labelKey) : section.title}
                      </h3>
                      <ul className="flex flex-col gap-2">
                        {section.items.map((item, itemIndex) => (
                          <li
                            key={`${entry.version}-${sectionIndex}-${itemIndex}`}
                            className="flex gap-2.5 text-sm leading-6"
                          >
                            <span
                              aria-hidden
                              className="bg-foreground/25 mt-[0.6875rem] size-1 shrink-0 rounded-full"
                            />
                            <span className="min-w-0">
                              <InlineMarkdown text={item} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </article>
          </div>
        );
      })}
    </div>
  );
};
