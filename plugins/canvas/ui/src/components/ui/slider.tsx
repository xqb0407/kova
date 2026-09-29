import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

function Slider({ className, defaultValue, value, min = 0, max = 100, step = 1, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  );
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      step={step}
      className={cn("relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {_values.map((v, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block size-3.5 rounded-full border border-primary/30 bg-white shadow-sm ring-0 transition-[color,box-shadow] hover:ring-[3px] hover:ring-ring/30 focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
