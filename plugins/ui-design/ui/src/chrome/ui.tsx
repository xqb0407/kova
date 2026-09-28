/**
 * chrome/ui.tsx：外壳共享小件（ElevenLabs × shadcn 观感）。
 * 全部走 index.css 的 token 变量，深浅主题自动适配；
 * 浮层深度用 --shadow-float/--shadow-pop（描边圈 + 暖环境影），主态黑胶囊。
 */
import { useEffect, useRef, useState, type FC, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { ColorPicker, firstHexOrNull } from "../components/ui/color-picker";
import { scrubSession } from "../state";

/* ---------------- 带提示的图标按钮 ---------------- */

export const IconBtn: FC<{
  children: ReactNode;
  tip?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  size?: number;
  /** 提示弹出方向。贴着视口顶缘的按钮（面板收起钮、窄态胶囊）要用 "bottom"，气泡朝上会被窗口顶缘裁掉看不见 */
  tipSide?: "top" | "bottom";
  /** 水平对齐：贴着视口右缘的按钮用 "end"，气泡右缘贴按钮右缘、向左展开，不溢出窗口 */
  tipAlign?: "center" | "end";
}> = ({ children, tip, active, disabled, onClick, size = 30, tipSide = "top", tipAlign = "center" }) => {
  const pos =
    tipSide === "bottom"
      ? tipAlign === "end"
        ? "top-full right-0 mt-1.5"
        : "top-full left-1/2 mt-1.5 -translate-x-1/2"
      : tipAlign === "end"
        ? "bottom-full right-0 mb-1.5"
        : "bottom-full left-1/2 mb-1.5 -translate-x-1/2";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={tip}
      className="group relative flex items-center justify-center rounded-full transition-colors"
      style={{
        width: size,
        height: size,
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--accent-foreground)" : "var(--foreground)",
        opacity: disabled ? 0.35 : 1,
      }}
      onMouseEnter={(e) => {
        if (!active && !disabled) e.currentTarget.style.background = "var(--secondary)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
      {tip && (
        <span
          data-tip=""
          className={`pointer-events-none absolute z-50 hidden whitespace-nowrap rounded px-1.5 py-1 text-[11px] shadow-md group-hover:block ${pos}`}
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          {tip}
        </span>
      )}
    </button>
  );
};

/* ---------------- 数字输入（label 可横向拖拽调值；输入框失焦/回车提交，方向键步进） ---------------- */

export const NumField: FC<{
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  title?: string;
}> = ({ label, value, onCommit, min, max, step = 1, suffix, title }) => {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) onCommit(clamp(Math.round(n * 100) / 100));
    setText(null);
  };
  /** Figma 式 scrub：按住 label 左右拖，1px = 1 步长，Shift ×10；scrubSession 让整段拖拽并成一步撤销 */
  const scrubbedRef = useRef(false);
  const startScrub = (e: RPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = value;
    let moved = false;
    setText(null);
    scrubSession.active = true;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (dx !== 0) moved = true;
      const rate = step * (ev.shiftKey ? 10 : 1);
      onCommit(clamp(Math.round((v0 + dx * rate) * 100) / 100));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      scrubSession.active = false;
      // 拖过之后，pointerup 派生的 click 会经 label 默认行为把焦点塞进输入框，
      // 导致 ⌘Z 被「输入中」守卫拦掉 —— 吞掉这一次 click 的默认动作。
      scrubbedRef.current = moved;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  return (
    <label
      title={title}
      // 拖拽后 pointerup 常落在输入框上，click 目标变成 label 本身：
      // 在这里吞掉 label→input 的激活默认动作，否则拖完输入框被聚焦、⌘Z 被「输入中」守卫拦掉
      onClick={(e) => {
        if (scrubbedRef.current) {
          scrubbedRef.current = false;
          e.preventDefault();
        }
      }}
      className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 transition-all focus-within:bg-[var(--background)] focus-within:shadow-[0_0_0_1px_var(--border),0_0_0_3px_var(--ring)]"
      style={{ background: "var(--secondary)" }}
    >
      <span
        onPointerDown={startScrub}
        // 焦点是 mousedown 的默认行为（label→input），不吞掉它拖完会把输入框聚焦，⌘Z 被输入守卫拦
        onMouseDown={(e) => e.preventDefault()}
        title={`${label}：左右拖拽调值（Shift 加速）`}
        className="shrink-0 cursor-ew-resize touch-none select-none text-[10px] font-medium tracking-wide"
        style={{ color: "var(--muted-foreground)" }}
      >
        {label}
      </span>
      <input
        className="w-full min-w-0 bg-transparent text-[12px] tabular-nums outline-none"
        style={{ color: "var(--foreground)" }}
        value={text ?? String(Math.round(value * 100) / 100)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = parseFloat(text ?? String(value));
            const next = Number.isFinite(base) ? base + (e.key === "ArrowUp" ? step : -step) : value;
            const v = clamp(Math.round(next * 100) / 100);
            setText(String(v));
            onCommit(v);
          }
        }}
        {...(suffix ? {} : {})}
      />
      {suffix && (
        <span className="shrink-0 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {suffix}
        </span>
      )}
    </label>
  );
};

