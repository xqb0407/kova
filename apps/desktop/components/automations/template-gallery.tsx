"use client";

/**
 * 新建页的模板卡网格：不带分区标题，与「手动/会话创建」卡同池混排。
 *
 * 摊开而不是弹窗，是因为模板是这一页的"入门路径"而不是低频动作：没建过任务
 * 的人第一眼就要看到它，藏在二级弹窗里等于不存在。点卡片只把预置值灌进
 * AutomationEditorPane（表单可改），不直接落库 —— 与原弹窗同一语义。
 *
 * 清单来自 sidecar automation_templates（lib 里模块级缓存，进页面拉一次即可）。
 *
 * 卡片解剖（monocode 同款）：圆底小图标 + 名称/描述两行 + 卡底一行小字排期，
 * 不做彩色瓷片也不做悬停投影——模板之间的差别只有"干什么"和"什么时候跑"
 * 两件事，色块和动效都说不了这两件事，只会把网格变成卡片墙。
 */

import { useEffect, useState, type ComponentType, type FC } from "react";
import {
  ActivityIcon,
  AlarmClockIcon,
  AlertCircleIcon,
  ClockIcon,
  FileChartColumnIcon,
  RadarIcon,
  RepeatIcon,
  SunriseIcon,
  TimerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchAutomationTemplates,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import { describeTemplateSchedule } from "@/lib/automation/automation-format";
import { useT, type TFunc } from "@/lib/i18n";

type TemplateIcon = ComponentType<{ className?: string }>;

/** 图标讲"干什么"：晨报=日出 · 周报=插入柱图的报告 · 体检=心电 · 巡检=雷达 ·
 *  提醒=闹钟。只挑 lucide 里语义直接命中的那一个，不做隐喻 */
const TEMPLATE_ICON: Record<string, TemplateIcon> = {
  "tpl-daily-briefing": SunriseIcon,
  "tpl-weekly-report": FileChartColumnIcon,
  "tpl-repo-check": ActivityIcon,
  "tpl-watch-scan": RadarIcon,
  "tpl-one-off": AlarmClockIcon,
};

/** 未登记模板的兜底：图标只看 type（周期=循环 · 间隔=计时器 · 一次性=闹钟） */
const TYPE_FALLBACK: Record<AutomationTemplate["type"], TemplateIcon> = {
  cron: RepeatIcon,
  interval: TimerIcon,
  once: AlarmClockIcon,
};

const iconFor = (t: AutomationTemplate) => TEMPLATE_ICON[t.id] ?? TYPE_FALLBACK[t.type];

/** 预置模板的文案 key：名称/描述/指令走词典，未知模板保留 sidecar 原文 */
const TEMPLATE_TEXT_KEY: Record<
  string,
  "dailyBriefing" | "weeklyReport" | "repoCheck" | "watchScan" | "oneOff"
> = {
  "tpl-daily-briefing": "dailyBriefing",
  "tpl-weekly-report": "weeklyReport",
  "tpl-repo-check": "repoCheck",
  "tpl-watch-scan": "watchScan",
  "tpl-one-off": "oneOff",
};

function localizeTemplate(t: TFunc, template: AutomationTemplate): AutomationTemplate {
  const key = TEMPLATE_TEXT_KEY[template.id];
  if (!key) return template;
  return {
    ...template,
    name: t(`automation.templates.${key}.name`),
    description: t(`automation.templates.${key}.description`),
    prompt: t(`automation.templates.${key}.prompt`),
  };
}

export const TemplateCard: FC<{
  template: AutomationTemplate;
  onPick: (t: AutomationTemplate) => void;
}> = ({ template, onPick }) => {
  const t = useT();
  const localized = localizeTemplate(t, template);
  const Icon = iconFor(template);
  return (
    <button
      type="button"
      // title 兜底整段 prompt：卡片只展示 description，想看模板到底让 Agent
      // 干什么时悬停即可，不用先点开编辑器
      title={localized.prompt}
      onClick={() => onPick(localized)}
      className="border-border/60 hover:bg-muted/40 hover:border-border flex min-h-36 flex-col rounded-xl border p-4 text-start outline-none transition-colors duration-150 focus-visible:ring-ring/50 focus-visible:ring-2"
    >
      <div className="flex gap-3">
        <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="text-foreground block truncate text-sm font-medium">
            {localized.name}
          </span>
          <span
            className="text-muted-foreground mt-1 line-clamp-2 block text-xs leading-snug"
            title={localized.description}
          >
            {localized.description}
          </span>
        </span>
      </div>
      <span className="text-muted-foreground mt-auto flex min-w-0 items-center gap-1.5 pt-3 text-xs tabular-nums">
        <ClockIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{describeTemplateSchedule(template)}</span>
      </span>
    </button>
  );
};

/** 模板卡网格：不带分区标题（新建页里它和「手动/会话创建」卡同池混排）。
 *  加载中/失败各有骨架与重试条 */
export const TemplateGrid: FC<{
  onPick: (t: AutomationTemplate) => void;
}> = ({ onPick }) => {
  const t = useT();
  const [templates, setTemplates] = useState<AutomationTemplate[] | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    setTemplates(null);
    fetchAutomationTemplates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  // 进页面即拉一次：清单是 sidecar 静态表，模块级缓存命中后零成本
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {error ? (
        <div className="text-red-500 bg-red-500/5 border-red-500/20 col-span-full flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t("automation.templates.loadFailed", { error })}
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={load}>
            {t("automation.templates.retry")}
          </Button>
        </div>
      ) : templates === null ? (
        Array.from({ length: 4 }).map((_, i) => (
          // 骨架跟卡片同形（min-h-36 + 圆角同 rounded-xl）
          <Skeleton key={i} className="min-h-36 rounded-xl" />
        ))
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground col-span-full py-6 text-center text-sm">
          {t("automation.templates.empty")}
        </p>
      ) : (
        templates.map((tpl) => (
          <TemplateCard key={tpl.id} template={tpl} onPick={onPick} />
        ))
      )}
    </>
  );
};
