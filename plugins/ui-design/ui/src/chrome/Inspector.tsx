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
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Lock,
  LockOpen,
  Plus,
  Trash2,
  Underline,
} from "lucide-react";
import {
  DEVICE_PRESETS,
  findComponent,
  findNode,
  TYPE_LABELS,
  type DesignNode,
  type Effect,
  type Fill,
  type GradientStop,
  type Stroke,
  type TextNode,
  type DesignDoc,
} from "../doc";
import type { AlignMode } from "../geometry";
import type { DesignStore } from "../state";
import { nodeToCode, nodeToCss, type CodeLang } from "../css";
import { resolveIconName } from "../icons";
import type { BlendMode, FrameLayout } from "../doc";
import { copyText } from "../lib/clipboard";
import { IconPicker } from "./IconPicker";
import { InteractionEditor } from "./InteractionEditor";
import { ColorInput, IconBtn, Menu, MenuItem, MiniSelect, NumField, Section, VarColorCell } from "./ui";

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
  { value: "image", label: "图片" },
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
  doc: DesignDoc;
  onCreateVar: (value: string) => string;
  onChange: (f: Fill) => void;
  onRemove: () => void;
  onToggle: () => void;
}> = ({ fill, doc, onCreateVar, onChange, onRemove, onToggle }) => {
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
            } else if (t === "image") {
              onChange({ type: "image", src: fill.src ?? "", scaleMode: "fill", opacity: fill.opacity, visible: fill.visible });
              setOpen(true);
            } else {
              onChange({ type: t, stops, angle: fill.angle ?? 90, opacity: fill.opacity, visible: fill.visible });
              setOpen(true);
            }
          }}
        />
        {fill.type === "solid" ? (
          <VarColorCell value={fill.color ?? "#000000"} onChange={(c) => onChange({ ...fill, color: c })} doc={doc} onCreateVariable={onCreateVar} />
        ) : fill.type === "image" ? (
          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: fill.src ? "var(--muted-foreground)" : "var(--destructive)" }}>
            {fill.src || "未设置图片路径"}
          </span>
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
      {open && (fill.type === "linear" || fill.type === "radial") && (
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
      {open && fill.type === "image" && (
        <div className="ml-4 mt-1 space-y-1.5 rounded-lg p-2" style={{ background: "var(--secondary)" }}>
          <MiniSelect
            value={fill.scaleMode ?? "fill"}
            options={[
              { value: "fill", label: "裁剪铺满（fill）" },
              { value: "fit", label: "完整显示（fit）" },
              { value: "stretch", label: "拉伸（stretch）" },
            ]}
            onChange={(v) => onChange({ ...fill, scaleMode: v as Fill["scaleMode"] })}
            title="图片缩放方式"
          />
          <input
            value={fill.src ?? ""}
            onChange={(e) => onChange({ ...fill, src: e.target.value })}
            placeholder="workspace 相对路径（如 my-design-assets/pic.png）"
            className="h-7 w-full rounded-md px-2 text-[11px] outline-none"
            style={{ background: "var(--popover)", color: "var(--foreground)" }}
          />
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
  doc: DesignDoc;
  onCreateVar: (value: string) => string;
  onChange: (s: Stroke) => void;
  onRemove: () => void;
  onToggle: () => void;
}> = ({ stroke, doc, onCreateVar, onChange, onRemove, onToggle }) => {
  const hidden = stroke.visible === false;
  return (
    <div className="group flex h-7 items-center gap-1.5" style={{ opacity: hidden ? 0.45 : 1 }}>
      <VarColorCell compact value={stroke.color} onChange={(c) => onChange({ ...stroke, color: c })} doc={doc} onCreateVariable={onCreateVar} />
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
  const { doc, page, selIds, updateNode, align, reflow, setLayout, setSel, detachInstance, resetInstanceOverrides } = store;
  /** 填充/描边/文字/图标行的「存为变量并绑定」：名字由 upsertVariable 自动去重（颜色/颜色 2/…） */
  const onCreateVar = (value: string): string => store.upsertVariable({ name: "颜色", value });
  const loc = selIds.length === 1 ? findNode(doc, selIds[0]!) : null;
  const node = loc?.node ?? null;
  const [cornersOpen, setCornersOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeLang, setCodeLang] = useState<CodeLang>("css");

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

      {/* 实例内部选中：回实例根 + 提示编辑会存为覆盖 */}
      {selIds[0]!.includes("/") && (
        <div className="flex items-center gap-1.5 px-3 pb-1 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          <span className="min-w-0 flex-1 truncate">实例内部 · 编辑将保存为覆盖</span>
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-[var(--secondary)]"
            style={{ color: "var(--foreground)" }}
            onClick={() => setSel([selIds[0]!.slice(0, selIds[0]!.indexOf("/"))])}
          >
            回到实例
          </button>
        </div>
      )}

      {/* 实例：主档信息与操作 */}
      {n.type === "instance" && (
        <Section title="实例">
          {(() => {
            const inst = n as DesignNode & { componentId: string; overrides?: Record<string, unknown> };
            const comp = findComponent(doc, inst.componentId);
            const ovCount = Object.keys(inst.overrides ?? {}).length;
            return (
              <div className="space-y-1.5">
                <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  主档：
                  {comp ? (
                    <span style={{ color: "var(--foreground)" }}>{comp.name}</span>
                  ) : (
                    <span style={{ color: "var(--destructive)" }}>组件缺失（占位显示）</span>
                  )}
                </div>
                <div className="text-[11px]" style={{ color: ovCount ? "var(--foreground)" : "var(--muted-foreground)" }}>
                  {ovCount ? `已覆盖 ${ovCount} 处` : "与主档完全一致"}
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-[11px] hover:opacity-80"
                    style={{ background: "var(--secondary)", color: "var(--foreground)" }}
                    title="把实例烘焙成可自由编辑的普通图层（断开与主档的联动）"
                    onClick={() => detachInstance(n.id)}
                  >
                    分离实例
                  </button>
                  {ovCount > 0 && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-[11px] hover:opacity-80"
                      style={{ background: "var(--secondary)", color: "var(--foreground)" }}
                      title="清除全部覆盖，回到主档原样"
                      onClick={() => resetInstanceOverrides(n.id)}
                    >
                      重置覆盖
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </Section>
      )}

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
          <div className="flex items-center gap-1.5">
            <IconBtn tip="水平翻转" size={28} active={!!n.flipX} onClick={() => set({ flipX: !n.flipX } as Partial<DesignNode>)}>
              <FlipHorizontal2 size={14} />
            </IconBtn>
            <IconBtn tip="垂直翻转" size={28} active={!!n.flipY} onClick={() => set({ flipY: !n.flipY } as Partial<DesignNode>)}>
              <FlipVertical2 size={14} />
            </IconBtn>
            <div className="min-w-0 flex-1">
              <MiniSelect
                value={n.blendMode ?? "normal"}
                options={[
                  { value: "normal", label: "混合·正常" },
                  { value: "multiply", label: "正片叠底" },
                  { value: "screen", label: "滤色" },
                  { value: "overlay", label: "叠加" },
                  { value: "darken", label: "变暗" },
                  { value: "lighten", label: "变亮" },
                  { value: "color-dodge", label: "颜色减淡" },
                  { value: "color-burn", label: "颜色加深" },
                  { value: "hard-light", label: "强光" },
                  { value: "soft-light", label: "柔光" },
                  { value: "difference", label: "差值" },
                  { value: "exclusion", label: "排除" },
                  { value: "hue", label: "色相" },
                  { value: "saturation", label: "饱和度" },
                  { value: "color", label: "颜色" },
                  { value: "luminosity", label: "明度" },
                ]}
                onChange={(v) =>
                  updateNode(n.id, (m) => {
                    const c = { ...m } as DesignNode & { blendMode?: BlendMode };
                    if (v === "normal") delete c.blendMode;
                    else c.blendMode = v as BlendMode;
                    return c;
                  })
                }
                title="混合模式（与下层内容的混合方式，画布/导出一致）"
              />
            </div>
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
              <MiniSelect
                value={n.scroll ?? "none"}
                options={[
                  { value: "none", label: "不滚动" },
                  { value: "v", label: "竖向滚动" },
                  { value: "h", label: "横向滚动" },
                  { value: "both", label: "双向滚动" },
                ]}
                onChange={(v) =>
                  updateNode(n.id, (m) => {
                    const c = { ...m } as DesignNode & { scroll?: unknown };
                    if (v === "none") delete c.scroll;
                    else c.scroll = v;
                    return c;
                  })
                }
                title="滚动区域：内容超框时在原型预览与 HTML 导出里可滚动"
              />
            </div>
          )}
        </div>
      </Section>

      {/* 布局（画板）：Auto Layout 声明 + 立即重排 */}
      {n.type === "frame" && (
        <Section title="布局">
          <MiniSelect
            value={n.layout?.mode ?? "none"}
            options={[
              { value: "none", label: "无（自由摆放）" },
              { value: "h", label: "横向排列" },
              { value: "v", label: "纵向排列" },
            ]}
            onChange={(v) =>
              setLayout(
                n.id,
                v === "none" ? null : { mode: v as "h" | "v", ...(n.layout?.mode === v ? n.layout : {}) } as FrameLayout,
              )
            }
            title="自动布局：声明后子元素按间距/内边距/对齐自动排布"
          />
          {n.layout && (
            <>
              <div className="flex gap-1.5">
                <NumField
                  label="间距"
                  min={0}
                  max={2000}
                  value={n.layout.gap ?? 0}
                  onCommit={(v) => setLayout(n.id, { ...n.layout!, gap: v })}
                />
                <NumField
                  label="内边距"
                  min={0}
                  max={1000}
                  value={n.layout.padding?.[0] ?? 0}
                  onCommit={(v) => setLayout(n.id, { ...n.layout!, padding: [v, v, v, v] })}
                  title="四边统一内边距（逐边请用 MCP）"
                />
              </div>
              <div className="flex gap-1.5">
                <MiniSelect
                  value={n.layout.wrap ? "wrap" : "nowrap"}
                  options={[
                    { value: "nowrap", label: "不换行" },
                    { value: "wrap", label: "自动换行" },
                  ]}
                  onChange={(v) => setLayout(n.id, { ...n.layout!, wrap: v === "wrap" || undefined })}
                  title="放不下时自动折行（行距同间距）"
                />
                <MiniSelect
                  value={n.layout.hug ?? "fixed"}
                  options={[
                    { value: "fixed", label: "尺寸·固定" },
                    { value: "main", label: "随内容·主轴" },
                    { value: "cross", label: "随内容·交叉" },
                    { value: "both", label: "随内容·双轴" },
                  ]}
                  onChange={(v) =>
                    setLayout(n.id, { ...n.layout!, hug: (v === "fixed" ? undefined : (v as "main" | "cross" | "both")) || undefined })
                  }
                  title="HUG：画板尺寸随内容收缩（手动改尺寸会被重排覆盖）"
                />
              </div>
              <div className="flex gap-1.5">
                <MiniSelect
                  value={n.layout.main ?? "start"}
                  options={[
                    { value: "start", label: "主轴·居首" },
                    { value: "center", label: "主轴·居中" },
                    { value: "end", label: "主轴·居末" },
                    { value: "between", label: "主轴·两端" },
                  ]}
                  onChange={(v) => setLayout(n.id, { ...n.layout!, main: v as FrameLayout["main"] })}
                  title="主轴对齐"
                />
                <MiniSelect
                  value={n.layout.cross ?? "start"}
                  options={[
                    { value: "start", label: "交叉·居首" },
                    { value: "center", label: "交叉·居中" },
                    { value: "end", label: "交叉·居末" },
                    { value: "stretch", label: "交叉·拉满" },
                  ]}
                  onChange={(v) => setLayout(n.id, { ...n.layout!, cross: v as FrameLayout["cross"] })}
                  title="交叉轴对齐"
                />
              </div>
              <button
                type="button"
                onClick={() => reflow(n.id)}
                className="h-7 w-full rounded-md text-[11px] font-medium transition-colors hover:brightness-95"
                style={{ background: "var(--secondary)", color: "var(--foreground)" }}
              >
                重新排列（手动挪动过子项后）
              </button>
            </>
          )}
        </Section>
      )}

      {/* 布局子项：父画板开了自动布局时，当前节点可给弹性权重 */}
      {loc?.parent?.type === "frame" && loc.parent.layout && (
        <Section title="布局子项">
          <NumField
            label="弹性"
            min={0}
            max={100}
            value={n.grow ?? 0}
            onCommit={(v) => {
              set({ grow: v > 0 ? v : undefined } as Partial<DesignNode>);
              reflow(n.id);
            }}
            title="0 = 固定尺寸；>0 按权重瓜分主轴剩余空间"
          />
          <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            父画板「{loc.parent.name}」开了自动布局；手动挪位不会自动重排，可让父画板重新排列
          </div>
        </Section>
      )}

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

      {/* 蒙版：用本节点几何裁剪同容器上方兄弟（frame 自带裁剪，不在此列） */}
      {n && n.type !== "frame" && (
        <Section title="蒙版">
          <MiniSelect
            value={n.mask ? "on" : "off"}
            options={[
              { value: "off", label: "不用作蒙版" },
              { value: "on", label: "用作蒙版（裁剪上方图层）" },
            ]}
            onChange={(v) =>
              updateNode(n.id, (m) => {
                const c = { ...m } as DesignNode & { mask?: unknown };
                if (v === "on") c.mask = true;
                else delete c.mask;
                return c;
              })
            }
            title="蒙版：自身不再绘制，用几何裁剪同容器中位于其上方的图层（和 Figma 一致）"
          />
          {n.mask && (
            <div className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
              已作为蒙版：画布上只见其裁剪作用，导出同样生效
            </div>
          )}
        </Section>
      )}

      {/* 代码（Dev Mode） */}
      <Section title="代码">
        <div className="flex items-center gap-1.5">
          <MiniSelect
            value={codeLang}
            options={[
              { value: "css", label: "CSS" },
              { value: "swiftui", label: "SwiftUI" },
              { value: "compose", label: "Compose" },
            ]}
            onChange={(v) => setCodeLang(v as CodeLang)}
            title="目标平台代码"
          />
          <button
            type="button"
            onClick={() => void copyText(nodeToCode(n, codeLang, doc)).then(() => setCopied(true))}
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11px] font-medium transition-colors hover:brightness-95"
            style={{ background: "var(--secondary)", color: "var(--foreground)" }}
          >
            {copied ? "已复制 ✓" : "复制代码"}
          </button>
        </div>
        <pre
          className="mt-1.5 max-h-44 overflow-auto rounded-lg p-2 text-[10px] leading-4"
          style={{ background: "var(--secondary)", color: "var(--foreground)" }}
        >
          {nodeToCode(n, codeLang, doc)}
        </pre>
      </Section>

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
                doc={doc}
                onCreateVar={onCreateVar}
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
                doc={doc}
                onCreateVar={onCreateVar}
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
              <VarColorCell value={text.runs[0]?.color ?? "#111111"} onChange={(c) => updateNode(n.id, (m) => (m.type === "text" ? ({ ...m, runs: m.runs.map((r) => ({ ...r, color: c })) } as DesignNode) : m))} doc={doc} onCreateVariable={onCreateVar} />
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

      {/* 图标 */}
      {n.type === "icon" && (
        <Section title="图标">
          <IconPicker value={n.icon} onPick={(name) => updateNode(n.id, { icon: name } as Partial<DesignNode>)} />
          <div className="mt-1.5 flex items-center gap-1.5">
            <VarColorCell value={n.color ?? "#111111"} onChange={(c) => updateNode(n.id, { color: c } as Partial<DesignNode>)} doc={doc} onCreateVariable={onCreateVar} />
            <NumField
              label="粗细"
              min={0.5}
              max={12}
              step={0.5}
              value={n.strokeWidth ?? 2}
              onCommit={(v) => updateNode(n.id, { strokeWidth: v } as Partial<DesignNode>)}
            />
          </div>
          {!resolveIconName(n.icon) && (
            <div className="mt-1 text-[11px]" style={{ color: "var(--destructive)" }}>
              图标名无效，画布上是占位：点上方重新选择
            </div>
          )}
        </Section>
      )}

      {/* 原型交互：多触发器 × 多动作（编辑在独立组件里，Inspector 只装配） */}
      <InteractionEditor store={store} node={n} onPreview={onPreview} />

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
              void copyText(nodeToCss(n, doc)).then((ok) => {
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
          {nodeToCss(n, doc)}
        </pre>
      </Section>
    </div>
  );
};
