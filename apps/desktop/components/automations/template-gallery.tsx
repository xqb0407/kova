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
  LayersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchAutomationTemplates,
  type AutomationTemplate,
} from "@/lib/automation/automations";
import { describeTemplateSchedule } from "@/lib/automation/automation-format";
import { cn } from "@/lib/utils";
import { templateArtFor } from "./automation-art";

/** 插画的语义色按模板 id 分，不按 type：三个 cron 模板（晨报/周报/体检）
 *  在 type 维度上是同一档，五张卡会有三张同色——那正是"一排卡看着单调"
 *  的来源。按各自的语义拆开后五张各占一色（晨报=晨蓝 · 周报=周次紫 ·
 *  体检=健康绿 · 巡检=青 · 提醒=琥珀），色池仍取自任务卡 IDENTITY_POOLS，
 *  两块内容排在一起还是同一套语言。插画只吃 currentColor，
 *  换主题/换强调色都不用动 SVG。未登记的 id 落 type 兜底 */
const TEMPLATE_TONE: Record<string, string> = {
  "tpl-daily-briefing": "text-blue-600 dark:text-blue-400",
  "tpl-weekly-report": "text-violet-600 dark:text-violet-400",
  "tpl-repo-check": "text-emerald-600 dark:text-emerald-400",
  "tpl-watch-scan": "text-teal-600 dark:text-teal-400",
  "tpl-one-off": "text-amber-600 dark:text-amber-400",
};

const TYPE_FALLBACK_TONE: Record<AutomationTemplate["type"], string> = {
  cron: "text-blue-600 dark:text-blue-400",
  interval: "text-teal-600 dark:text-teal-400",
  once: "text-amber-600 dark:text-amber-400",
};

const toneFor = (template: AutomationTemplate) =>
  TEMPLATE_TONE[template.id] ?? TYPE_FALLBACK_TONE[template.type];

export const TemplateCard: FC<{
  template: AutomationTemplate;
  onPick: (t: AutomationTemplate) => void;
}> = ({ template, onPick }) => {
  const Art = templateArtFor(template);
  return (
    <button
      type="button"
      // title 兜底整段 prompt：卡片只展示 description，想看模板到底让 Agent
      // 干什么时悬停即可，不用先点开编辑器
      title={template.prompt}
      onClick={() => onPick(template)}
      className={cn(
        // 整幅头图通栏压在卡片顶部（overflow-hidden 让图被卡片圆角裁掉），
        // 文字退到图下方。插画放在标题行左侧 64px 见方的版本试过 —— 那个比例
        // 下再细的线稿也会被读成"大号图标"；通栏铺满宽度后它才是插图
        // 立面只给一道 hairline + 一层几乎看不见的投影，悬停时才把阴影放开：
        // 常驻重投影会让五张卡一起变成"卡片墙"，静息状态应该只是贴着纸
        "group bg-card border-border/60 flex flex-col overflow-hidden rounded-2xl border text-start",
        "shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        "transition-[border-color,box-shadow] duration-200",
        "hover:shadow-[0_12px_32px_-14px_rgb(0_0_0/0.22)] dark:hover:shadow-[0_12px_32px_-14px_rgb(0_0_0/0.7)]",
        "hover:cursor-pointer",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
      )}
    >
      {/* 悬停时头图极缓推近（只动 transform，溢出被外层裁掉）。
          400ms ease-out 而不是 150ms —— 快进快出的缩放像 hover 特效，
          慢推近才像"图自己呼吸了一下" */}
      <div className={cn("aspect-[320/100] w-full overflow-hidden", toneFor(template))}>
        <Art className="size-full transition-transform duration-[420ms] ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
      </div>
      {/* 两行就收住：标题行（名称 + 排期胶囊 + 悬停箭头）与描述。
          原版这里的"用这个模板新建"提示常驻占一行，网格把卡拉高后
          那一行变成卡底一条明显的空白带 —— 改成标题行右端一枚悬停箭头，
          提示还在，空白没了 */}
      <div className="flex flex-col gap-1 p-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold tracking-[-0.011em]">
            {template.name}
          </span>
          {/* 排期胶囊常驻右上：模板之间的差别主要就在"什么时候跑" */}
          <span className="text-muted-foreground bg-muted ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums">
            {describeTemplateSchedule(template)}
          </span>
          {/* 定宽占位 + 只动 transform/opacity：进场不推挤标题行 */}
          <ArrowRightIcon className="text-muted-foreground size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:transition-none" />
        </div>
        <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
          {template.description}
        </p>
      </div>
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
    // 回到"一道 hairline + 充足留白"的分隔：插画铺满卡面之后，这一区的视觉
    // 分量已经够了；再垫一层灰底面板就是给内容加第二个框，页面反而变脏
    <section className="border-border/60 mt-12 border-t pt-8">
      <div className="mb-5 flex items-baseline gap-2">
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[200px] rounded-2xl" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">暂无预置模板</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onPick={onPick} />
          ))}
        </div>
      )}
    </section>
  );
};
