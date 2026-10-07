"use client";

/**
 * 子智能体编辑器的「可搜索多选」控件。
 *
 * 为什么不是一排 chip：技能动辄三四十个（MCP 服务器同理），平铺成 chip
 * 会把编辑器撑成一面墙，真正的表单字段被推到屏幕外——这正是从弹窗改成
 * 二级页面要解决的问题之一，不该换个地方再犯一次。
 *
 * 形态：已选项以 chip 呈现（可点 × 移除），旁边一个「+ 添加」按钮开
 * 可搜索弹层。已选项也出现在弹层里且带勾，可就地取消。
 */
import { useState, type FC } from "react";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
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

export const MultiSelectField: FC<{
  label: string;
  /** 追加在标签后的说明，与 FieldRow 同款呈现 */
  hint?: string;
  options: SelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** 空态提示（如「还没配置技能，到设置 → 技能里添加」） */
  emptyHint?: string;
  /** 候选表是否已就绪。未就绪时**不把已选项标成缺失**——
   *  清单还没拉回来时 options 是空的，照常判定会让每个已选项都闪一次
   *  "当前作用域不存在"的红标，那是假警报。 */
  optionsReady?: boolean;
}> = ({ label, hint, options, value, onChange, emptyHint, optionsReady = true }) => {
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

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">
        {label}
        {hint ? ` —— ${hint}` : ""}
      </span>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const known = optionByValue.get(v);
            const missing = missingSelected.includes(v);
            return (
              <span
                key={v}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs",
                  missing ? "border-destructive/50 text-destructive" : "bg-muted/60 border-input",
                )}
                title={missing ? "当前作用域不存在，这条声明不会生效" : known?.hint}
              >
                {known?.label ?? v}
                <button
                  type="button"
                  aria-label={`移除 ${known?.label ?? v}`}
                  onClick={() => onChange(value.filter((x) => x !== v))}
                  className="text-muted-foreground hover:text-foreground -mr-1 cursor-pointer text-sm leading-none"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className={addChipClass}>
          <PlusIcon className="size-3" />
          添加
          <ChevronDownIcon className="size-3 opacity-60" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <Command shouldFilter>
            <CommandInput placeholder={`搜索${label}…`} />
            <CommandList>
              <CommandEmpty>
                <span className="text-muted-foreground">{emptyHint ?? "没有可选项"}</span>
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
                          <span className="text-muted-foreground truncate text-xs">{o.hint}</span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {missingSelected.length > 0 && (
                <CommandGroup heading="当前作用域不存在">
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
    </div>
  );
};

/** 分区标题：内容页的小节分隔，不再靠分隔线暗示层级 */
export const EditorSection: FC<{
  title: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ title, hint, children }) => (
  <section className="flex flex-col gap-3">
    <div className="flex flex-col gap-0.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
    {children}
  </section>
);

/** 只读定义的展示 chip（内置弹窗 / 详情用） */
export const ReadonlyChips: FC<{ label: string; items: string[]; mono?: boolean }> = ({
  label,
  items,
  mono,
}) =>
  items.length === 0 ? null : (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
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
  children: React.ReactNode;
  mono?: boolean;
  title?: string;
}> = ({ active, onClick, children, mono, title }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    title={title}
    className={cn(
      "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full border px-2.5 text-xs transition-colors",
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
  "border-input text-muted-foreground hover:bg-muted inline-flex h-7 w-fit cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition-colors";

/** 分区里的一行「标签 + 内容」：标签样式统一，不再各节各写一遍 */
export const FieldRow: FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-muted-foreground text-xs">
      {label}
      {hint ? ` —— ${hint}` : ""}
    </span>
    {children}
  </div>
);
