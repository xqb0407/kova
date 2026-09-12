"use client";

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";

/**
 * 右键上下文菜单(Base UI ContextMenu,与 dropdown-menu 同款视觉):
 * Trigger 区域右键/长按唤起,菜单跟随鼠标落点,用于
 * agent 面板标签等需要 IDE 式操作的场合。
 */
function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({
  className,
  children,
  ...positionerProps
}: ContextMenuPrimitive.Positioner.Props & {
  className?: string;
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        {...positionerProps}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-[var(--radius-surface,var(--radius-lg))] p-1.5 shadow-xl ring-1 duration-100 outline-none data-closed:overflow-hidden",
            className,
          )}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "text-muted-foreground px-2 py-1.5 font-mono text-[11px] font-medium tracking-wide uppercase data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-foreground/[0.06] data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive group/context-menu-item relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-foreground/10 -mx-1.5 my-1 h-px", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto font-mono text-[11px] tracking-wider",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
};
