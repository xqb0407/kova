import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-7 w-full min-w-0 rounded-md border border-input bg-secondary/60 px-2 py-1 text-xs shadow-xs outline-none transition-[color,box-shadow]",
        "placeholder:text-muted-foreground/60 focus-visible:border-ink/60 focus-visible:ring-[2px] focus-visible:ring-ink/10",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
