/**
 * 文字元素属性区（自 Inspector 拆出）：字体族 / 字号 / 加粗斜体下划线 / 水平垂直对齐 / 文字色板。
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
  CheckIcon,
  ChevronDownIcon,
  ItalicIcon,
  UnderlineIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type TextEl } from "@/doc";
import { DEFAULT_TEXT_SIZE } from "@/render";
import { textLineHeight } from "@/viewspec";
import { cn } from "@/lib/utils";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { FONT_OPTIONS, fontLabel, fontStack } from "../richText";
import { LINE_HEIGHT_PRESETS } from "../TextFormatBar";
import { SwatchRow, TEXT_PRESETS } from "../swatches";

export const TextSection: FC<{ el: TextEl; patch: (p: Partial<TextEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  const runsOf = (el: TextEl) => el.runs;
  const everyRun = (el: TextEl, pred: (r: TextEl["runs"][number]) => boolean) => runsOf(el).every(pred);
  const toggleRunFlag = (el: TextEl, key: "bold" | "italic" | "underline") => {
    const next = !everyRun(el, (r) => !!r[key]);
    patch({ runs: el.runs.map((r) => ({ ...r, [key]: next })) });
  };
  const font = el.runs[0]?.font ?? "";
  const setFont = (value: string) =>
    patch({
      runs: el.runs.map((r) => {
        const next = { ...r };
        if (value) next.font = value;
        else delete next.font;
        return next;
      }),
    });
  return (
    <>
      <SectionTitle>文字</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="border-border hover:bg-accent flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-xs transition-colors"
            aria-label="字体"
          >
            <span className="truncate" style={{ fontFamily: fontStack(font) }}>
              {fontLabel(font)}
            </span>
            <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[220px]">
          {FONT_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.value || "default"} onSelect={() => setFont(o.value)} style={{ fontFamily: fontStack(o.value) }}>
              {o.label}
              {font === o.value && <CheckIcon className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="border-border hover:bg-accent flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-xs transition-colors"
            aria-label="行距"
          >
            <span>行距 · {textLineHeight(el)} 倍</span>
            <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[220px]">
          {LINE_HEIGHT_PRESETS.map((n) => (
            <DropdownMenuItem key={n} onSelect={() => patch({ lineHeight: n })}>
              {n} 倍行距
              {textLineHeight(el) === n && <CheckIcon className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
