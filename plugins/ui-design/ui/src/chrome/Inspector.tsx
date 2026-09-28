/**
 * Inspector：右侧属性面板。选中元素的完整属性：
 * 对齐 · 位置尺寸旋转 · 不透明度 · 圆角 · 填充（纯色/线性/径向渐变）· 描边 · 阴影/层模糊 ·
 * 文本 · 图片适配 · 画板设备预设。多选显示公共操作；未选中显示页面信息。
 */
import { useState, type FC, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronDown,
  Copy,
  LayoutGrid,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Eye,
  EyeOff,
  Italic,
  Link2,
  Lock,
  LockOpen,
  Play,
  Plus,
  Trash2,
  Underline,
} from "lucide-react";
import {
  DEVICE_PRESETS,
  allFrames,
  findNode,
  TYPE_LABELS,
  type DesignNode,
  type Effect,
  type Fill,
  type GradientStop,
  type Stroke,
  type TextNode,
} from "../doc";
import type { AlignMode } from "../geometry";
import type { DesignStore } from "../state";
import { nodeToCss } from "../css";
import { copyText } from "../lib/clipboard";
import { ColorInput, IconBtn, Menu, MenuItem, MiniSelect, NumField, Section } from "./ui";

/* ---------------- 类型收窄小工具 ---------------- */

type HasFills = DesignNode & { fills: Fill[] };
type HasStrokes = DesignNode & { strokes: Stroke[] };
const hasFills = (n: DesignNode | null): n is HasFills =>
  !!n && (n.type === "rect" || n.type === "ellipse" || n.type === "triangle" || n.type === "diamond" || n.type === "pentagon" || n.type === "hexagon" || n.type === "star" || n.type === "frame");
const hasStrokes = (n: DesignNode | null): n is HasStrokes =>
  !!n && (hasFills(n) || n.type === "line" || n.type === "arrow" || n.type === "image");
const isBoxRadius = (n: DesignNode | null): boolean => !!n && (n.type === "rect" || n.type === "frame" || n.type === "image");

const ALIGN_BTNS: { mode: AlignMode; icon: FC<{ size?: number }>; tip: string }[] = [
  { mode: "left", icon: AlignStartVertical, tip: "左对齐" },
  { mode: "hcenter", icon: AlignCenterVertical, tip: "水平居中" },
  { mode: "right", icon: AlignEndVertical, tip: "右对齐" },
  { mode: "top", icon: AlignStartHorizontal, tip: "顶对齐" },
  { mode: "vcenter", icon: AlignCenterHorizontal, tip: "垂直居中" },
  { mode: "bottom", icon: AlignEndHorizontal, tip: "底对齐" },
];

/* ---------------- 填充行（含渐变编辑弹层） ---------------- */

const FILL_TYPES = [
  { value: "solid", label: "纯色" },
  { value: "linear", label: "线性" },
  { value: "radial", label: "径向" },
];

/** 行尾操作钮：悬停行才现身（禁用态常显），Figma 式降噪 */
const RowIcon: FC<{
  tip: string;
  onClick: () => void;
  disabled?: boolean;
  always?: boolean;
  color?: string;
  children: ReactNode;
}> = ({ tip, onClick, disabled, always, color, children }) => (
  <button
    type="button"
    title={tip}
    disabled={disabled}
    onClick={onClick}
    className={`flex h-6 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-[var(--secondary)] disabled:opacity-30 ${always ? "" : "opacity-0 group-hover:opacity-100"}`}
    style={{ color: color ?? "var(--muted-foreground)" }}
  >
    {children}
  </button>
);

