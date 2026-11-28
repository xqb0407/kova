"use client";

/**
 * 子智能体编辑器的表单控件家族。
 *
 * 版式（参考对话产品的新建智能体表单）：每个分区 = 分区小标题（灰色小字，
 * 放在卡片外）+ 一张圆角卡片；卡片内各行用虚线分隔。行有两种：
 * - ConfigRow：左「标题 + 说明」、右控件——模型/轮次/记忆这类开关型配置；
 * - FieldRow：标签在上、控件整宽在下——名称/描述/多选盒这类内容型字段。
 *
 * 「可搜索多选」为什么不再渲染自己的标签：行标签由外层 FieldRow 统一负责，
 * 控件只画那个整宽边框盒——已选项以 chip 呈现在盒里（可点 × 移除），
 * 点盒子开可搜索弹层，已选项也出现在弹层里且带勾，可就地取消。
 *
 * 盒里的 chip **不换行**：装不下的折叠成「+N」，悬浮展开 tooltip 列出被
 * 折叠的名字。能放几个 chip 靠测量——隐形测量行把全部 chip 画一遍量宽度，
 * 盒宽变化走 ResizeObserver 重算；这样 40 个技能也只占一行，盒子高度恒定。
 */
import { useLayoutEffect, useRef, useState, type FC, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type SelectOption = {
  value: string;
  label: string;
  /** 副标题（技能描述 / 服务器 transport） */
  hint?: string;
  /** 该项在当前作用域不可用（技能被删、服务器未配置） */
  missing?: boolean;
};

/** 盒内 chip 的公共外观：测量行与可见行必须同一套类名，宽度才对得上 */
const boxChipClass = (missing: boolean) =>
  cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-ui leading-none",
    missing ? "border-destructive/50 text-destructive" : "border-input bg-muted/60",
  );

/** 盒内「+N」折叠 chip 的外观 */
const moreChipClass =
  "text-muted-foreground inline-flex h-6 shrink-0 items-center rounded-full border border-input bg-muted/60 px-2 text-ui leading-none";

