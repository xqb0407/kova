/** IconPicker：lucide 图标搜索选择器（检查器图标节用）。搜索 + 网格预览 + 点选。 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { iconD, resolveIconName, searchIcons } from "../icons";

const Glyph: FC<{ name: string; size?: number }> = ({ name, size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={iconD(name) ?? ""} />
  </svg>
);

export const IconPicker: FC<{ value: string; onPick: (name: string) => void }> = ({ value, onPick }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchIcons(q, 60), [q]);
  const resolved = resolveIconName(value);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQ("");
        }}
        title="选择图标（内置 lucide 全集，可搜索）"
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--secondary)]"
        style={{ color: resolved ? "var(--foreground)" : "var(--destructive)" }}
      >
        <Glyph name={resolved ?? "circle-help"} />
        <span className="flex-1 truncate text-left">{value}</span>
        {!resolved && <span className="text-[10px]" style={{ color: "var(--destructive)" }}>未知名</span>}
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 w-[252px] rounded-xl p-2"
          style={{ background: "var(--popover)", boxShadow: "var(--sh-float), var(--sh-outline)" }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && results[0]) {
                onPick(results[0]);
                setOpen(false);
              }
            }}
            placeholder="搜索图标（home / cart / user…）"
            className="h-7 w-full rounded-md px-2 text-[12px] outline-none"
            style={{ background: "var(--secondary)", color: "var(--foreground)" }}
          />
          <div className="mt-1.5 grid max-h-[228px] grid-cols-6 gap-0.5 overflow-y-auto">
            {results.map((n) => (
              <button
                key={n}
                type="button"
                title={n}
                onClick={() => {
                  onPick(n);
                  setOpen(false);
                }}
                className="flex h-9 items-center justify-center rounded-md transition-colors hover:bg-[var(--secondary)]"
                style={{ color: n === value ? "var(--primary)" : "var(--foreground)" }}
              >
                <Glyph name={n} size={17} />
              </button>
            ))}
          </div>
          <div className="mt-1 text-center text-[10px]" style={{ color: "var(--muted-foreground)" }}>
            {results.length} 个 · 内置 lucide
          </div>
        </div>
      )}
    </div>
  );
};
