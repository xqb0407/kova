"use client";

/**
 * 页内模板区：预置模板直接摊在任务列表下方，不再走「模板」按钮 + 弹窗。
 *
 * 摊开而不是弹窗，是因为模板是这一页的"入门路径"而不是低频动作：没建过任务
 * 的人第一眼就要看到它，藏在二级弹窗里等于不存在。点卡片只把预置值灌进
 * AutomationEditorDialog（表单可改），不直接落库 —— 与原弹窗同一语义。
 *
 * 清单来自 sidecar automation_templates（lib 里模块级缓存，进页面拉一次即可）。
 */

import { useEffect, useState, type FC } from "react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  HourglassIcon,
  LayersIcon,
  RepeatIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchAutomationTemplates,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import { describeTemplateSchedule } from "@/lib/automation/automation-format";
import { cn } from "@/lib/utils";

/** 模板图标与底色按排期类型分（与任务卡的 IDENTITY_POOLS 同一套语义色）：
 *  cron=蓝（日历）· interval=青（循环）· once=琥珀（一次性）。
 *  两处色相一致，任务卡与模板卡排在一起不会看成两个设计系统 */
const TEMPLATE_ICON: Record<AutomationTemplate["type"], LucideIcon> = {
  cron: CalendarClockIcon,
  interval: RepeatIcon,
  once: HourglassIcon,
};

const TEMPLATE_TONE: Record<AutomationTemplate["type"], string> = {
  cron: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  interval: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  once: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const TemplateCard: FC<{
  template: AutomationTemplate;
  onPick: (t: AutomationTemplate) => void;
}> = ({ template, onPick }) => {
  const Icon = TEMPLATE_ICON[template.type] ?? LayersIcon;
  return (
    <button
      type="button"
      // title 兜底整段 prompt：卡片只展示 description，想看模板到底让 Agent
      // 干什么时悬停即可，不用先点开编辑器
      title={template.prompt}
      onClick={() => onPick(template)}
      className={cn(
        "group bg-card hover:cursor-pointer  hover:bg-muted/30 flex flex-col gap-2.5 rounded-xl border p-4 text-start",
        "transition-[border-color,box-shadow] duration-150",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
            TEMPLATE_TONE[template.type],
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="truncate text-sm font-medium">{template.name}</span>
        {/* 排期胶囊常驻右上：模板之间的差别主要就在"什么时候跑" */}
        <span className="text-muted-foreground bg-muted ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums">
          {describeTemplateSchedule(template)}
        </span>
      </div>
      <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
        {template.description}
      </p>
      {/* 悬停才出现的下一步提示：常驻会跟卡片描述抢注意力 */}
      <span className="text-muted-foreground mt-auto flex items-center gap-1 pt-0.5 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        用这个模板新建
        <ArrowRightIcon className="size-3" />
      </span>
    </button>
  );
};

/** 模板区整体：标题行 + 卡片网格。加载中/失败各有骨架与重试条 */
export const TemplateGallery: FC<{
  onPick: (t: AutomationTemplate) => void;
}> = ({ onPick }) => {
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
    <section className="mt-10 border-t pt-6">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <LayersIcon className="text-muted-foreground size-4" />
          从模板开始
        </h2>
        {/* {templates !== null && templates.length > 0 && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {templates.length} 个模板
          </span>
        )} */}
        <span className="text-muted-foreground ml-auto text-xs">
          挑一个常见场景起步，表单里的内容都可以再改
        </span>
      </div>

      {error ? (
        <div className="text-red-500 bg-red-500/5 border-red-500/20 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">模板清单加载失败：{error}</span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={load}>
            重试
          </Button>
        </div>
      ) : templates === null ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">暂无预置模板</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onPick={onPick} />
          ))}
        </div>
      )}
    </section>
  );
};
