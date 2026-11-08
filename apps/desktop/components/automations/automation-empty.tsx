"use client";

/**
 * 自动化页的两处空态（任务清单 / 运行记录）。
 *
 * 空态只有"一枚瓷片 + 一句话 + 行动点"，没有插画：原先这里是两张手绘场景
 * （轨道绕任务卡 / 时间轴挂记录卡），单色几何铺出来在亮色下是一片发黑的灰块、
 * 暗色下是一片发灰的雾，层次全压在低不透明度里，细节读不出来。模板卡改成图标
 * 瓷片之后，整页只剩那一处插画，两种图形语言并存反而更扎眼，于是空态并到同一套
 * 瓷片语汇里。
 *
 * 瓷片色相用 --primary 而不是模板那五色：空态没有身份色，给它上色只会跟正下方
 * 的模板区抢注意力；这里要的是"这一屏是空的"，不是"这里有个东西"。
 */

import type { FC, ReactNode } from "react";
import { CalendarClockIcon, HistoryIcon } from "lucide-react";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 与模板卡那枚 40px 瓷片同一配方（淡底 + ring-inset 内描边），只是放大一档。
 *  描边走 ring 而不是 border：border 会把见方尺寸撑大 2px，圆角比例就偏了 */
const EmptyTile: FC<{ className?: string; children: ReactNode }> = ({ className, children }) => (
  <span
    className={cn(
      "bg-primary/5 text-primary ring-border/70",
      "grid shrink-0 place-items-center rounded-2xl ring-1 ring-inset",
      className,
    )}
  >
    {children}
  </span>
);

/** 任务清单空态：正下方就是模板区，所以文案把"挑模板"和"回聊天让 agent 建"
 *  两条路一次说完，行动点由调用方传（本组件不碰编辑器状态） */
export const AutomationEmptyState: FC<{ action?: ReactNode }> = ({ action }) => {
  const t = useT();
  return (
    <div className="text-muted-foreground mt-4 flex flex-col items-center gap-3 py-8 text-center">
      {/* 与搜索页同一套「点阵云」：大块空区的缺省页不留一整片白 */}
      <div className="relative grid place-items-center">
        <DotCloud />
        <EmptyTile className="absolute size-14">
          <CalendarClockIcon className="size-6" />
        </EmptyTile>
      </div>
      <p className="text-foreground text-base font-semibold tracking-[-0.011em]">
        {t("automation.empty.title")}
      </p>
      <p className="max-w-md text-sm leading-relaxed">
        {t("automation.empty.description")}
      </p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
};

/** 运行记录空态：标题随筛选条件变，文案交给调用方；这一圈虚线框就是它的面板。
 *  瓷片比任务空态小一档（48 vs 56）——它被框住，本来就不该比框外的空态更响 */
export const HistoryEmptyState: FC<{ title: string; description?: string }> = ({
  title,
  description,
}) => (
  <div className="border-border/60 text-muted-foreground mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
    <EmptyTile className="size-12 rounded-xl">
      <HistoryIcon className="size-5" />
    </EmptyTile>
    <p className="text-foreground text-sm font-semibold">{title}</p>
    {description && <p className="text-xs leading-relaxed">{description}</p>}
  </div>
);
