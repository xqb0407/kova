/**
 * 文字元素属性区（自 Inspector 拆出）：字号 / 加粗斜体下划线 / 水平垂直对齐 / 文字色板。
 */
import { type FC } from "react";
import {
  AlignCenterIcon,
  AlignCenterVerticalIcon,
  AlignEndVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignStartVerticalIcon,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { type TextEl } from "@/doc";
import { DEFAULT_TEXT_SIZE } from "@/render";
import { cn } from "@/lib/utils";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { SwatchRow, TEXT_PRESETS } from "../swatches";

export const TextSection: FC<{ el: TextEl; patch: (p: Partial<TextEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  const runsOf = (el: TextEl) => el.runs;
  const everyRun = (el: TextEl, pred: (r: TextEl["runs"][number]) => boolean) => runsOf(el).every(pred);
  const toggleRunFlag = (el: TextEl, key: "bold" | "italic" | "underline") => {
    const next = !everyRun(el, (r) => !!r[key]);
    patch({ runs: el.runs.map((r) => ({ ...r, [key]: next })) });
  };
  return (
    <>
      <SectionTitle>文字</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1">
        <NumField
          label="字号"
          min={6}
          max={400}
          value={el.runs[0]?.size ?? DEFAULT_TEXT_SIZE}
          onChange={(v) => patch({ runs: el.runs.map((r) => ({ ...r, size: v })) })}
        />
        <Hint label="加粗">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(everyRun(el, (r) => !!r.bold) && "bg-ink/10 text-ink")}
            onClick={() => toggleRunFlag(el, "bold")}
            aria-label="加粗"
          >
            <BoldIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="斜体">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(everyRun(el, (r) => !!r.italic) && "bg-ink/10 text-ink")}
            onClick={() => toggleRunFlag(el, "italic")}
            aria-label="斜体"
          >
            <ItalicIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="下划线">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(everyRun(el, (r) => !!r.underline) && "bg-ink/10 text-ink")}
            onClick={() => toggleRunFlag(el, "underline")}
            aria-label="下划线"
          >
            <UnderlineIcon className="size-3.5" />
          </Button>
        </Hint>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex gap-0.5">
          {(
            [
              ["left", AlignLeftIcon, "左"],
              ["center", AlignCenterIcon, "居中"],
              ["right", AlignRightIcon, "右"],
            ] as const
          ).map(([a, Icon, label]) => (
            <Hint key={a} label={`水平${label}对齐`}>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn((el.align ?? "left") === a && "bg-ink/10 text-ink")}
                onClick={() => patch({ align: a })}
                aria-label={`水平${label}对齐`}
              >
                <Icon className="size-3.5" />
              </Button>
            </Hint>
          ))}
        </div>
        <Separator orientation="vertical" className="!h-4" />
        <div className="flex gap-0.5">
          {(
            [
              ["top", AlignStartVerticalIcon, "上"],
              ["middle", AlignCenterVerticalIcon, "居中"],
              ["bottom", AlignEndVerticalIcon, "下"],
            ] as const
          ).map(([a, Icon, label]) => (
            <Hint key={a} label={`垂直${label}对齐`}>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn((el.vAlign ?? "top") === a && "bg-ink/10 text-ink")}
                onClick={() => patch({ vAlign: a })}
                aria-label={`垂直${label}对齐`}
              >
                <Icon className="size-3.5" />
              </Button>
            </Hint>
          ))}
        </div>
      </div>
      <SwatchRow
        presets={TEXT_PRESETS}
        value={el.runs[0]?.color}
        ariaLabel="文字颜色"
        onPick={(hex) => patch({ runs: el.runs.map((r) => ({ ...r, color: hex })) }, true)}
      />
      </GroupCard>
    </>
  );
};
