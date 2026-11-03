"use client";

/**
 * 页内模板区：预置模板直接摊在任务列表下方，不再走「模板」按钮 + 弹窗。
 *
 * 摊开而不是弹窗，是因为模板是这一页的"入门路径"而不是低频动作：没建过任务
 * 的人第一眼就要看到它，藏在二级弹窗里等于不存在。点卡片只把预置值灌进
 * AutomationEditorDialog（表单可改），不直接落库 —— 与原弹窗同一语义。
 *
 * 清单来自 sidecar automation_templates（lib 里模块级缓存，进页面拉一次即可）。
 *
 * 卡片是"图标瓷片 + 两行信息"，不铺整幅场景插画：模板之间的差别只有"干什么"
 * 和"什么时候跑"两件事，插画两样都说不了，却要占掉半张卡高——五张图并排后
 * 还会连成一片色块，把模板区的分量压过上方真正的任务清单。色相收进 40px 的
 * 瓷片里（一卡一色，与任务卡的排期胶囊同一套色相语言），小到不与内容抢注意力，
 * 也省掉了五张各画一遍的维护面。
 */

import { useEffect, useState, type ComponentType, type FC } from "react";
import {
  ActivityIcon,
  AlarmClockIcon,
  AlertCircleIcon,
  ArrowRightIcon,
  FileChartColumnIcon,
  LayersIcon,
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
import { cn } from "@/lib/utils";

type TemplateIcon = ComponentType<{ className?: string }>;

/** 身份色按模板 id 分，不按 type：三个 cron 模板（晨报/周报/体检）在 type 维度
 *  上是同一档，按 type 分色会有三张卡同色。五个色相分别是 晨报=晨蓝 · 周报=
 *  周次紫 · 体检=健康绿 · 巡检=青 · 提醒=琥珀。未登记的 id 落 type 兜底。
 *  三个类名串必须写成完整的字面量（Tailwind 只扫描源码里的整串），所以每种
 *  色相各写一份，不拼接、不模板化 */
type TemplateTone = {
  /** 瓷片：淡底 + 内描边，悬停时同色相加深一档 */
  tile: string;
  /** 图标色（含暗色档） */
  icon: string;
  /** 整卡悬停边框：卡片被点亮时用的是它自己那一色 */
  edge: string;
};

const TONE_BLUE: TemplateTone = {
  tile: "bg-blue-500/10 ring-blue-500/20 group-hover:bg-blue-500/[0.14] group-hover:ring-blue-500/30",
  icon: "text-blue-600 dark:text-blue-400",
  edge: "hover:border-blue-500/40",
};

const TONE_VIOLET: TemplateTone = {
  tile: "bg-violet-500/10 ring-violet-500/20 group-hover:bg-violet-500/[0.14] group-hover:ring-violet-500/30",
  icon: "text-violet-600 dark:text-violet-400",
  edge: "hover:border-violet-500/40",
};

const TONE_EMERALD: TemplateTone = {
  tile: "bg-emerald-500/10 ring-emerald-500/20 group-hover:bg-emerald-500/[0.14] group-hover:ring-emerald-500/30",
  icon: "text-emerald-600 dark:text-emerald-400",
  edge: "hover:border-emerald-500/40",
};

const TONE_TEAL: TemplateTone = {
  tile: "bg-teal-500/10 ring-teal-500/20 group-hover:bg-teal-500/[0.14] group-hover:ring-teal-500/30",
  icon: "text-teal-600 dark:text-teal-400",
  edge: "hover:border-teal-500/40",
};

const TONE_AMBER: TemplateTone = {
  tile: "bg-amber-500/10 ring-amber-500/20 group-hover:bg-amber-500/[0.14] group-hover:ring-amber-500/30",
  icon: "text-amber-600 dark:text-amber-400",
  edge: "hover:border-amber-500/40",
};

/** 图标讲"干什么"：晨报=日出 · 周报=插入柱图的报告 · 体检=心电 · 巡检=雷达 ·
 *  提醒=闹钟。只挑 lucide 里语义直接命中的那一个，不做隐喻 */
const TEMPLATE_ICON: Record<string, TemplateIcon> = {
  "tpl-daily-briefing": SunriseIcon,
  "tpl-weekly-report": FileChartColumnIcon,
  "tpl-repo-check": ActivityIcon,
  "tpl-watch-scan": RadarIcon,
  "tpl-one-off": AlarmClockIcon,
};

const TEMPLATE_TONE: Record<string, TemplateTone> = {
  "tpl-daily-briefing": TONE_BLUE,
  "tpl-weekly-report": TONE_VIOLET,
  "tpl-repo-check": TONE_EMERALD,
  "tpl-watch-scan": TONE_TEAL,
  "tpl-one-off": TONE_AMBER,
};

/** 未登记模板的兜底：色相与图标都只看 type（周期=蓝 · 间隔=青 · 一次性=琥珀） */
const TYPE_FALLBACK: Record<
  AutomationTemplate["type"],
  { Icon: TemplateIcon; tone: TemplateTone }
> = {
  cron: { Icon: RepeatIcon, tone: TONE_BLUE },
  interval: { Icon: TimerIcon, tone: TONE_TEAL },
  once: { Icon: AlarmClockIcon, tone: TONE_AMBER },
};

const iconFor = (t: AutomationTemplate) => TEMPLATE_ICON[t.id] ?? TYPE_FALLBACK[t.type].Icon;
const toneFor = (t: AutomationTemplate) => TEMPLATE_TONE[t.id] ?? TYPE_FALLBACK[t.type].tone;

export const TemplateCard: FC<{
  template: AutomationTemplate;
  onPick: (t: AutomationTemplate) => void;
}> = ({ template, onPick }) => {
  const tone = toneFor(template);
  const Icon = iconFor(template);
  return (
    <button
      type="button"
      // title 兜底整段 prompt：卡片只展示 description，想看模板到底让 Agent
      // 干什么时悬停即可，不用先点开编辑器
      title={template.prompt}
      onClick={() => onPick(template)}
      className={cn(
        "group bg-card border-border/60 flex items-start gap-3 rounded-2xl border p-4 text-start",
        // 立面只给一道 hairline + 一层几乎看不见的投影，悬停时才把阴影放开：
        // 常驻重投影会让整片网格一起变成"卡片墙"，静息状态应该只是贴着纸
        "shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        "transition-[border-color,box-shadow] duration-200",
        "hover:shadow-[0_10px_28px_-16px_rgb(0_0_0/0.25)] dark:hover:shadow-[0_10px_28px_-16px_rgb(0_0_0/0.7)]",
        tone.edge,
        "hover:cursor-pointer",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
      )}
    >
      {/* 瓷片：整张卡唯一的色块。描边走 ring-inset 而不是 border —— 加 border 会
          把 40px 的瓷片撑到 42px，与图标 20px 的比例就偏了 */}
      <span
        className={cn(
          "ring-1 ring-inset",
          "grid size-10 shrink-0 place-items-center rounded-xl",
          "transition-colors duration-200",
          tone.tile,
        )}
      >
        <Icon className={cn("size-5", tone.icon)} />
      </span>
      {/* 两行就收住：标题行（名称 + 排期胶囊 + 悬停箭头）与描述。"用这个模板
          新建"的常驻提示行早先占掉过一行，网格把卡拉高后它变成卡底一条空白带 ——
          提示改成标题行右端一枚悬停箭头，提示还在，空白没了 */}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.011em]">
            {template.name}
          </span>
          {/* 排期胶囊常驻标题行右端：模板之间的差别主要就在"什么时候跑" */}
          <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums">
            {describeTemplateSchedule(template)}
          </span>
          {/* 定宽占位 + 只动 transform/opacity：进场不推挤标题行 */}
          <ArrowRightIcon className="text-muted-foreground size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:transition-none" />
        </span>
        <span
          className="text-muted-foreground line-clamp-2 text-xs leading-relaxed"
          title={template.description}
        >
          {template.description}
        </span>
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
    // 回到"一道 hairline + 充足留白"的分隔：这一区的视觉分量已经够了；
    // 再垫一层灰底面板就是给内容加第二个框，页面反而变脏
    <section className="border-border/60 mt-12 border-t pt-8">
      <div className="mb-5 flex items-baseline gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <LayersIcon className="text-muted-foreground size-4" />
          从模板开始
        </h2>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            // 骨架跟卡片同形（卡高 92px，圆角同 rounded-2xl）
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
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