export const MultiSelectField: FC<{
  /** 只用于空盒占位文案（「点击添加{label}」）；行标签由外层 FieldRow 负责 */
  label: string;
  options: SelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** 空态提示（如「还没配置技能，到设置 → 技能里添加」） */
  emptyHint?: string;
  /** 候选表是否已就绪。未就绪时**不把已选项标成缺失**——
   *  清单还没拉回来时 options 是空的，照常判定会让每个已选项都闪一次
   *  "当前作用域不存在"的红标，那是假警报。 */
  optionsReady?: boolean;
}> = ({ label, options, value, onChange, emptyHint, optionsReady = true }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  // 已被显式移除的名字仍要出现在弹层里（否则用户再点一次才能加回来，
  // 会以为"这个技能不可用"）
  const optionByValue = new Map(options.map((o) => [o.value, o]));
  // 未就绪时不谈缺失：只有候选表确实拿到了，缺席才说明"这个真没了"
  const missingSelected = optionsReady
    ? value.filter((v) => !optionByValue.has(v))
    : [];

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  /* ---- 单行折叠：量宽 → 留下装得下的，余量并进「+N」 ------------------
   * 测量行画全部 chip（含一个按满数起的「+N」）， invisibly 挂在盒内；
   * fitCount = 顺着塞能塞下几个。盒宽变化走 ResizeObserver，选项/值变化
   * 走 layout effect，两处都只改 fitCount 一个状态，不会形成渲染循环。 */
  const boxRef = useRef<HTMLButtonElement | null>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);
  /** 只挂测量行的「+N」：可见那个若也挂同一个 ref，窗口变宽它卸载时
   *  React 置 null 会把测量行的挂载一起清掉，moreW 随即失真 */
  const moreMeasureRef = useRef<HTMLSpanElement | null>(null);
  /** null = 还没量（第一帧全画，layout effect 里量完再裁） */
  const [fitCount, setFitCount] = useState<number | null>(null);

  const hiddenCount = fitCount === null ? 0 : Math.max(0, value.length - fitCount);
  const hiddenLabels = value
    .slice(value.length - hiddenCount)
    .map((v) => optionByValue.get(v)?.label ?? v);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || value.length === 0) {
      setFitCount(null);
      return;
    }
    const CHIP_GAP = 6; // 与 chip 行的 gap-1.5 对齐
    const measure = () => {
      const style = getComputedStyle(box);
      const padX =
        Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      // 盒内还要给右侧的展开箭头留位（size-4 + 与 chip 行的 gap）
      const avail = box.clientWidth - padX - 16 - CHIP_GAP;
      const widths = chipRefs.current.slice(0, value.length).map((el) => el?.offsetWidth ?? 0);
      const moreW = (moreMeasureRef.current?.offsetWidth ?? 0) + CHIP_GAP;
      let acc = 0;
      let k = 0;
      for (let i = 0; i < value.length; i++) {
        const needed = acc + widths[i]! + (i > 0 ? CHIP_GAP : 0);
        // 后面还有 chip 时，「+N」本身也要占位
        const withMore = i + 1 < value.length ? moreW : 0;
        if (needed + withMore <= avail) {
          acc = needed;
          k = i + 1;
        } else {
          break;
        }
      }
      setFitCount(k);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [value, options]);

  const chipNode = (v: string, interactive: boolean) => {
    const known = optionByValue.get(v);
    const missing = missingSelected.includes(v);
    return (
      <span
        className={boxChipClass(missing)}
        title={missing ? t("settings.subagents.missingItemTitle") : known?.hint}
      >
        {known?.label ?? v}
        {/* × 恒在场：可见行可点移除，测量行带同样内容才量得出同样的宽度 */}
        <span
          role={interactive ? "button" : undefined}
          aria-label={interactive ? t("settings.subagents.removeAria", { label: known?.label ?? v }) : undefined}
          onClick={
            interactive
              ? (e) => {
                  e.stopPropagation();
                  onChange(value.filter((x) => x !== v));
                }
              : undefined
          }
          className="text-muted-foreground hover:text-foreground -mr-0.5 cursor-pointer text-sm leading-none"
        >
          ×
        </span>
      </span>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* 整宽边框盒（与「生效范围」多选同一形态）：chip 单行不换行，装不下
          的折叠进「+N」。移除是盒内的 span，不是嵌套按钮——button 里套
          button 是非法 HTML */}
      <PopoverTrigger
        ref={boxRef}
        /* 紧凑的可访问名：默认由后代拼接出的名字会把每个 chip 和每个「移除 X」
            都念一遍，几十个技能时没法听 */
        aria-label={
          value.length === 0
            ? t("settings.subagents.selectPlaceholder", { label })
            : t("settings.subagents.selectAria", { label, count: value.length })
        }
        className={cn(
          "border-input hover:bg-muted/30 focus-visible:ring-primary/60 relative flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left transition-colors outline-none focus-visible:ring-2",
        )}
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground text-ui leading-5">
            {t("settings.subagents.selectPlaceholder", { label })}
          </span>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
              {value
                .slice(0, hiddenCount === 0 ? value.length : (fitCount ?? value.length))
                .map((v) => chipNode(v, true))}
              {hiddenCount > 0 && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                      <span className={moreChipClass}>+{hiddenCount}</span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      className="border bg-popover text-popover-foreground **:data-[slot=tooltip-arrow]:hidden"
                    >
                      <div className="flex max-w-72 flex-wrap gap-1.5">
                        {hiddenLabels.map((l) => (
                          <span key={l} className="bg-muted rounded-full px-2 py-0.5 text-ui leading-5">
                            {l}
                          </span>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </span>
            {/* 隐形测量行：与可见 chip 同类名同内容（含 ×），量的是同一组宽度 */}
            <span
              aria-hidden
              className="pointer-events-none invisible absolute inset-x-3 top-0 flex flex-nowrap items-center gap-1.5"
            >
              {value.map((v, i) => (
                <span
                  key={v}
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                  className={boxChipClass(missingSelected.includes(v))}
                >
                  {optionByValue.get(v)?.label ?? v}
                  <span className="text-muted-foreground -mr-0.5 text-sm leading-none">×</span>
                </span>
              ))}
              <span ref={moreMeasureRef} className={moreChipClass}>
                +{value.length}
              </span>
            </span>
          </>
        )}
        <ChevronDownIcon className="text-muted-foreground ml-auto size-4 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter>
          <CommandInput placeholder={t("settings.subagents.searchPlaceholder", { label })} />
          <CommandList>
            <CommandEmpty>
              <span className="text-muted-foreground">{emptyHint ?? t("settings.subagents.noOptions")}</span>
            </CommandEmpty>
            {options.length > 0 && (
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.hint ?? ""}`}
                    onSelect={() => toggle(o.value)}
                  >
                    <CheckIcon
                      className={cn(
                        "size-3.5 shrink-0",
                        value.includes(o.value) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{o.label}</span>
                      {o.hint && (
                        <span className="text-muted-foreground truncate text-ui leading-5">{o.hint}</span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {missingSelected.length > 0 && (
              <CommandGroup heading={t("settings.subagents.missingGroup")}>
                {missingSelected.map((v) => (
                  <CommandItem
                    key={v}
                    value={`missing ${v}`}
                    onSelect={() => onChange(value.filter((x) => x !== v))}
                    className="text-destructive"
                  >
                    <span className="truncate">{v}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

/**
 * 分区 = 卡片外的小灰标题（可带「 —— 说明」）+ 圆角卡片。卡片内不给自己
 * 纵向 padding：每个行组件自带 py-4，行间虚线由 divide 提供——首行自然
 * 没有上边线，与参考版式一致。
 */
export const EditorSection: FC<{
  title: string;
  hint?: string;
  children: ReactNode;
}> = ({ title, hint, children }) => {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground px-1 text-ui leading-5">
        {title}
        {hint ? t("settings.subagents.hintSeparator", { hint }) : ""}
      </h3>
      <div className="border-border/60 bg-card divide-border/60 divide-y divide-dashed rounded-2xl border px-5">
        {children}
      </div>
    </section>
  );
};

/** 卡片里的一行「左标题+说明、右控件」：模型/轮次/记忆这类开关型配置用 */
export const ConfigRow: FC<{
  label: string;
  /** 说明可传节点：记忆的动态提示是两行（静态说明 + 随档位变化的提示） */
  desc?: ReactNode;
  children: ReactNode;
}> = ({ label, desc, children }) => (
  <div className="flex items-center justify-between gap-6 py-4">
    <div className="min-w-0">
      <div className="text-sm font-medium leading-5">{label}</div>
      {desc ? (
        <div className="text-muted-foreground mt-0.5 text-ui leading-5">{desc}</div>
      ) : null}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

/** 卡片里的一行「标签在上、控件整宽在下」：名称/描述/多选盒这类内容型字段用 */
export const FieldRow: FC<{
  label: string;
  hint?: string;
  children: ReactNode;
}> = ({ label, hint, children }) => (
  <div className="flex flex-col gap-2 py-4">
    <div>
      <div className="text-sm font-medium leading-5">{label}</div>
      {hint ? <div className="text-muted-foreground text-ui leading-5">{hint}</div> : null}
    </div>
    {children}
  </div>
);

/** 只读定义的展示 chip（内置弹窗 / 详情用） */
export const ReadonlyChips: FC<{ label: string; items: string[]; mono?: boolean }> = ({
  label,
  items,
  mono,
}) =>
  items.length === 0 ? null : (
    <div className="flex flex-wrap items-center gap-1.5 text-ui leading-5">
      <span className="text-muted-foreground">{label}</span>
      {items.map((s) => (
        <span
          key={s}
          className={cn("bg-muted rounded-full px-2 py-0.5", mono && "font-mono")}
        >
          {s}
        </span>
      ))}
    </div>
  );
/* ---------------------------------------------------------------------------
 * 统一的 chip 家族
 *
 * 这一页此前有四套手写的胶囊：工具 chip 是 py-0.5（约 22px）「添加」按钮是
 * h-7，知识源按钮是 Button outline，记忆档位又是另一套 padding。同屏三种
 * 高度，看起来像几个不同组件拼起来的。
 *
 * 现在统一到本应用小控件的标准高度 h-7（与 ui/button 的 size=sm、
 * custom-ui/segmented 的段高一致），圆角一律 rounded-full，
 * 选中态只有一处定义。
 * ------------------------------------------------------------------------- */

/** 可切换的多选 chip（工具、技能、MCP 用）。mono 供工具名这类标识符 */
export const ToggleChip: FC<{
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  mono?: boolean;
  title?: string;
}> = ({ active, onClick, children, mono, title }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    title={title}
    className={cn(
      "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full border px-2.5 text-ui leading-5 transition-colors",
      mono && "font-mono",
      active
        ? "bg-primary text-primary-foreground border-primary"
        : "text-muted-foreground hover:bg-muted border-input",
    )}
  >
    {children}
  </button>
);

/** 新增动作 chip 的外观：与 ToggleChip 同高同圆角，语义是「加一个」而非「切换」。
 *  导出成 class 而非组件，因为 PopoverTrigger / Button 都要挂它。 */
export const addChipClass =
  "border-input text-muted-foreground hover:bg-muted inline-flex h-7 w-fit cursor-pointer items-center gap-1 rounded-full border px-2.5 text-ui leading-5 transition-colors";
