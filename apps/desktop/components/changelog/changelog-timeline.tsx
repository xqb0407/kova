"use client";

/**
 * 更新日志时间线：设置页完整历史与升级弹窗共用同一套渲染。
 * `timeline`：左侧竖线 + 版本节点 + 卡片（完整历史页）；
 * `flat`：无轨道、无内层卡片，纯列表铺在弹窗背景上（升级弹窗）。
 */
import type { FC } from "react";
import { InlineMarkdown } from "@/lib/changelog/inline";
import type { ChangelogEntry } from "@/lib/changelog";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** CHANGELOG 的分区标题是英文原文；展示时按界面语言映射，未知标题原样保留。
 *  小圆点给分区一个可扫读的颜色锚（不抢正文注意力）。 */
const SECTION_META: Record<string, { labelKey: string; dot: string }> = {
  added: {
    labelKey: "settings.changelog.sections.added",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  changed: {
    labelKey: "settings.changelog.sections.changed",
    dot: "bg-sky-500 dark:bg-sky-400",
  },
  fixed: {
    labelKey: "settings.changelog.sections.fixed",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  removed: {
    labelKey: "settings.changelog.sections.removed",
    dot: "bg-rose-500 dark:bg-rose-400",
  },
  deprecated: {
    labelKey: "settings.changelog.sections.deprecated",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  security: {
    labelKey: "settings.changelog.sections.security",
    dot: "bg-violet-500 dark:bg-violet-400",
  },
};

export const ChangelogTimeline: FC<{
  entries: readonly ChangelogEntry[];
  /** 应用当前版本：对应条目显示「当前版本」徽标 */
  currentVersion?: string | null;
  /** timeline：完整日志页（左轨 + 卡片）；flat：弹窗纯列表（无内层卡片） */
  variant?: "timeline" | "flat";
  className?: string;
}> = ({ entries, currentVersion, variant = "timeline", className }) => {
  const t = useT();
  const showRail = variant === "timeline";
  const flat = variant === "flat";

  return (
    <div className={cn("flex flex-col", className)}>
      {entries.map((entry, entryIndex) => {
        const isCurrent =
          currentVersion !== null &&
          currentVersion !== undefined &&
          currentVersion.trim().replace(/^v/u, "") === entry.version;
        const isLast = entryIndex === entries.length - 1;
        return (
          <div key={entry.version} className={cn(showRail && "flex gap-3")}>
            {/* 时间线轨道：节点 + 连接下一条的竖线 */}
            {showRail ? (
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
            ) : null}

            <article
              className={cn(
                "min-w-0 flex-1",
                flat ? "py-0.5" : "bg-muted/50 rounded-2xl p-5",
                !isLast && (flat ? "mb-8" : "mb-4"),
              )}
            >
              {flat && entries.length === 1 ? null : (
                <header
                  className={cn(
                    "flex flex-wrap items-baseline gap-x-3 gap-y-1",
                    flat && "border-border/60 border-b pb-3",
                  )}
                >
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
              )}

              {entry.intro ? (
                <p className="text-muted-foreground mt-3 text-sm leading-6">
                  <InlineMarkdown text={entry.intro} />
                </p>
              ) : null}

              <div className="mt-4 flex flex-col gap-4">
                {entry.sections.map((section, sectionIndex) => {
                  const meta =
                    SECTION_META[section.title.trim().toLowerCase()];
                  return (
                    <section
                      key={`${entry.version}-section-${sectionIndex}`}
                      className="flex flex-col gap-2"
                    >
                      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide">
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            meta?.dot ?? "bg-muted-foreground/40",
                          )}
                        />
                        {meta ? t(meta.labelKey) : section.title}
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