/* ---------------- 折叠分区（检视器用） ---------------- */

export const Section: FC<{
  title: string;
  right?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}> = ({ title, right, children, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div className="flex h-8 items-center gap-1 px-3">
        <button
          type="button"
          className="group flex flex-1 items-center gap-1 text-[10px] font-semibold tracking-[0.06em] uppercase"
          style={{ color: "var(--muted-foreground)" }}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown size={11} style={{ color: "var(--muted-foreground)", transform: open ? "none" : "rotate(-90deg)", transition: "transform .12s" }} />
          {title}
        </button>
        {right}
      </div>
      {open && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );
};

/* ---------------- 颜色输入（老东家 ColorPicker + hex 文本） ---------------- */

/**
 * 面板弹层复用自老东家（slide-canvas）的 ColorPicker：HSV 区 + 色相条 + iOS/品牌预设。
 * 文档色值允许 8 位（#rrggbbaa，阴影色就带 alpha）：面板只调前 6 位、alpha 尾缀原样保留，
 * hex 文本框仍可直改完整 8 位。
 */
export const ColorInput: FC<{ value: string; onChange: (hex: string) => void; compact?: boolean }> = ({ value, onChange, compact }) => {
  const [text, setText] = useState<string | null>(null);
  const raw = (value ?? "").trim();
  const withAlpha = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(raw);
  const base6 = withAlpha ? `#${withAlpha[1]}` : firstHexOrNull(raw) ?? "#000000";
  const commit = (input: string) => {
    const v = input.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) onChange(v);
    setText(null);
  };
  const picker = (
    <ColorPicker
      color={base6}
      onChange={(hex6) => onChange(withAlpha ? hex6 + withAlpha[2] : hex6)}
      aria-label="选择颜色"
      size="sm"
    />
  );
  if (compact) return <span className="flex shrink-0 items-center">{picker}</span>;
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-md pr-0.5 transition-all focus-within:bg-[var(--background)] focus-within:shadow-[0_0_0_1px_var(--border),0_0_0_3px_var(--ring)]" style={{ background: "var(--secondary)" }}>
      {picker}
      <input
        className="h-full w-full min-w-0 flex-1 bg-transparent text-[12px] uppercase tabular-nums outline-none"
        style={{ color: "var(--foreground)" }}
        value={text ?? raw.replace(/^#/, "")}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
};

/* ---------------- 下拉菜单（浮层弹层：描边圈 + 暖影） ---------------- */

export const Menu: FC<{ trigger: ReactNode; children: ReactNode; align?: "start" | "end" }> = ({ trigger, children, align = "start" }) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-[168px] rounded-xl border p-1 shadow-pop"
        style={{ borderColor: "var(--border)", background: "var(--popover)", color: "var(--popover-foreground)" }}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
);

export const MenuItem: FC<{
  children: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onClick?: () => void;
}> = ({ children, icon, selected, disabled, danger, title, onClick }) => (
  <DropdownMenu.Item
    disabled={disabled}
    title={title}
    onSelect={onClick}
    className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-[var(--secondary)] data-[disabled]:cursor-default data-[disabled]:opacity-40"
    style={{ color: danger ? "var(--destructive)" : "var(--foreground)" }}
  >
    <span className="flex w-4 shrink-0 items-center justify-center">{icon ?? (selected ? <Check size={12} /> : null)}</span>
    {children}
  </DropdownMenu.Item>
);

/* ---------------- 小下拉（检视器选项组：对齐方式/字体等） ---------------- */

export const MiniSelect: FC<{
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  title?: string;
}> = ({ value, options, onChange, title }) => {
  const cur = options.find((o) => o.value === value);
  return (
    <Menu
      align="end"
      trigger={
        <button
          type="button"
          title={title}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] transition-all hover:brightness-95 data-[state=open]:bg-[var(--background)] data-[state=open]:shadow-[0_0_0_1px_var(--border),0_0_0_3px_var(--ring)]"
          style={{ color: "var(--foreground)", background: "var(--secondary)" }}
        >
          <span className="max-w-[110px] truncate">{cur?.label ?? value}</span>
          <ChevronDown size={11} style={{ color: "var(--muted-foreground)" }} />
        </button>
      }
    >
      {options.map((o) => (
        <MenuItem key={o.value} selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  );
};

/* ---------------- 行内文本编辑（图层/页面重命名） ---------------- */

export const InlineEdit: FC<{ value: string; onCommit: (v: string) => void; className?: string }> = ({ value, onCommit, className }) => {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(text);
        if (e.key === "Escape") onCommit(value);
        e.stopPropagation();
      }}
      className={className}
      style={{ background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--accent)", borderRadius: 3, outline: "none", fontSize: 12, width: "100%", padding: "0 4px" }}
    />
  );
};
