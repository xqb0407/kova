"use client";
import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";
import { OcclusionSlot } from "@/components/custom-ui/occlusion-slot";

const AlertDialogRoot = AlertDialog.Root;
const AlertDialogTrigger = AlertDialog.Trigger;
const AlertDialogPortal = ({
  children,
  ...props
}: React.ComponentProps<typeof AlertDialog.Portal>) => (
  // 同 dialog：children 必须解构出来合并——JSX 显式子节点会覆盖 {...props} 里的
  // children，不显式渲染就会把调用方的子树悄悄丢掉
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
        // 不给遮罩加 backdrop-blur：WKWebView（Tauri macOS）对带
        // backdrop-filter 的元素做 opacity 动画/销毁图层时会闪黑帧
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
>(({ className, size = "default", ...props }, ref) => {
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
          "fixed left-[50%] top-[50%] z-50 ring-1 ring-foreground/10 grid w-full translate-x-[-50%] translate-y-[-50%] gap-4  bg-background p-6 duration-200 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 rounded-xl",
          sizeClass,
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
});
AlertDialogContent.displayName = AlertDialog.Popup.displayName;

const AlertDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
);
AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
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

// ✅ 使用 VariantProps 拿到 variant/size 类型
type AlertDialogActionProps = React.ComponentPropsWithoutRef<typeof AlertDialog.Close> &
  VariantProps<typeof buttonVariants>;
const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Close>,
  AlertDialogActionProps
>(({ className, variant = "default", size = "default", ...props }, ref) => (
  <AlertDialog.Close
    ref={ref}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
));
AlertDialogAction.displayName = "AlertDialogAction";

type AlertDialogCancelProps = React.ComponentPropsWithoutRef<typeof AlertDialog.Close> &
  VariantProps<typeof buttonVariants>;
const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof AlertDialog.Close>,
  AlertDialogCancelProps
>(({ className, variant = "outline", size = "default", ...props }, ref) => (
  <AlertDialog.Close
    ref={ref}
    className={cn(buttonVariants({ variant, size }), "mt-2 sm:mt-0", className)}
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
