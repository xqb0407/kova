/**
 * 属性面板小表单件（自 App.tsx 拆出）：小节标题 / 分组卡 / 受控数值输入 / 颜色行。
 */
import { useState, type FC, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { cn } from "@/lib/utils";

/* ---------------- 小表单件 ---------------- */

/** 面板小节标签：11px 中灰标题（macOS System Settings 语言：小灰字 + 分组卡说话） */
export const SectionTitle: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="mt-5 mb-1.5 flex items-center">
    <span className="text-muted-foreground text-[11px] font-medium tracking-wide">{children}</span>
  </div>
);

/** Apple 风 grouped 内嵌卡：小节内容的统一容器——无描边，浅底 + 大圆角 + 极轻投影，
 *  属性面板的分组感全靠它（替代分隔线/大留白）；暗色态用白色低透明度垫层。 */
export const GroupCard: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn("rounded-[16px]", className)}>{children}</div>
);

/** 受控数值输入：编辑中不被外部值回写打断（拖拽同步等），失焦后归一 */
export const NumField: FC<{
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}> = ({ label, value, onChange, min, max, step = 1 }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  const commitVal = (raw: string) => {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onChange(v);
    }
    setDraft(null);
  };
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="text-muted-foreground w-8 shrink-0 truncate text-[11px] font-medium">{label}</span>
      <Input
        type="number"
        className="h-7 w-full min-w-0 px-2 text-xs"
        value={shown}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number.parseFloat(e.target.value);
          if (Number.isFinite(n)) commitVal(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </label>
  );
};

export const ColorField: FC<{
  label: string;
  value: string | undefined;
  onChange: (hex: string) => void;
  onClear?: () => void;
}> = ({ label, value, onChange, onClear }) => {
  // 渐变串长达百字符，直接排进面板会溢出：折行处显示“渐变”，全文放 title 悬停可看
  const isGradient = !!value && value.includes("gradient");
  return (
    <label className="flex w-full min-w-0 items-center gap-1.5">
      <span className="text-muted-foreground w-11 shrink-0 text-[11px] font-medium tracking-wide uppercase">{label}</span>
      <ColorPicker color={value} onChange={onChange} aria-label={`${label}颜色`} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]" title={isGradient ? value : undefined}>
        {value === "none" ? "无" : isGradient ? "渐变" : (value ?? "—")}
      </span>
      {onClear && (
        <button
          type="button"
          title="清除颜色"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-[11px] underline-offset-2 hover:underline"
        >
          清除
        </button>
      )}
    </label>
  );
};
