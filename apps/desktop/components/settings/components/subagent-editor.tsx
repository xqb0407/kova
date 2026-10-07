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
  options: SelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** 空态提示（如「还没配置技能，到设置 → 技能里添加」） */
  emptyHint?: string;
  /** 已选项在弹层里显示的 hint 兜底 */
  missingLabel?: string;
}> = ({ label, options, value, onChange, emptyHint }) => {
  const [open, setOpen] = useState(false);
  // 已被显式移除的名字仍要出现在弹层里（否则用户再点一次才能加回来，
  // 会以为"这个技能不可用"）
  const optionByValue = new Map(options.map((o) => [o.value, o]));
  const missingSelected = value.filter((v) => !optionByValue.has(v));

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const known = optionByValue.get(v);
            return (
              <span
                key={v}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                  known ? "bg-muted/60" : "border-destructive/50 text-destructive",
                )}
                title={known?.hint ?? "当前作用域不存在，这条声明不会生效"}
              >
                {known?.label ?? v}
                <button
                  type="button"
                  aria-label={`移除 ${known?.label ?? v}`}
                  onClick={() => onChange(value.filter((x) => x !== v))}
                  className="text-muted-foreground hover:text-foreground -mr-1 cursor-pointer"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="border-input text-muted-foreground hover:bg-muted inline-flex h-7 w-fit cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition-colors"
        >
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