const FillRow: FC<{
  fill: Fill;
  onChange: (f: Fill) => void;
  onRemove: () => void;
  onToggle: () => void;
}> = ({ fill, onChange, onRemove, onToggle }) => {
  const [open, setOpen] = useState(true);
  const stops: GradientStop[] = fill.stops ?? [
    { at: 0, color: fill.color ?? "#4a90d9" },
    { at: 1, color: "#ffffff" },
  ];
  const setStops = (s: GradientStop[]) => onChange({ ...fill, stops: s });
  const hidden = fill.visible === false;
  return (
    <div className="group">
      <div className="flex h-7 items-center gap-1" style={{ opacity: hidden ? 0.45 : 1 }}>
        {fill.type !== "solid" && (
          <button
            type="button"
            title={open ? "收起" : "展开"}
            onClick={() => setOpen((o) => !o)}
            className="flex h-5 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--secondary)]"
            style={{ color: "var(--muted-foreground)" }}
          >
            <ChevronDown size={11} style={{ transform: open ? "none" : "rotate(-90deg)" }} />
          </button>
        )}
        <MiniSelect
          value={fill.type}
          options={FILL_TYPES}
          onChange={(v) => {
            const t = v as Fill["type"];
            if (t === "solid") {
              onChange({ type: "solid", color: stops[0]?.color ?? "#000000", opacity: fill.opacity, visible: fill.visible });
              setOpen(false);
            } else {
              onChange({ type: t, stops, angle: fill.angle ?? 90, opacity: fill.opacity, visible: fill.visible });
              setOpen(true);
            }
          }}
        />
        {fill.type === "solid" ? (
          <ColorInput value={fill.color ?? "#000000"} onChange={(c) => onChange({ ...fill, color: c })} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            {stops.length} 色标
          </span>
        )}
        <span className="flex w-[48px] shrink-0">
          <NumField label="α" min={0} max={100} value={Math.round((fill.opacity ?? 1) * 100)} onCommit={(v) => onChange({ ...fill, opacity: v / 100 })} title="填充不透明度 %" />
        </span>
        <RowIcon tip={hidden ? "显示" : "隐藏"} onClick={onToggle} always={hidden} color={hidden ? "var(--muted-foreground)" : "var(--foreground)"}>
          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </RowIcon>
        <RowIcon tip="删除填充" onClick={onRemove}>
          <Trash2 size={12} />
        </RowIcon>
      </div>
      {open && fill.type !== "solid" && (
        <div className="ml-4 mt-1 space-y-1.5 rounded-lg p-2" style={{ background: "var(--secondary)" }}>
          <div className="flex items-center gap-1.5">
            <NumField label="角度" min={0} max={360} value={fill.angle ?? 90} onCommit={(v) => onChange({ ...fill, angle: v })} />
            {fill.type === "radial" && (
              <>
                <NumField label="CX" min={0} max={100} value={Math.round((fill.center?.x ?? 0.5) * 100)} onCommit={(v) => onChange({ ...fill, center: { x: v / 100, y: fill.center?.y ?? 0.5 } })} />
                <NumField label="CY" min={0} max={100} value={Math.round((fill.center?.y ?? 0.5) * 100)} onCommit={(v) => onChange({ ...fill, center: { x: fill.center?.x ?? 0.5, y: v / 100 } })} />
              </>
            )}
          </div>
          {stops.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <ColorInput value={s.color} onChange={(c) => setStops(stops.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
              <NumField label="位" min={0} max={100} value={Math.round(s.at * 100)} suffix="%" onCommit={(v) => setStops(stops.map((x, j) => (j === i ? { at: v / 100, color: x.color } : x)).sort((a, b) => a.at - b.at))} title="色标位置 %" />
              <RowIcon tip="删除色标" disabled={stops.length <= 2} always onClick={() => setStops(stops.filter((_, j) => j !== i))}>
                <Trash2 size={11} />
              </RowIcon>
            </div>
          ))}
          {stops.length < 8 && (
            <button
              type="button"
              onClick={() => setStops([...stops, { at: 1, color: "#000000" }].sort((a, b) => a.at - b.at))}
              className="flex h-6 items-center gap-1 rounded-md px-1 text-[11px] font-medium transition-colors hover:bg-[var(--background)]"
              style={{ color: "var(--foreground)" }}
            >
              <Plus size={11} /> 添加色标
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/* ---------------- 描边行 ---------------- */

const STROKE_ALIGNS = [
  { value: "inside", label: "内" },
  { value: "center", label: "中" },
  { value: "outside", label: "外" },
];
const STROKE_STYLES = [
  { value: "solid", label: "实" },
  { value: "dashed", label: "虚" },
  { value: "dotted", label: "点" },
];

const StrokeRow: FC<{
  stroke: Stroke;
  onChange: (s: Stroke) => void;
  onRemove: () => void;
  onToggle: () => void;
}> = ({ stroke, onChange, onRemove, onToggle }) => {
  const hidden = stroke.visible === false;
  return (
    <div className="group flex h-7 items-center gap-1.5" style={{ opacity: hidden ? 0.45 : 1 }}>
      <ColorInput compact value={stroke.color} onChange={(c) => onChange({ ...stroke, color: c })} />
      <NumField label="宽" min={0.5} max={64} step={0.5} value={stroke.width} onCommit={(v) => onChange({ ...stroke, width: v })} title="描边宽度" />
      <MiniSelect value={stroke.align ?? "center"} options={STROKE_ALIGNS} onChange={(v) => onChange({ ...stroke, align: v as Stroke["align"] })} title="描边对齐" />
      <MiniSelect value={stroke.style ?? "solid"} options={STROKE_STYLES} onChange={(v) => onChange({ ...stroke, style: v as Stroke["style"] })} title="线型" />
      <RowIcon tip={hidden ? "显示" : "隐藏"} onClick={onToggle} always={hidden} color={hidden ? "var(--muted-foreground)" : "var(--foreground)"}>
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </RowIcon>
      <RowIcon tip="删除描边" onClick={onRemove}>
        <Trash2 size={12} />
      </RowIcon>
    </div>
  );
};

/* ---------------- 效果行 ---------------- */

const EFFECT_LABEL: Record<Effect["type"], string> = { "drop-shadow": "外投影", "inner-shadow": "内投影", "layer-blur": "层模糊" };

const EffectRow: FC<{
  effect: Effect;
  onChange: (e: Effect) => void;
  onRemove: () => void;
  onToggle: () => void;
}> = ({ effect, onChange, onRemove, onToggle }) => {
  const shadow = effect.type !== "layer-blur";
  const hidden = effect.visible === false;
  return (
    <div className="group flex h-7 items-center gap-1.5" style={{ opacity: hidden ? 0.45 : 1 }}>
      <span className="w-11 shrink-0 text-[10px] font-medium" style={{ color: "var(--muted-foreground)" }}>
        {EFFECT_LABEL[effect.type]}
      </span>
      {shadow ? (
        <>
          <ColorInput compact value={effect.color} onChange={(c) => onChange({ ...effect, color: c })} />
          <NumField label="X" value={effect.x} onCommit={(v) => onChange({ ...effect, x: v })} />
          <NumField label="Y" value={effect.y} onCommit={(v) => onChange({ ...effect, y: v })} />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <NumField label="B" min={0} max={100} value={effect.blur} onCommit={(v) => onChange({ ...effect, blur: v })} title="模糊半径" />
      <RowIcon tip={hidden ? "显示" : "隐藏"} onClick={onToggle} always={hidden} color={hidden ? "var(--muted-foreground)" : "var(--foreground)"}>
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </RowIcon>
      <RowIcon tip="删除效果" onClick={onRemove}>
        <Trash2 size={12} />
      </RowIcon>
    </div>
  );
};

/* ---------------- 主面板 ---------------- */

export const Inspector: FC<{ store: DesignStore; onPreview?: () => void }> = ({ store, onPreview }) => {
  const { doc, page, selIds, updateNode, align } = store;
  const loc = selIds.length === 1 ? findNode(doc, selIds[0]!) : null;
  const node = loc?.node ?? null;
  const [cornersOpen, setCornersOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (selIds.length === 0) {
    return (
      <div
      className="pointer-events-auto flex h-full w-full flex-col overflow-y-auto pr-2"
      style={{ background: "var(--background)" }}
    >
      <div className="px-4 pt-4 text-[12px] font-semibold" style={{ color: "var(--foreground)" }}>
        {page.name}
      </div>
        <div className="px-4 pt-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {page.nodes.length} 个顶层元素 · 未选中任何图层
        </div>
        <div className="mx-3 mt-3 rounded-lg p-3 text-[11px] leading-5" style={{ background: "var(--secondary)", color: "var(--muted-foreground)" }}>
          选中画布或左侧图层树中的元素后，这里会显示它的全部属性：位置尺寸、圆角、填充、描边、阴影、文字与导出。
        </div>
      </div>
    );
  }

  if (selIds.length > 1) {
    return (
      <div
      className="pointer-events-auto flex h-full w-full flex-col overflow-y-auto pr-2"
      style={{ background: "var(--background)" }}
    >
      <div className="px-4 pt-4 text-[12px] font-semibold" style={{ color: "var(--foreground)" }}>
        已选中 {selIds.length} 个元素
      </div>
        <Section title="对齐与分布">
          <div className="flex gap-0.5">
            {ALIGN_BTNS.map((b) => (
              <IconBtn key={b.mode} tip={b.tip} size={28} onClick={() => align(b.mode)}>
                <b.icon size={14} />
              </IconBtn>
            ))}
          </div>
          <div className="mt-1 flex gap-0.5">
            <IconBtn tip="横向等距分布" size={28} onClick={() => align("hdist")}>
              <AlignHorizontalDistributeCenter size={14} />
            </IconBtn>
            <IconBtn tip="纵向等距分布" size={28} onClick={() => align("vdist")}>
              <AlignVerticalDistributeCenter size={14} />
            </IconBtn>
          </div>
        </Section>
        <div className="px-4 pt-2 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          提示：按住 ⌘ 点击图层可加选/减选；成组后按 ⌘⇧G 解组。
        </div>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="pointer-events-auto h-full w-full" style={{ background: "var(--background)" }} />
    );
  }

  const n = node;
  const set = (patch: Partial<DesignNode>) => updateNode(n.id, patch, { coalesce: true });
  const text = n.type === "text" ? (n as TextNode) : null;

  const addFill = () => {
    if (!hasFills(n)) return;
    updateNode(n.id, (m) => (hasFills(m) ? ({ ...m, fills: [...m.fills, { type: "solid", color: "#d9d9d9" }] } as DesignNode) : m));
  };
  const addStroke = () => {
    if (!hasStrokes(n)) return;
    updateNode(n.id, (m) => (hasStrokes(m) ? ({ ...m, strokes: [...m.strokes, { color: "#111111", width: 1 }] } as DesignNode) : m));
  };
  const addEffect = (t: Effect["type"]) => {
    const eff: Effect = t === "layer-blur" ? { type: t, blur: 8 } : { type: t, color: "rgba(0,0,0,0.25)", x: 0, y: 4, blur: 12 };
    updateNode(n.id, (m) => ({ ...m, effects: [...(m.effects ?? []), eff] } as DesignNode));
  };

  const radiusValue = typeof n.radius === "number" ? n.radius : n.radius?.[0] ?? 0;
  const corners = typeof n.radius === "number" ? [n.radius, n.radius, n.radius, n.radius] : n.radius ?? [0, 0, 0, 0];
  const nonUniform = Array.isArray(n.radius) && !(n.radius[0] === n.radius[1] && n.radius[1] === n.radius[2] && n.radius[2] === n.radius[3]);

  return (
    <div
      className="pointer-events-auto flex h-full w-[272px] shrink-0 flex-col overflow-y-auto border-l pr-2"
      style={{ borderColor: "var(--border)", background: "var(--background)" }}
    >
      {/* 头部：类型 + 名称 */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--secondary)", color: "var(--muted-foreground)" }}>
          {TYPE_LABELS[n.type] ?? n.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: "var(--foreground)" }} title={n.name}>
          {n.name}
        </span>
      </div>

      {/* 对齐 */}
      <Section title="对齐">
        <div className="flex gap-0.5">
          {ALIGN_BTNS.map((b) => (
            <IconBtn key={b.mode} tip={b.tip} size={28} onClick={() => align(b.mode)}>
              <b.icon size={14} />
            </IconBtn>
          ))}
        </div>
      </Section>

      {/* 位置与尺寸 */}
      <Section title={n.type === "frame" ? "画板" : "位置与尺寸"}>
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <NumField label="X" value={n.x} onCommit={(v) => set({ x: v })} />
            <NumField label="Y" value={n.y} onCommit={(v) => set({ y: v })} />
          </div>
          <div className="flex gap-1.5">
            <NumField label="W" min={1} value={n.w} onCommit={(v) => set({ w: v })} />
            <NumField label="H" min={1} value={n.h} onCommit={(v) => set({ h: v })} />
          </div>
          <div className="flex gap-1.5">
            <NumField label="∠" min={-360} max={360} value={n.rotation ?? 0} onCommit={(v) => set({ rotation: v })} suffix="°" title="旋转角度" />
            <NumField label="O" min={0} max={100} value={Math.round((n.opacity ?? 1) * 100)} onCommit={(v) => set({ opacity: v / 100 })} suffix="%" title="不透明度" />
          </div>
          {n.type === "frame" && (
            <div className="flex items-center gap-1.5">
              <MiniSelect
                value={n.preset ?? "custom"}
                options={[{ value: "custom", label: "设备预设…" }, ...Object.entries(DEVICE_PRESETS).map(([k, p]) => ({ value: k, label: p.label }))]}
                onChange={(v) => {
                  const p = DEVICE_PRESETS[v];
                  if (p) updateNode(n.id, { w: p.w, h: p.h, preset: v } as Partial<DesignNode>);
                }}
                title="套用设备尺寸预设"
              />
              <MiniSelect
                value={n.clip === false ? "off" : "on"}
                options={[
                  { value: "on", label: "裁切内容" },
                  { value: "off", label: "不裁切" },
                ]}
                onChange={(v) => updateNode(n.id, { clip: v === "on" } as Partial<DesignNode>)}
                title="画板是否裁切溢出内容"
              />
            </div>
          )}
        </div>
      </Section>

      {/* 圆角 */}
      {isBoxRadius(n) && (
        <Section title="圆角">
          <div className="flex gap-1.5">
            <NumField
              label="半径"
              min={0}
              max={4096}
              value={radiusValue}
              onCommit={(v) => set({ radius: v })}
              title="四角统一圆角"
            />
            <button
              type="button"
              title="分别设置四角"
              onClick={() => setCornersOpen((o) => !o)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all hover:brightness-95"
              style={{
                background: "var(--secondary)",
                color: cornersOpen || nonUniform ? "var(--foreground)" : "var(--muted-foreground)",
                boxShadow: cornersOpen ? "0 0 0 1px var(--border), 0 0 0 3px var(--ring)" : undefined,
              }}
            >
              <LayoutGrid size={13} />
            </button>
          </div>
          {(cornersOpen || nonUniform) && (
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {(["左上", "右上", "右下", "左下"] as const).map((lab, i) => (
                <NumField
                  key={lab}
                  label={lab}
                  min={0}
                  max={4096}
                  value={corners[i] ?? 0}
                  onCommit={(v) => {
                    const next = [...corners] as [number, number, number, number];
                    next[i] = v;
                    set({ radius: next });
                  }}
                />
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 填充 */}
      {hasFills(n) && (
        <Section
          title="填充"
          right={
            <button type="button" title="添加填充" onClick={addFill} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--secondary)]" style={{ color: "var(--muted-foreground)" }}>
              <Plus size={14} />
            </button>
          }
        >
          <div className="space-y-1.5">
            {n.fills.map((f, i) => (
              <FillRow
                key={i}
                fill={f}
                onChange={(nf) => updateNode(n.id, (m) => (hasFills(m) ? ({ ...m, fills: m.fills.map((x, j) => (j === i ? nf : x)) } as DesignNode) : m))}
                onRemove={() => updateNode(n.id, (m) => (hasFills(m) ? ({ ...m, fills: m.fills.filter((_, j) => j !== i) } as DesignNode) : m))}
                onToggle={() => updateNode(n.id, (m) => (hasFills(m) ? ({ ...m, fills: m.fills.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)) } as DesignNode) : m))}
              />
            ))}
            {n.fills.length === 0 && <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>无填充</div>}
          </div>
        </Section>
      )}

      {/* 描边 */}
      {hasStrokes(n) && (
        <Section
          title="描边"
          right={
            <button type="button" title="添加描边" onClick={addStroke} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--secondary)]" style={{ color: "var(--muted-foreground)" }}>
              <Plus size={14} />
            </button>
          }
        >
          <div className="space-y-1.5">
            {(n.strokes ?? []).map((s, i) => (
              <StrokeRow
                key={i}
                stroke={s}
                onChange={(ns) => updateNode(n.id, (m) => (hasStrokes(m) ? ({ ...m, strokes: m.strokes.map((x, j) => (j === i ? ns : x)) } as DesignNode) : m))}
                onRemove={() => updateNode(n.id, (m) => (hasStrokes(m) ? ({ ...m, strokes: m.strokes.filter((_, j) => j !== i) } as DesignNode) : m))}
                onToggle={() => updateNode(n.id, (m) => (hasStrokes(m) ? ({ ...m, strokes: m.strokes.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)) } as DesignNode) : m))}
              />
            ))}
            {(n.strokes ?? []).length === 0 && <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>无描边</div>}
          </div>
        </Section>
      )}

      {/* 效果 */}
      <Section
        title="特效"
        right={
          <Menu
            align="end"
            trigger={
              <button type="button" title="添加效果" className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--secondary)]" style={{ color: "var(--muted-foreground)" }}>
                <Plus size={14} />
              </button>
            }
          >
            <MenuItem onClick={() => addEffect("drop-shadow")}>外投影</MenuItem>
            <MenuItem onClick={() => addEffect("inner-shadow")}>内投影</MenuItem>
            <MenuItem onClick={() => addEffect("layer-blur")}>层模糊</MenuItem>
          </Menu>
        }
      >
        <div className="space-y-1.5">
          {(n.effects ?? []).map((ef, i) => (
            <EffectRow
              key={i}
              effect={ef}
              onChange={(ne) => updateNode(n.id, (m) => ({ ...m, effects: (m.effects ?? []).map((x, j) => (j === i ? ne : x)) } as DesignNode))}
              onRemove={() => updateNode(n.id, (m) => ({ ...m, effects: (m.effects ?? []).filter((_, j) => j !== i) } as DesignNode))}
              onToggle={() => updateNode(n.id, (m) => ({ ...m, effects: (m.effects ?? []).map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)) } as DesignNode))}
            />
          ))}
          {(n.effects ?? []).length === 0 && <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>无投影 / 模糊</div>}
        </div>
      </Section>

      {/* 文本 */}
      {text && (
        <Section title="文字">
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <NumField label="字号" min={4} max={400} value={text.runs[0]?.size ?? 16} onCommit={(v) => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, size: v })) } as DesignNode) : m))} />
              <MiniSelect
                value={String(text.runs[0]?.weight ?? 400)}
                options={[
                  { value: "400", label: "常规" },
                  { value: "500", label: "中等" },
                  { value: "600", label: "半粗" },
                  { value: "700", label: "粗体" },
                ]}
                onChange={(v) => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, weight: Number(v) })) } as DesignNode) : m))}
                title="字重"
              />
              <div className="flex gap-0.5">
                <IconBtn tip="斜体" size={28} active={!!text.runs[0]?.italic} onClick={() => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, italic: !r.italic })) } as DesignNode) : m))}>
                  <Italic size={13} />
                </IconBtn>
                <IconBtn tip="下划线" size={28} active={!!text.runs[0]?.underline} onClick={() => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, underline: !r.underline })) } as DesignNode) : m))}>
                  <Underline size={13} />
                </IconBtn>
              </div>
            </div>
            <div className="flex gap-1.5">
              <ColorInput value={text.runs[0]?.color ?? "#111111"} onChange={(c) => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, color: c })) } as DesignNode) : m))} />
            </div>
            <div className="flex gap-1.5">
              <MiniSelect
                value={text.align ?? "left"}
                options={[
                  { value: "left", label: "左对齐" },
                  { value: "center", label: "居中" },
                  { value: "right", label: "右对齐" },
                ]}
                onChange={(v) => updateNode(n.id, { align: v as "left" | "center" | "right" } as Partial<DesignNode>)}
                title="水平对齐"
              />
              <MiniSelect
                value={text.vAlign ?? "top"}
                options={[
                  { value: "top", label: "顶对齐" },
                  { value: "middle", label: "垂直居中" },
                  { value: "bottom", label: "底对齐" },
                ]}
                onChange={(v) => updateNode(n.id, { vAlign: v as "top" | "middle" | "bottom" } as Partial<DesignNode>)}
                title="垂直对齐"
              />
            </div>
            <div className="flex gap-1.5">
              <NumField label="行高" min={0.5} max={5} step={0.1} value={text.lineHeight ?? 1.4} onCommit={(v) => updateNode(n.id, { lineHeight: v } as Partial<DesignNode>)} />
              <NumField label="字距" min={-5} max={50} step={0.5} value={text.letterSpacing ?? 0} onCommit={(v) => updateNode(n.id, { letterSpacing: v } as Partial<DesignNode>)} />
            </div>
            <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              双击画布上的文字可直接改内容
            </div>
          </div>
        </Section>
      )}

      {/* 图片 */}
      {n.type === "image" && (
        <Section title="图片">
          <MiniSelect
            value={n.fit ?? "cover"}
            options={[
              { value: "cover", label: "裁剪填满（cover）" },
              { value: "contain", label: "完整显示（contain）" },
              { value: "stretch", label: "拉伸铺满（stretch）" },
            ]}
            onChange={(v) => updateNode(n.id, { fit: v as "cover" | "contain" | "stretch" } as Partial<DesignNode>)}
            title="图片适配方式"
          />
          <div className="mt-1.5 truncate text-[11px]" style={{ color: "var(--muted-foreground)" }} title={n.src}>
            {n.src}
          </div>
        </Section>
      )}

      {/* 原型交互：单击 → 跳转画板 */}
      <Section title="原型">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="flex w-11 shrink-0 items-center gap-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              <Link2 size={11} />
              单击
            </span>
            <MiniSelect
              value={n.onTap?.to ?? ""}
              options={[
                { value: "", label: "无跳转" },
                ...allFrames(doc).map(({ pageId, frame }) => ({
                  value: frame.id,
                  label: `${doc.pages.find((p) => p.id === pageId)?.name ?? "?"} / ${frame.name}`,
                })),
              ]}
              onChange={(v) =>
                v
                  ? updateNode(n.id, { onTap: { to: v } } as Partial<DesignNode>)
                  : updateNode(n.id, (m) => {
                      const c = { ...m } as DesignNode & { onTap?: unknown };
                      delete c.onTap;
                      return c;
                    })
              }
              title="点击该元素时跳转的目标画板"
            />
          </div>
          {n.onTap && findNode(doc, n.onTap.to)?.node.type !== "frame" && (
            <div className="text-[11px]" style={{ color: "var(--destructive)" }}>
              跳转目标已删除或不是画板，预览/导出时忽略
            </div>
          )}
          {onPreview && (
            <button
              type="button"
              onClick={onPreview}
              className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-all hover:brightness-95"
              style={{ background: "var(--secondary)", color: "var(--foreground)" }}
            >
              <Play size={12} /> 预览原型
            </button>
          )}
        </div>
      </Section>

      {/* 锁定/显隐快捷 */}
      <Section title="状态">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => store.toggleFlag(n.id, "visible")}
            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] transition-all hover:brightness-95"
            style={{ background: "var(--secondary)", color: n.visible === false ? "var(--muted-foreground)" : "var(--foreground)" }}
          >
            {n.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
            {n.visible === false ? "已隐藏" : "显示中"}
          </button>
          <button
            type="button"
            onClick={() => store.toggleFlag(n.id, "locked")}
            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] transition-all hover:brightness-95"
            style={{ background: "var(--secondary)", color: n.locked ? "var(--foreground)" : "var(--muted-foreground)" }}
          >
            {n.locked ? <Lock size={12} /> : <LockOpen size={12} />}
            {n.locked ? "已锁定" : "未锁定"}
          </button>
        </div>
      </Section>

      {/* 代码：节点样式的 CSS 近似表达（开发交接复制用） */}
      <Section
        title="代码"
        right={
          <button
            type="button"
            title="复制该图层的 CSS"
            onClick={() => {
              void copyText(nodeToCss(n)).then((ok) => {
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors hover:bg-[var(--secondary)]"
            style={{ color: copied ? "var(--accent)" : "var(--muted-foreground)" }}
          >
            <Copy size={11} /> {copied ? "已复制" : "复制 CSS"}
          </button>
        }
      >
        <pre
          className="max-h-[240px] select-text overflow-auto rounded-lg p-2.5 font-mono leading-[1.6]"
          style={{ background: "var(--secondary)", color: "var(--foreground)", fontSize: 10.5 }}
        >
          {nodeToCss(n)}
        </pre>
      </Section>
    </div>
  );
};
