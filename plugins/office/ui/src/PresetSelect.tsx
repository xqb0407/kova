import type { FC } from "react";
import { PAGE_SIZES, type PagePreset } from "./doc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** 页幅选择（新建幻灯片的页面尺寸；改档时也用来等比重排全部画板） */
export const PresetSelect: FC<{ value: PagePreset; onChange: (p: PagePreset) => void; className?: string }> = ({ value, onChange, className }) => (
  <Select value={value} onValueChange={(v) => onChange(v as PagePreset)}>
    <SelectTrigger className={cn("h-8 text-xs", className)}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {Object.entries(PAGE_SIZES).map(([k, s]) => (
        <SelectItem key={k} value={k} className="text-xs">
          {s.label} · {s.w}×{s.h}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
