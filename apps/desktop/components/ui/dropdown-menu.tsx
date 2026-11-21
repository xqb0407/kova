"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, CircleIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { OcclusionSlot } from "@/components/custom-ui/occlusion-slot";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ children, ...props }: MenuPrimitive.Portal.Props) {
  // 同 dialog：children 必须解构出来合并——JSX 显式子节点会覆盖 {...props} 里的
  // children，不显式渲染就会把调用方的子树悄悄丢掉
  return (
    <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props}>
      <OcclusionSlot />
      {children}
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <DropdownMenuPortal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            // 宽度按内容自适应（最小对齐触发按钮）：固定成 anchor 宽度时，
            // 英文菜单项比触发按钮宽，会被挤成多行；长菜单再受可用宽度约束
            "bg-popover shadow-xl text-popover-foreground border border-border/50 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 z-50 max-h-(--available-height) w-max min-w-[max(8rem,var(--anchor-width))] max-w-[var(--available-width)] origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--radius-surface,var(--radius-lg))] p-1.5 duration-100 outline-none data-closed:overflow-hidden",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </DropdownMenuPortal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/**
 * 可搜索菜单（Base UI 的 filterable menu）：必须包在 `<DropdownMenu>` 外层——
 * Provider 由 Menu.Root 自己消费，放进 Content 里不生效。
 *
 * 用法：搜索框用 `DropdownMenuSearchInput`，条目放进 `DropdownMenuList`。
 * 原生过滤传 `filter`（条目匹配文本默认取渲染文本，也可以给 `DropdownMenuItem`
 * 传 `label` 覆盖）；传 `filter={null}` 表示外部自己过滤，此时 base-ui 的
 * `Menu.Empty` 不会出现，无结果提示需要自己渲染。
 * 键盘/输入法由 Base UI 接管：打开即聚焦搜索框，↑/↓ 挪高亮、回车选中。
 */
function DropdownMenuFilter({ ...props }: MenuPrimitive.FilterProvider.Props) {
  return <MenuPrimitive.FilterProvider {...props} />;
}

/** 可搜索菜单的搜索框：左侧放大镜 + 输入框本体（视觉与指令面板同款） */
function DropdownMenuSearchInput({
  className,
  placeholder = "搜索",
  ...props
}: MenuPrimitive.Input.Props) {
  // 图标压在输入框自己的相对容器里：容器带 pt 时按 50% 定位会偏。
  // 用逻辑属性 start（不是 left）：输入框本身用 ps-8 留位，RTL 下两者要一起翻
  return (
    <div className="relative">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
      <MenuPrimitive.Input
        data-slot="dropdown-menu-search-input"
        placeholder={placeholder}
        className={cn(
          "placeholder:text-muted-foreground/70 bg-foreground/[0.04] h-8 w-full rounded-lg ps-8 pe-2 text-sm outline-none",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function DropdownMenuList({ ...props }: MenuPrimitive.List.Props) {
  return <MenuPrimitive.List data-slot="dropdown-menu-list" {...props} />;
}

// Base UI：MenuGroupLabel 依赖 Menu.Group / Menu.RadioGroup 提供的上下文，
// 裸放在 Content 里渲染即抛 error #31。调用方必须处于 DropdownMenuGroup 或
// DropdownMenuRadioGroup 内。
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "text-muted-foreground px-2 py-1.5 font-mono text-xs font-medium tracking-[0.05em] uppercase data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      // data-highlighted 不能少：可搜索菜单（FilterProvider）里焦点留在搜索框，
      // 条目只拿到虚拟高亮、永远不会有 :focus——只写 focus: 样式的话，搜索后
      // 鼠标悬浮/方向键都看不到高亮
      className={cn(
        "focus:bg-foreground/[0.06] data-[highlighted]:bg-foreground/[0.06] data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:data-[highlighted]:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-[highlighted]:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 dark:data-[variant=destructive]:data-[highlighted]:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive group/dropdown-menu-item relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-foreground/[0.06] data-[highlighted]:bg-foreground/[0.06] data-open:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      {/* 箭头与条目自身的 size-3.5 前导图标对齐：size-4 实色压在行尾比图标更
          抢眼，整行会读成「左轻右重」 */}
      <ChevronRightIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 rtl:rotate-180" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "bg-popover text-popover-foreground shadow-xl data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 w-auto min-w-[96px] rounded-[var(--radius-surface,var(--radius-lg))] p-1 duration-100",
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "focus:bg-foreground/[0.06] data-[highlighted]:bg-foreground/[0.06] relative flex cursor-default items-center gap-1.5 rounded-md py-1.5 pr-8 pl-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "focus:bg-foreground/[0.06] data-[highlighted]:bg-foreground/[0.06] relative flex cursor-default items-center gap-1.5 rounded-md py-1.5 pr-8 pl-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      // 细线宽度随 DPR：二倍屏 0.5px（正好 1 物理像素），1x/125%/150% 用 1px，
      // 避免 Windows 上被画成半透明灰线；颜色走全局 border token
      className={cn("bg-border -mx-1.5 my-1 h-[var(--hairline,1px)]", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto font-mono text-xs tracking-wider",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuFilter,
  DropdownMenuSearchInput,
  DropdownMenuList,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
