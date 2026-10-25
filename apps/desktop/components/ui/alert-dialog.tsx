"use client";
import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";
import { OcclusionSlot } from "@/components/custom-ui/occlusion-slot";
import { X } from "lucide-react";

const AlertDialogRoot = AlertDialog.Root;
const AlertDialogTrigger = AlertDialog.Trigger;
const AlertDialogPortal = ({
  children,
  ...props
}: React.ComponentProps<typeof AlertDialog.Portal>) => (
  <AlertDialog.Portal {...props}>
    <OcclusionSlot />
    {children}
  </AlertDialog.Portal>
);

const AlertDialogOverlay = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Backdrop>,
  React.ComponentPropsWithoutRef<typeof AlertDialog.Backdrop>
>(({ className, ...props }, ref) => (
  <AlertDialog.Backdrop
    ref={ref}
    className={cn(
      // ✅ 遮罩：bg-black/10 淡黑色，和你最早版本一致，不加重
      "fixed inset-0 isolate z-50 bg-black/10 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
      className
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialog.Backdrop.displayName;

type AlertDialogContentProps = React.ComponentPropsWithoutRef<typeof AlertDialog.Popup> & {
  size?: "sm" | "default" | "lg";
};
const AlertDialogContent = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Popup>,
  AlertDialogContentProps
>(({ className, size = "default", children, ...props }, ref) => {
  const sizeClass = {
    sm: "max-w-sm",
    default: "max-w-lg",
    lg: "max-w-2xl",
  }[size];
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialog.Popup
        ref={ref}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full min-w-[420px] translate-x-[-50%] translate-y-[-50%] gap-5 bg-background p-6 shadow-xl duration-200 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 rounded-2xl",
          sizeClass,
          className
        )}
        {...props}
      >
        {/* 关闭按钮复用 Button 的 ghost 样式（与 DialogContent 一致）：焦点环只在
            focus-visible 出现，避免 Base UI 打开时自动聚焦就画出 ring。 */}
        <AlertDialog.Close
          render={<Button variant="ghost" size="icon-sm" className="absolute top-4 right-4" />}
        >
          <X />
          <span className="sr-only">关闭</span>
        </AlertDialog.Close>
        {children}
      </AlertDialog.Popup>
    </AlertDialogPortal>
  );
});
AlertDialogContent.displayName = AlertDialog.Popup.displayName;

const AlertDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-2 text-left", className)}
    {...props}
  />
);
AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex justify-end gap-3", className)}
    {...props}
  />
);
AlertDialogFooter.displayName = "AlertDialogFooter";

const AlertDialogTitle = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialog.Title>
>(({ className, ...props }, ref) => (
  <AlertDialog.Title
    ref={ref}
    className={cn("text-lg font-semibold", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialog.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialog.Description>
>(({ className, ...props }, ref) => (
  <AlertDialog.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialog.Description.displayName;

type AlertDialogActionProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;
const AlertDialogAction = React.forwardRef<
  HTMLButtonElement,
  AlertDialogActionProps
>(({ className, variant = "destructive", size = "default", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
));
AlertDialogAction.displayName = "AlertDialogAction";

type AlertDialogCancelProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;
const AlertDialogCancel = React.forwardRef<
  HTMLButtonElement,
  AlertDialogCancelProps
>(({ className, variant = "outline", size = "default", ...props }, ref) => (
  <AlertDialog.Close
    ref={ref}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
));
AlertDialogCancel.displayName = "AlertDialogCancel";

export {
  AlertDialogRoot as AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
