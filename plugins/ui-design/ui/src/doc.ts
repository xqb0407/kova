/**
 * DesignDoc v1 数据模型（schema 的权威文档在 skills/ui-design/SKILL.md，agent 据此读写）。
 *
 * Figma 式文档树：文档 = 页面（pages）→ 图层树（nodes）。节点坐标一律是
 * **父容器局部坐标**（页面级 = 画布绝对坐标；frame/group 子节点 = 相对框左上角），
 * 这与 canvas 的 CanvasDoc（objects 绝对 + frames 页框双容器、画板只是矩形）
 * 是两种模型——本面板是独立的设计引擎，不共用无限画布文档。
 *
 * 解析入口 parseDesignDoc 对任意 JSON 容错：能救的救（缺省/弱类型转换/钳制），
 * 救不了的丢弃该节点——面板永不白屏，agent 写坏也只丢局部。
 * id 全局唯一由 normalize 兜底补齐；group 的包围盒由子节点并集派生（见 geometry.ts）。
 */

export const DOC_VERSION = 1;

import { fixJsonText } from "./jsonfix";
import { DEFAULT_ICON, resolveIconName } from "./icons";

/* ---------------- 通用类型 ---------------- */

export type FillType = "solid" | "linear" | "radial" | "image";

export type GradientStop = { at: number; color: string };

export type Fill = {
  type: FillType;
  /** 缺省 true；false = 隐藏但保留（Figma 的眼睛） */
  visible?: boolean;
  /** solid：#rgb/#rrggbb/#rrggbbaa */
  color?: string;
  /** 0..1（缺省 1），乘在该 fill 的颜色上 */
  opacity?: number;
  /** image：workspace 相对路径（与 image 节点 src 同口径） */
  src?: string;
  /** image 缩放口径：fill=裁剪铺满（缺省）/fit=完整显示/stretch=拉伸 */
  scaleMode?: "fill" | "fit" | "stretch";
  /** 渐变色标（at 升序归一，2–8 个） */
  stops?: GradientStop[];
  /** 线性渐变角（度，顺时针；0 = 自上而下） */
  angle?: number;
  /** 径向圆心（0..1 局部比例，缺省 0.5/0.5） */
  center?: { x: number; y: number };
};

export type StrokeAlign = "inside" | "center" | "outside";
export type StrokeStyle = "solid" | "dashed" | "dotted";

export type Stroke = {
  color: string;
  width: number;
  align?: StrokeAlign; // 缺省 center
  style?: StrokeStyle; // 缺省 solid
  visible?: boolean; // 缺省 true
};

export type Effect =
  | { type: "drop-shadow"; visible?: boolean; color: string; x: number; y: number; blur: number }
  | { type: "inner-shadow"; visible?: boolean; color: string; x: number; y: number; blur: number }
  | { type: "layer-blur"; visible?: boolean; blur: number };

export type TextRun = {
  text: string;
  color?: string;
  size?: number;
  /** CSS 字重（400 常规 / 500 中等 / 600 半粗 / 700 粗体） */
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  font?: string; // 字体族（缺省跟随界面字体）
};

export type NodeType =
  | "frame"
  | "group"
  | "rect"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "star"
  | "line"
  | "arrow"
  | "text"
  | "image"
  | "icon"
  | "vector"
  | "instance";

export const SHAPE_TYPES: readonly NodeType[] = [
  "rect",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "star",
];
export const LINE_TYPES: readonly NodeType[] = ["line", "arrow"];

/** line/arrow 走向（bbox 局部）：0=↘（缺省）1=↗ 2=↖ 3=↙（同 CanvasDoc 对角语义） */
export type LineDir = 0 | 1 | 2 | 3;

/* ---------------- 原型交互（多触发器 + 多动作 + 转场） ---------------- */

/** 触发方式：单击 / 双击 / 长按 / 四向滑动（移动端原型的全部常用手势） */
export type InteractionTrigger =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "swipeLeft"
  | "swipeRight"
  | "swipeUp"
  | "swipeDown";

export const INTERACTION_TRIGGERS: readonly InteractionTrigger[] = [
  "tap", "doubleTap", "longPress", "swipeLeft", "swipeRight", "swipeUp", "swipeDown",
];

/**
 * 动作：跳转 / 返回 / 打开浮层 / 关闭浮层 / 滚动到 / 显隐。
 * navigate 与 overlay 的 `to` 指向**顶层画板**；scrollTo 指向本屏内节点；toggleVisible 指向本屏内节点。
 */
export type InteractionAction =
  | "navigate"
  | "back"
  | "overlay"
  | "closeOverlay"
  | "scrollTo"
  | "toggleVisible";

export const INTERACTION_ACTIONS: readonly InteractionAction[] = [
  "navigate", "back", "overlay", "closeOverlay", "scrollTo", "toggleVisible",
];

/** 转场动画：无 / 四向推入 / 淡入 / 缩放（弹窗）/ 上下滑入（抽屉） */
export type PrototypeTransition =
  | "none"
  | "pushLeft"
  | "pushRight"
  | "pushUp"
  | "pushDown"
  | "fade"
  | "scale"
  | "slideUp"
  | "slideDown";

export const PROTOTYPE_TRANSITIONS: readonly PrototypeTransition[] = [
  "none", "pushLeft", "pushRight", "pushUp", "pushDown", "fade", "scale", "slideUp", "slideDown",
];

/** 浮层停靠位：决定缺省转场与贴边对齐 */
export type OverlayPosition = "center" | "top" | "bottom" | "left" | "right";
export const OVERLAY_POSITIONS: readonly OverlayPosition[] = ["center", "top", "bottom", "left", "right"];

/**
 * 一条原型交互。触发器挂在节点上；同名触发器可挂多条（按数组序命中第一条）。
 * 缺省值策略（`protoDefaults`）保证「只写 trigger + action + to」也有像样的动画，
 * 显式写 `"transition": "none"` 可关。
 */
export type Interaction = {
  trigger: InteractionTrigger;
  action: InteractionAction;
  /** 目标 id：navigate/overlay = 顶层画板 id；scrollTo/toggleVisible = 本屏内节点 id */
  to?: string;
  /** overlay 停靠位，缺省 center */
  position?: OverlayPosition;
  /** 转场动画，缺省按 动作 + 停靠位 推导 */
  transition?: PrototypeTransition;
  /** 转场时长 ms（40..2000），缺省按转场类型 */
  duration?: number;
  /** overlay：点击遮罩关闭，缺省 true */
  dismissOnTapOutside?: boolean;
};

/** 滚动区域轴：v 纵向 / h 横向 / both 双向（FrameNode.scroll） */
export type ScrollAxis = "v" | "h" | "both";
export const SCROLL_AXES: readonly ScrollAxis[] = ["v", "h", "both"];

/** 宽松归一：大小写/空格/下划线/连字符容错（AI 常写 double_tap / Swipe-Left） */
function looseKey(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

const TRIGGER_ALIASES: Record<string, InteractionTrigger> = {
  tap: "tap", click: "tap", touch: "tap", press: "tap", onclick: "tap",
  doubletap: "doubleTap", dbltap: "doubleTap", doubleclick: "doubleTap", dbclick: "doubleTap",
  longpress: "longPress", longclick: "longPress", hold: "longPress", presshold: "longPress",
  swipeleft: "swipeLeft", left: "swipeLeft",
  swiperight: "swipeRight", right: "swipeRight",
  swipeup: "swipeUp", up: "swipeUp",
  swipedown: "swipeDown", down: "swipeDown",
};

export function normalizeTrigger(raw: unknown): InteractionTrigger | undefined {
  return TRIGGER_ALIASES[looseKey(raw)];
}

const ACTION_ALIASES: Record<string, InteractionAction> = {
  navigate: "navigate", jump: "navigate", goto: "navigate", link: "navigate", open: "navigate", navigateto: "navigate",
  back: "back", prev: "back", previous: "back", return: "back", goback: "back",
  overlay: "overlay", popup: "overlay", modal: "overlay", dialog: "overlay", sheet: "overlay", showoverlay: "overlay",
  closeoverlay: "closeOverlay", close: "closeOverlay", closepopup: "closeOverlay", dismiss: "closeOverlay", hideoverlay: "closeOverlay",
  scrollto: "scrollTo", scroll: "scrollTo",
  togglevisible: "toggleVisible", toggle: "toggleVisible", showhide: "toggleVisible", visibility: "toggleVisible",
};

export function normalizeAction(raw: unknown): InteractionAction | undefined {
  return ACTION_ALIASES[looseKey(raw)];
}

const TRANSITION_ALIASES: Record<string, PrototypeTransition> = {
  none: "none", no: "none", instant: "none", off: "none",
  pushleft: "pushLeft", slideleft: "pushLeft", left: "pushLeft",
  pushright: "pushRight", slideright: "pushRight", right: "pushRight",
  pushup: "pushUp", slideup: "slideUp", up: "pushUp",
  pushdown: "pushDown", slidedown: "slideDown", down: "pushDown",
  fade: "fade", fadein: "fade", dissolve: "fade",
  scale: "scale", zoom: "scale", pop: "scale",
};

export function normalizeTransition(raw: unknown): PrototypeTransition | undefined {
  return TRANSITION_ALIASES[looseKey(raw)];
}

const OVERLAY_ALIASES: Record<string, OverlayPosition> = {
  center: "center", middle: "center", centre: "center",
  top: "top", above: "top",
  bottom: "bottom", below: "bottom", sheet: "bottom",
  left: "left", right: "right",
};

export function normalizeOverlayPosition(raw: unknown): OverlayPosition | undefined {
  return OVERLAY_ALIASES[looseKey(raw)];
}

export function normalizeScrollAxis(raw: unknown): ScrollAxis | undefined {
  if (raw === true) return "v";
  const k = looseKey(raw);
  if (!k) return undefined;
  if (k === "v" || k === "vertical" || k === "y" || k === "column") return "v";
  if (k === "h" || k === "horizontal" || k === "x" || k === "row") return "h";
  if (k === "both" || k === "all" || k === "xy" || k === "vh" || k === "hv") return "both";
  return undefined;
}

/**
 * 单条交互容错解析：trigger 与 action 都认得出才算数（写错宁可丢掉并由 lint/警告报，不猜）。
 * `to` 允许省略（back / closeOverlay 无目标）。
 */
function parseInteraction(raw: unknown): Interaction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const trigger = normalizeTrigger(pick(o, "trigger", "on", "when", "event"));
  const action = normalizeAction(pick(o, "action", "do", "type", "behavior"));
  if (!trigger || !action) return null;
  const it: Interaction = { trigger, action };
  const to = str(pick(o, "to", "target", "destination", "dest", "frame", "page"));
  if (to) it.to = to.trim().slice(0, 120);
  const pos = normalizeOverlayPosition(pick(o, "position", "placement", "anchor"));
  if (pos) it.position = pos;
  const tr = normalizeTransition(pick(o, "transition", "animation", "anim", "effect"));
  if (tr) it.transition = tr;
  const durRaw = pick(o, "duration", "speed");
  if (typeof durRaw === "number" && Number.isFinite(durRaw) && durRaw > 0) {
    it.duration = clamp(Math.round(durRaw), 40, 2000);
  }
  if (o.dismissOnTapOutside === false || o.dismissOnTapOutside === "false") it.dismissOnTapOutside = false;
  return it;
}

function parseInteractions(raw: unknown): Interaction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Interaction[] = [];
  for (const item of raw.slice(0, 24)) {
    const it = parseInteraction(item);
    if (it) out.push(it);
  }
  return out.length ? out : undefined;
}

/**
 * 节点的有效交互表：interactions 优先；缺省把旧式 onTap 折算成一条单击跳转
 * （旧档不迁移也能在预览/导出/体检里按同一口径处理）。
 */
export function nodeInteractions(n: DesignNode): Interaction[] {
  if (n.interactions && n.interactions.length) return n.interactions;
  if (n.onTap?.to) return [{ trigger: "tap", action: "navigate", to: n.onTap.to }];
  return [];
}

/** 节点是否带任何原型交互（画布角标 / 体检用） */
export function hasInteraction(n: DesignNode): boolean {
  return !!(n.interactions?.length || n.onTap?.to);
}

type NodeBase = {
  id: string;
  name: string;
  /** 父容器局部坐标；页面级 = 画布绝对坐标；rotation 绕盒中心 */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number; // 度
  opacity?: number; // 0..1 缺省 1
  visible?: boolean; // 缺省 true
  locked?: boolean; // 缺省 false
  /** 圆角：统一值或 [tl,tr,br,bl]；0..4096 */
  radius?: number | [number, number, number, number];
  effects?: Effect[];
  /** 原型交互（多触发器 + 多动作 + 转场）。见 Interaction；旧式 onTap 仍支持 */
  interactions?: Interaction[];
  /** 旧式单击跳转：等价于 interactions 里一条 { trigger:"tap", action:"navigate", to }。新稿写 interactions */
  onTap?: { to: string };
  /** 蒙版：用本节点几何裁剪同容器内位于其上方的兄弟（Figma 语义；自身不绘制内容） */
  mask?: boolean;
  /** 弹性布局权重（父画板开了布局时生效）：0 = 固定尺寸，>0 按权重瓜分主轴剩余空间 */
  grow?: number;
  /** 混合模式（缺省 normal 不落字段；与 CSS/leafer 同名 kebab-case） */
  blendMode?: BlendMode;
  /** 水平/垂直镜像（缺省 false；渲染时绕盒中心翻转，画布与导出一致） */
  flipX?: boolean;
  flipY?: boolean;
};

/** 混合模式全集（normal 为缺省不落字段） */
export type BlendMode =
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

const BLEND_MODES: readonly BlendMode[] = [
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

/** 混合模式宽松归一：大小写/空格/下划线容错，normal/passthrough → undefined（缺省） */
export function normalizeBlendMode(raw: unknown): BlendMode | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key || key === "normal" || key === "pass-through" || key === "passthrough" || key === "src-over") return undefined;
  return (BLEND_MODES as readonly string[]).includes(key) ? (key as BlendMode) : undefined;
}

/** 画板自动布局（确定性重排：结果写入子节点 x/y，grow 子项写主轴尺寸；不支持 wrap/HUG） */
export type LayoutMode = "h" | "v";
export type MainAlign = "start" | "center" | "end" | "between";
export type CrossAlign = "start" | "center" | "end" | "stretch";
export type FrameLayout = {
  mode: LayoutMode;
  /** 子项间距，0..2000，缺省 0（wrap 时同作行距/列距） */
  gap?: number;
  /** 内边距 [上, 右, 下, 左]，0..1000，缺省全 0 */
  padding?: [number, number, number, number];
  /** 主轴对齐，缺省 start；between = 首尾贴边等分空隙 */
  main?: MainAlign;
  /** 交叉轴对齐，缺省 start；stretch = 子项交叉轴拉满内容区 */
  cross?: CrossAlign;
  /** 自动换行（横向 = 按行折，纵向 = 按列折）；开 wrap 时 hug 主轴失效（换行需要固定主轴宽度） */
  wrap?: boolean;
  /** 随内容收缩：主轴/交叉轴/双轴（重排后 frame 尺寸 = 内容 + gap + padding）；缺省固定 */
  hug?: "main" | "cross" | "both";
};

/** 纯几何盒形状判别子集（区别于 NodeType 全集，供联合类型可辨识收窄用） */
export type BoxShapeType = "rect" | "ellipse" | "triangle" | "diamond" | "pentagon" | "hexagon" | "star";

export type ShapeNode = NodeBase & {
  type: BoxShapeType;
  fills: Fill[];
  strokes: Stroke[];
  /** 内嵌文字（Figma/Sketch 的 layer text）：画在形状自身盒内，随形状移动/删除/成组 */
  text?: LayerText;
};
export type LineNode = NodeBase & {
  type: "line" | "arrow";
  dir?: LineDir;
  strokes: Stroke[];
};
/**
 * 形状内嵌文字：典型用途是按钮、标签、徽标——「双击矩形直接打字」，不必另起一个
 * text 节点再对齐进去。缺省水平 + 垂直居中（与 text 节点缺省左上不同，因为它是
 * 「形状里的内容」而不是「一块文字」）。文字色在 runs[].color 上，与形状 fills 无关。
 */
export type LayerText = {
  runs: TextRun[];
  align?: "left" | "center" | "right"; // 缺省 center
  vAlign?: "top" | "middle" | "bottom"; // 缺省 middle
  lineHeight?: number; // 倍数，缺省 1.4
  letterSpacing?: number; // px，缺省 0
};
export type TextNode = NodeBase & {
  type: "text";
  runs: TextRun[];
  align?: "left" | "center" | "right"; // 缺省 left
  vAlign?: "top" | "middle" | "bottom"; // 缺省 top
  lineHeight?: number; // 倍数，缺省 1.4
  letterSpacing?: number; // px，缺省 0
};
export type ImageNode = NodeBase & {
  type: "image";
  src: string; // workspace 相对路径（通常在 <档名>-assets/ 下）
  fit?: "cover" | "contain" | "stretch"; // 缺省 cover
  strokes?: Stroke[];
};
/** 自由矢量路径（布尔运算/后续钢笔的产物）：path 为节点局部坐标的 SVG d 串 */
export type VectorNode = NodeBase & {
  type: "vector";
  /** SVG path d（局部坐标；支持全部命令，布尔产物为全直线段） */
  path: string;
  fills: Fill[];
  strokes: Stroke[];
};

/** 内置 lucide 图标（24 栅格描边矢量，渲染按盒缩放；名称见 list_icons / icons/data.ts） */
export type IconNode = NodeBase & {
  type: "icon";
  /** lucide 图标名（kebab-case，如 "home" / "shopping-cart"） */
  icon: string;
  /** 描边色（缺省 #111111） */
  color?: string;
  /** 描边宽（缺省 2；24 栅格单位，随盒等比放大） */
  strokeWidth?: number;
};
export type GroupNode = NodeBase & {
  type: "group";
  /** 子节点坐标相对组包围盒左上角；组自身 x/y/w/h 由子节点并集派生 */
  children: DesignNode[];
};
export type FrameNode = NodeBase & {
  type: "frame";
  children: DesignNode[];
  /** frame 的底色走 fills（Figma 语义） */
  fills: Fill[];
  strokes?: Stroke[];
  /** 缺省 true：内容超框裁切（约定只写 clip:false，序列化幂等） */
  clip?: boolean;
  /** 设备预设键（仅记录来源；几何改动不重置） */
  preset?: string;
  /** 自动布局：声明后子节点由重排引擎接管排布（ui/src/layout.ts） */
  layout?: FrameLayout;
  /**
   * 滚动区域：声明后本画板是一个可滚动视口（内容超框部分在原型预览 / HTML 导出里可滚动查看）。
   * 画布、PNG/SVG 导出、MCP 截图按 offset 0 的静态一屏呈现（三端一致），滚动只在可交互端存在。
   * 隐式开启裁切（clip 语义）。
   */
  scroll?: ScrollAxis;
};

/**
 * 组件主档（Figma Component）：存于 doc.components 资产表、不占页面节点树；
 * nodes = 模板子树（通常单根 frame）。主档任何改动实时反映到全部实例（渲染期解析）。
 */
export type ComponentDef = {
  id: string;
  name: string;
  nodes: DesignNode[];
};

/**
 * 共享颜色变量（设计 token，Figma Variables 的颜色子集）：存于 doc.variables 资产表。
 * 任何 colorOr 口径的颜色字段（填充/描边/渐变色标/文字/图标/效果）都可写引用串 "var:<id>"，
 * 画布/导出/CSS 三端在渲染期解析——改 value 全稿联动（同组件主档的 live 口径）。
 * value 允许再引用别的变量（链式解析 ≤4 层防环；坏引用渲染为警示粉）。
 */
export type VariableDef = {
  id: string;
  name: string;
  value: string;
  desc?: string;
};

/**
 * 组件实例：引用主档 + 局部覆盖。
 * - 几何（x/y/w/h/rotation/opacity…）在实例自身；w/h 与主档包围盒之比 = 等比缩放。
 * - overrides 按「主档内部节点 id」记录覆盖补丁（文本/填充/显隐等浅字段整体替换）。
 * - 渲染期从主档 live 解析（改主档 → 实例自动更新）；detach 后变普通节点子树。
 */
export type InstanceNode = NodeBase & {
  type: "instance";
  /** 主档 id（坏引用渲染为占位框） */
  componentId: string;
  /** 内部节点覆盖：key = 主档树内节点 id（含其子孙） */
  overrides?: Record<string, Record<string, unknown>>;
};

export type DesignNode = GroupNode | FrameNode | TextNode | ImageNode | LineNode | ShapeNode | IconNode | VectorNode | InstanceNode;

export type Page = { id: string; name: string; nodes: DesignNode[] };

export type DesignDoc = {
  version: number;
  meta: { name: string; kind: "uidesign" };
  activePage: string;
  pages: Page[];
  /** 组件资产表（不占页面；实例经 componentId 引用） */
  components?: ComponentDef[];
  /** 共享颜色变量表（色值字段用 "var:<id>" 引用，渲染期解析） */
  variables?: VariableDef[];
};

/* ---------------- 设备预设 ---------------- */

export type DevicePreset = { w: number; h: number; label: string; group: string };

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  "ios-375": { w: 375, h: 812, label: "iOS · 375×812", group: "手机" },
  "ios-390": { w: 390, h: 844, label: "iOS · 390×844", group: "手机" },
  "android-360": { w: 360, h: 800, label: "Android · 360×800", group: "手机" },
  "tablet-768": { w: 768, h: 1024, label: "平板 · 768×1024", group: "平板" },
  "desktop-1440": { w: 1440, h: 900, label: "桌面 · 1440×900", group: "桌面" },
  "watch-168": { w: 168, h: 184, label: "手表 · 168×184", group: "其他" },
};
export const DEVICE_ORDER = Object.keys(DEVICE_PRESETS);

/* ---------------- 构造 ---------------- */

let uidCounter = 0;
export function uid(prefix = "n"): string {
  uidCounter = (uidCounter + 1) % 0xffffff;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

export const solid = (color: string, opacity = 1): Fill =>
  opacity < 1 ? { type: "solid", color, opacity } : { type: "solid", color };

export function blankDoc(name = "UI 设计"): DesignDoc {
  const pageId = uid("p");
  return {
    version: DOC_VERSION,
    meta: { name, kind: "uidesign" },
    activePage: pageId,
    pages: [{ id: pageId, name: "页面 1", nodes: [] }],
  };
}

export function newFrame(opts: {
  name?: string;
  w: number;
  h: number;
  x?: number;
  y?: number;
  preset?: string;
  background?: string;
}): FrameNode {
  return {
    id: uid("f"),
    type: "frame",
    name: opts.name ?? opts.preset ?? "画板",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: clamp(opts.w, 1, 20000),
    h: clamp(opts.h, 1, 20000),
    fills: [solid(opts.background ?? "#ffffff")],
    ...(opts.preset ? { preset: opts.preset } : {}),
    children: [],
  };
}

/** 起始档：三块设备画板横排（首页 / 关键流程 / 详情），进面板即可开画 */
export function starterDoc(name: string, presetKey: string): DesignDoc {
  const doc = blankDoc(name);
  const p = DEVICE_PRESETS[presetKey] ?? DEVICE_PRESETS["ios-375"];
  const titles = ["首页", "关键流程", "详情"];
  const gap = Math.max(80, Math.round(p.w * 0.32));
  doc.pages[0]!.nodes = titles.map((t, i) =>
    newFrame({ name: t, w: p.w, h: p.h, x: i * (p.w + gap), preset: presetKey }),
  );
  return doc;
}

/** 各节点类型的默认样式工厂（新建元素/agent 范例共用） */
export function newNode(type: NodeType, box: { x: number; y: number; w: number; h: number }, name?: string): DesignNode {
  const base = { id: uid(type[0]!), name: name ?? TYPE_LABELS[type] ?? type, ...box };
  switch (type) {
    case "text":
      return { ...base, type: "text", runs: [{ text: "文本", size: 16, color: "#111111" }] };
    case "image":
      return { ...base, type: "image", src: "" };
    case "frame":
      return { ...base, type: "frame", fills: [solid("#ffffff")], children: [] };
    case "group":
      return { ...base, type: "group", children: [] };
    case "line":
    case "arrow":
      return { ...base, type, strokes: [{ color: "#111111", width: 2 }] };
    case "icon":
      return { ...base, type: "icon", icon: name && resolveIconName(name) ? (resolveIconName(name) as string) : DEFAULT_ICON, color: "#111111", strokeWidth: 2 };
    case "vector":
      return { ...base, type: "vector", path: "M0 0L100 0L50 100Z", fills: [solid("#d9d9d9")], strokes: [] };
    case "instance":
      // componentId 由调用方（state 动作 / MCP）回填；空引用渲染为占位框
      return { ...base, type: "instance", componentId: "" };
    default:
      return { ...base, type: type as BoxShapeType, fills: [solid("#d9d9d9")], strokes: [] };
  }
}

export const TYPE_LABELS: Partial<Record<NodeType, string>> = {
  frame: "画板",
  group: "组",
  rect: "矩形",
  ellipse: "椭圆",
  triangle: "三角形",
  diamond: "菱形",
  pentagon: "五边形",
  hexagon: "六边形",
  star: "星形",
  line: "直线",
  icon: "图标",
  vector: "矢量",
  arrow: "箭头",
  text: "文本",
  image: "图片",
  instance: "实例",
};

/** 该类型是否带填充盒（检视器分区显隐的依据之一） */
export const HAS_FILL_BOX: Record<NodeType, boolean> = {
  frame: true,
  rect: true,
  ellipse: true,
  triangle: true,
  diamond: true,
  pentagon: true,
  hexagon: true,
  star: true,
  group: false,
  line: false,
  arrow: false,
  text: false,
  image: false,
  icon: false,
  vector: true,
  // 实例的填充来自主档根节点，自身不画盒
  instance: false,
};

/* ---------------- 树工具 ---------------- */

/** 深度优先（父在子前）遍历；跳过 visible=false 由调用方自理 */
export function* walkNodes(nodes: DesignNode[]): Generator<DesignNode> {
  for (const n of nodes) {
    yield n;
    if ("children" in n) yield* walkNodes(n.children);
  }
}

export function* walkPages(doc: DesignDoc): Generator<Page> {
  yield* doc.pages;
}

/** 全树遍历（含所有页面），附所属页 id */
export function* walkDoc(doc: DesignDoc): Generator<{ pageId: string; node: DesignNode }> {
  for (const page of doc.pages) for (const node of walkNodes(page.nodes)) yield { pageId: page.id, node };
}

export type NodeLocation = {
  node: DesignNode;
  /** 所在子数组引用（改动直接 map/splice 它） */
  siblings: DesignNode[];
  index: number;
  /** 父节点（页面级为 null） */
  parent: DesignNode | null;
  pageId: string;
};

/** 按 id 定位（含跨页查找——id 全局唯一由 normalize 保证）。
 *  斜杠寻址 "实例id/内部id[/更深…]"：定位到实例内部节点的**有效视图**（主档+覆盖，
 *  主档坐标）；siblings/index 为空（覆盖不是树位置），parent=顶层实例节点。 */
export function findNode(doc: DesignDoc, id: string): NodeLocation | null {
  const s = id.indexOf("/");
  if (s > 0) {
    const owner = findNode(doc, id.slice(0, s));
    if (!owner || owner.node.type !== "instance") return null;
    const segs = id.slice(s + 1).split("/").filter(Boolean).slice(0, 8);
    if (!segs.length) return null;
    // 视图 id 即寻址 id（instanceView 已把前缀编进 id），逐级累加精确匹配。
    // parent 挂「视图内真实容器」而非一律顶层实例：worldCornersOf 沿 parent 链复合
    // 世界坐标，扁平父会让主档第二层及更深的内部节点坐标错位（漏掉中间 frame/group 偏移）。
    let view: DesignNode[] | null = instanceView(doc, owner.node);
    let viewOwner: DesignNode = owner.node; // 当前视图的根节点在文档里直接挂在它下面
    let cur: DesignNode | null = null;
    let curParent: DesignNode = owner.node;
    let acc = owner.node.id;
    for (const seg of segs) {
      if (!view) return null;
      acc = `${acc}/${seg}`;
      const found = findDeepNodeWithParent(view, acc, null);
      if (!found) return null;
      cur = found.node;
      curParent = found.parent ?? viewOwner;
      if (cur.type === "instance") {
        view = instanceView(doc, cur);
        viewOwner = cur;
      } else if ("children" in cur) {
        view = cur.children;
        viewOwner = cur;
      } else view = null;
    }
    if (!cur) return null;
    return { node: cur, siblings: [], index: -1, parent: curParent, pageId: owner.pageId };
  }
  for (const page of doc.pages) {
    const loc = findInList(page.nodes, id, page.id, null);
    if (loc) return loc;
  }
  return null;
}

function findInList(list: DesignNode[], id: string, pageId: string, parent: DesignNode | null): NodeLocation | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.id === id) return { node: n, siblings: list, index: i, parent, pageId };
    if ("children" in n) {
      const hit = findInList(n.children, id, pageId, n);
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------------- 组件解析（渲染/命中/检视/导出口径共用） ----------------
 * 寻址约定：实例内部节点 id = "实例id/内部id"（id 在主档内唯一，直接挂前缀寻址；
 * 穿嵌套实例 = "实例id/内层实例id/内部id"）。
 * 唯一权威视图 = instanceView：主档+覆盖烘焙到实例局部坐标（含缩放与字号均比缩放）、
 * id 已重编——场景/命中/检视器/findNode 全走它；写回（patchInstancePath）用视图坐标，
 * 存进覆盖表前逆烘焙回主档坐标（存储永远是主档口径，改主档不受实例缩放污染）。
 */

/** 覆盖不许改的结构字段（拓扑由主档定，覆盖只改样式/几何/文案） */
const OVERRIDE_FORBIDDEN = new Set(["id", "type", "children", "componentId", "overrides"]);

function sanitizePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!OVERRIDE_FORBIDDEN.has(k) && v !== undefined) out[k] = v;
  return out;
}

export function findComponent(doc: DesignDoc, id: string): ComponentDef | null {
  for (const c of doc.components ?? []) if (c.id === id) return c;
  return null;
}

/** 主档包围盒：根节点盒并集（主档通常单根 frame；多根取外包） */
export function componentBounds(comp: ComponentDef): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of comp.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 实例引用主档的包围盒（坏/空引用 → null） */
export function resolveInstanceBounds(doc: DesignDoc, inst: InstanceNode): { x: number; y: number; w: number; h: number } | null {
  const comp = findComponent(doc, inst.componentId);
  if (!comp || !comp.nodes.length) return null;
  return componentBounds(comp);
}

/** 实例内容缩放系数：w/h 与主档包围盒之比（坏引用或零尺寸 → 1:1） */
export function instanceScale(doc: DesignDoc, inst: InstanceNode): { kx: number; ky: number } {
  const b = resolveInstanceBounds(doc, inst);
  if (!b || b.w <= 0 || b.h <= 0 || inst.w <= 0 || inst.h <= 0) return { kx: 1, ky: 1 };
  return { kx: inst.w / b.w, ky: inst.h / b.h };
}

/** 覆盖合并后的有效树（主档坐标；结构性字段忽略；合并结果重过 parseNode 全量消毒）。 */
function applyOverridePatch(n: DesignNode, patch: Record<string, unknown>): DesignNode {
  const merged: Record<string, unknown> = { ...n, ...sanitizePatch(patch) };
  // 文本覆盖速记：{"text":"改文案"} = 替换整层文案、沿用首段样式（多 run 归一为单 run）
  if (n.type === "text" && typeof patch.text === "string" && patch.runs === undefined)
    merged.runs = [{ ...(n.runs[0] ?? {}), text: patch.text }];
  // 嵌套覆盖表是合并语义（外层实例记内层实例的 overrides 增量）
  const outer = patch.overrides;
  if (n.type === "instance" && typeof outer === "object" && outer !== null)
    merged.overrides = { ...(n.overrides ?? {}), ...(outer as Record<string, Record<string, unknown>>) };
  const back = parseNode(merged, new Set([merged.id as string])) as (DesignNode & { id: string }) | null;
  if (!back) return n;
  back.id = n.id;
  (back as { type: string }).type = n.type;
  if ("children" in n && "children" in back) back.children = n.children; // 拓扑永远来自主档
  return back;
}

export function applyOverrides(nodes: DesignNode[], ov?: Record<string, Record<string, unknown>>): DesignNode[] {
  if (!ov) return nodes;
  const step = (list: DesignNode[]): DesignNode[] =>
    list.map((n) => {
      let m = ov[n.id] ? applyOverridePatch(n, ov[n.id]!) : n;
      if ("children" in n) {
        const kids = step(n.children);
        if (kids !== n.children) m = { ...m, children: kids } as DesignNode;
      }
      return m;
    });
  return step(nodes);
}

/** 实例有效内容（主档树 + 覆盖）；null = 坏/空引用（渲染层画占位框） */
export function resolveInstanceContent(doc: DesignDoc, inst: InstanceNode): DesignNode[] | null {
  const comp = findComponent(doc, inst.componentId);
  if (!comp || !comp.nodes.length) return null;
  return applyOverrides(comp.nodes, inst.overrides);
}

function findDeepNode(list: DesignNode[], id: string): DesignNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    if ("children" in n) {
      const hit = findDeepNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** 同上但带回直接容器节点（实例内部寻址要还原真实父链给 worldCornersOf 复合） */
function findDeepNodeWithParent(
  list: DesignNode[],
  id: string,
  parent: DesignNode | null,
): { node: DesignNode; parent: DesignNode | null } | null {
  for (const n of list) {
    if (n.id === id) return { node: n, parent };
    if ("children" in n) {
      const hit = findDeepNodeWithParent(n.children, id, n);
      if (hit) return hit;
    }
  }
  return null;
}

const viewRound = (v: number): number => Math.round(v * 100) / 100;

/**
 * 实例有效视图（**场景渲染/命中/检视器/findNode 的唯一口径**）：
 * 主档+覆盖 → 烘焙到「实例局部坐标」（根层平移 −包围盒 + 缩放 k，深层仅缩放），
 * id 重编为 "实例id/内部id"（嵌套实例再链式 "实例id/内层id/内部id"），
 * 字号/线宽/圆角按均比缩放（烘焙盒子配烘焙字，测量口径自洽）。
 * 嵌套实例保留为 instance 节点（渲染侧递归解析，寻址/覆盖写回都走同一条链）。
 * 坏引用 → null（渲染层画占位框）。
 */
export function instanceView(doc: DesignDoc, inst: InstanceNode, depth = 0): DesignNode[] | null {
  if (depth > 6) return null;
  const b = resolveInstanceBounds(doc, inst);
  if (!b) return null;
  const content = resolveInstanceContent(doc, inst)!;
  const { kx, ky } = instanceScale(doc, inst);
  const kAvg = (kx + ky) / 2;
  const prefix = `${inst.id}/`;
  const step = (list: DesignNode[], root: boolean): DesignNode[] =>
    list.map((n) => {
      let m = {
        ...n,
        id: prefix + n.id,
        x: viewRound((root ? n.x - b.x : n.x) * kx),
        y: viewRound((root ? n.y - b.y : n.y) * ky),
        w: Math.max(0.5, viewRound(n.w * kx)),
        h: Math.max(0.5, viewRound(n.h * ky)),
      } as DesignNode;
      m = scaleStyleFields(m, kAvg);
      if ("children" in n) m = { ...m, children: step(n.children, false) } as DesignNode;
      return m;
    });
  return step(content, true);
}

/**
 * 视图坐标 → 主档坐标（instanceView 烘焙的逆运算），对 patch 里的几何/数值样式生效。
 * isRoot：目标是视图根层节点（视图原点=主档包围盒左上 → 逆平移）；深层只做逆缩放。
 */
function unBakePatch(doc: DesignDoc, inst: InstanceNode, patch: Record<string, unknown>, isRoot: boolean): Record<string, unknown> {
  const b = resolveInstanceBounds(doc, inst);
  const { kx, ky } = instanceScale(doc, inst);
  const kAvg = (kx + ky) / 2;
  if (!b) return { ...patch };
  const out: Record<string, unknown> = { ...patch };
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const px = n(patch.x);
  if (px !== undefined) out.x = viewRound(kx === 0 ? px : isRoot ? px / kx + b.x : px / kx);
  const py = n(patch.y);
  if (py !== undefined) out.y = viewRound(ky === 0 ? py : isRoot ? py / ky + b.y : py / ky);
  const pw = n(patch.w);
  if (pw !== undefined) out.w = Math.max(0.5, viewRound(kx === 0 ? pw : pw / kx));
  const ph = n(patch.h);
  if (ph !== undefined) out.h = Math.max(0.5, viewRound(ky === 0 ? ph : ph / ky));
  // 数值样式（字号/线宽/圆角/描边宽）随均比逆缩放
  if (kAvg > 0 && kAvg !== 1) {
    if (Array.isArray(patch.runs))
      out.runs = (patch.runs as Record<string, unknown>[]).map((r) =>
        typeof r?.size === "number" ? { ...r, size: viewRound(r.size / kAvg) } : r,
      );
    if (typeof patch.strokeWidth === "number") out.strokeWidth = viewRound(patch.strokeWidth / kAvg);
    if (typeof patch.radius === "number") out.radius = viewRound(patch.radius / kAvg);
    if (Array.isArray(patch.strokes))
      out.strokes = (patch.strokes as Stroke[]).map((s) => ({ ...s, width: viewRound(s.width / kAvg) }));
  }
  return out;
}

/**
 * 把 patch 写入实例的内部节点覆盖（segs = "实例id/" 之后按 / 拆的寻址链，可穿嵌套实例）。
 * patch 用视图坐标（检视器/画布/MCP 与 instanceView 同口径），存前逆烘焙回主档坐标。
 * 返回新实例节点（原节点不动）；引用坏/路径断 → null。
 */
export function patchInstancePath(
  doc: DesignDoc,
  inst: InstanceNode,
  segs: string[],
  patch: Record<string, unknown>,
): InstanceNode | null {
  if (!segs.length || segs.length > 8) return null;
  const view = instanceView(doc, inst);
  if (!view) return null;
  const head = segs[0]!;
  const rest = segs.slice(1);
  const targetId = `${inst.id}/${head}`;
  const target = findDeepNode(view, targetId);
  if (!target) return null;
  const ov = inst.overrides ?? {};
  if (!rest.length) {
    const isRoot = view.some((n) => n.id === targetId);
    const merged = { ...(ov[head] ?? {}), ...sanitizePatch(unBakePatch(doc, inst, patch, isRoot)) };
    return { ...inst, overrides: { ...ov, [head]: merged } };
  }
  if (target.type !== "instance") return null;
  const nested = patchInstancePath(doc, target, rest, patch); // target 已是含外层增量的视图节点
  if (!nested) return null;
  return { ...inst, overrides: { ...ov, [head]: { ...(ov[head] ?? {}), overrides: nested.overrides } } };
}

/** 烘焙时按均比缩放"数值样式"（字号/线宽/圆角），让视图/静态树与盒尺寸口径一致 */
function scaleStyleFields(n: DesignNode, k: number): DesignNode {
  if (k === 1 || !Number.isFinite(k) || k <= 0) return n;
  if (n.type === "text")
    return { ...n, runs: n.runs.map((r) => ({ ...r, size: r.size === undefined ? r.size : viewRound(r.size * k) })) };
  const out: DesignNode = { ...n } as DesignNode;
  const anyN = out as unknown as { strokeWidth?: number; radius?: number | [number, number, number, number]; strokes?: Stroke[] };
  if (typeof anyN.strokeWidth === "number") anyN.strokeWidth = viewRound(anyN.strokeWidth * k);
  if (typeof anyN.radius === "number") anyN.radius = viewRound(anyN.radius * k);
  if (Array.isArray(anyN.strokes)) anyN.strokes = anyN.strokes.map((s) => ({ ...s, width: viewRound(s.width * k) }));
  return out;
}

/**
 * 实例深度烘焙为静态子树（分离实例/flattenInstances 用）：
 * instanceView 口径 + 嵌套实例递归展开（坏引用的内层保留为占位实例节点）。
 * 产物 id 仍带 "实例id/…" 前缀——调用方（detach）拿去 regenIds，导出方只当字符串标识用。
 */
export function bakeInstanceNodes(doc: DesignDoc, inst: InstanceNode, depth = 0): DesignNode[] | null {
  if (depth > 6) return null;
  const view = instanceView(doc, inst);
  if (!view) return null;
  const expand = (list: DesignNode[]): DesignNode[] => {
    const out: DesignNode[] = [];
    for (const n of list) {
      if (n.type === "instance") {
        const inner = bakeInstanceNodes(doc, n, depth + 1);
        if (inner) {
          // 内层产物相对内层盒左上 → 平移到外层烘焙位
          out.push(...inner.map((c) => ({ ...c, x: viewRound(c.x + n.x), y: viewRound(c.y + n.y) })));
          continue;
        }
      }
      if ("children" in n) out.push({ ...n, children: expand(n.children) } as DesignNode);
      else out.push(n);
    }
    return out;
  };
  return expand(view);
}

/** 全档展平实例（CSS/HTML 导出、bundle 内嵌等"要静态树"的调用方用） */
export function flattenInstances(doc: DesignDoc): DesignDoc {
  if (!(doc.components?.length ?? 0)) return doc;
  const hasInst = (list: DesignNode[]): boolean =>
    list.some((n) => n.type === "instance" || ("children" in n && hasInst(n.children)));
  const flat = (list: DesignNode[]): DesignNode[] => {
    const out: DesignNode[] = [];
    for (const n of list) {
      if (n.type === "instance") {
        // 坏引用烘焙不出来：保留实例节点本身（下游渲染走占位框），绝不静默丢内容
        out.push(...(bakeInstanceNodes(doc, n) ?? [n]));
        continue;
      }
      if ("children" in n) {
        if (hasInst(n.children)) out.push({ ...n, children: flat(n.children) } as DesignNode);
        else out.push(n);
      } else out.push(n);
    }
    return out;
  };
  const pages = doc.pages.map((p) => (hasInst(p.nodes) ? { ...p, nodes: flat(p.nodes) } : p));
  return { ...doc, pages, components: undefined };
}

/** 全档画板（各页顶层 frame，页序 + 树序）——原型预览/导出/跳转目标列表共用 */
export function allFrames(doc: DesignDoc): { pageId: string; frame: FrameNode }[] {
  const out: { pageId: string; frame: FrameNode }[] = [];
  for (const p of doc.pages)
    for (const n of p.nodes) if (n.type === "frame") out.push({ pageId: p.id, frame: n });
  return out;
}

/* ---------------- 容错解析 ---------------- */

/** fatal=true：整档不可用（JSON 解析失败/不是对象），返回的是空白档占位——
 *  调用方必须显示损坏横幅并禁止回写，绝不能用占位内容覆盖盘上坏档 */
export type ParseResult = { doc: DesignDoc; warnings: string[]; fatal: boolean; fixes?: string[] };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 数字宽松化：容忍 "375"、"375px"、"50%"（按 0..1 用时由 opacity01 处理） */
const num = (v: unknown, d = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/px$/i, "");
    if (s !== "" && Number.isFinite(Number(s))) return Number(s);
  }
  return d;
};
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
/** 布尔宽松化：容忍 "true"/"false"/1/0（AI 常把布尔写成字符串） */
const boolish = (v: unknown, d: boolean): boolean =>
  v === true || v === "true" || v === 1 || v === "1" ? true : v === false || v === "false" || v === 0 || v === "0" ? false : d;
/** 首个命中的字段（别名表：AI 常写 cornerRadius/fontSize/fontFamily…） */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", red: "#ff0000", blue: "#0000ff",
  green: "#008000", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", brown: "#a52a2a",
  silver: "#c0c0c0", navy: "#000080", teal: "#008080", lime: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff",
};
const FUNC_COLOR = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;
const channel = (s: string): number => {
  const v = s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s);
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));
};
/** 颜色宽松化：hex / 常用色名 / rgb()·rgba()（AI 三种都会写） */
export const colorOr = (v: unknown, d: string): string => {
  if (typeof v !== "string") return d;
  const s = v.trim();
  if (s.startsWith("var:") && s.length > 4) return s; // 变量引用原样存活（渲染端经 resolveVarColor 解析）
  if (HEX.test(s)) return s.toLowerCase();
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return named;
  const m = FUNC_COLOR.exec(s);
  if (m) {
    const hex = `#${channel(m[1]!).toString(16).padStart(2, "0")}${channel(m[2]!).toString(16).padStart(2, "0")}${channel(m[3]!).toString(16).padStart(2, "0")}`;
    if (m[4] === undefined) return hex;
    const a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    const alpha = Math.min(255, Math.max(0, Math.round((Number.isFinite(a) ? a : 1) * 255)));
    return alpha >= 255 ? hex : `${hex}${alpha.toString(16).padStart(2, "0")}`;
  }
  return d;
};
const opacity01 = (v: unknown, d = 1): number => {
  if (typeof v === "string" && v.trim().endsWith("%")) return clamp(num(v.trim().slice(0, -1), d * 100) / 100, 0, 1);
  return v === undefined ? d : clamp(num(v, d), 0, 1);
};

/* ---------------- 共享颜色变量 ---------------- */

/** 坏引用/解析超链的变量回退色（主流"样式缺失"警示粉口径） */
export const MISSING_VAR_COLOR = "#e8506e";

export const isVarRef = (c: unknown): c is string => typeof c === "string" && c.startsWith("var:") && c.length > 4;
export const varRefId = (c: string): string => c.slice(4);

/** 颜色串里的 "var:<id>" 引用 → 变量当前值（可链式引用，≤4 层防环；坏引用/超链 → 警示粉）。
 *  非 var: 串原样返回（空值走 fallback）——画布/导出/CSS 三端的颜色消费点都先过这里。 */
export function resolveVarColor(doc: DesignDoc | undefined, color: string | undefined, fallback = "#000000", depth = 0): string {
  if (!color) return fallback;
  if (!isVarRef(color)) return color;
  if (depth > 4) return MISSING_VAR_COLOR;
  const def = doc?.variables?.find((v) => v.id === color.slice(4));
  if (!def) return MISSING_VAR_COLOR;
  return resolveVarColor(doc, def.value, MISSING_VAR_COLOR, depth + 1);
}

/** 全档 var: 引用盘点（id → 引用次数；页面树 + 组件主档树）。MCP 用量统计/删除提示用 */
export function collectVarRefs(doc: DesignDoc): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (c: unknown): void => {
    if (isVarRef(c)) out.set(c.slice(4), (out.get(c.slice(4)) ?? 0) + 1);
  };
  // walkDoc/walkNodes 已产出整棵树的每个节点，这里只清点、不再递归（否则容器子树计双份）
  const walk = (n: DesignNode): void => {
    for (const f of (n as { fills?: Fill[] }).fills ?? []) {
      bump(f.color);
      for (const s of f.stops ?? []) bump(s.color);
    }
    for (const s of (n as { strokes?: Stroke[] }).strokes ?? []) bump(s.color);
    for (const e of (n as { effects?: Effect[] }).effects ?? []) bump((e as { color?: string }).color);
    for (const r of (n as { runs?: TextRun[] }).runs ?? []) bump(r.color);
    // 形状内嵌文字：颜色在 text.runs[] 上，同样可绑 var:，盘点不能漏
    for (const r of (n as { text?: { runs?: TextRun[] } }).text?.runs ?? []) bump(r.color);
    bump((n as { color?: string }).color);
  };
  for (const { node } of walkDoc(doc)) walk(node);
  for (const comp of doc.components ?? []) for (const n of walkNodes(comp.nodes)) walk(n);
  return out;
}

const mapVarColor = (c: string, map: Map<string, string>): string => {
  if (!isVarRef(c)) return c;
  const v = map.get(c.slice(4));
  if (v === undefined) return c;
  // merge 的映射值是新变量 id（补 var: 前缀）；detach 的映射值是色值串（#…/var:…，原样烘焙）
  return v.startsWith("var:") || v.startsWith("#") ? v : `var:${v}`;
};

const remapColorObj = <T,>(o: T, map: Map<string, string>): T => {
  const rec = o as Record<string, unknown> | null;
  if (!rec || typeof rec !== "object" || typeof rec.color !== "string") return o;
  const nc = mapVarColor(rec.color, map);
  return nc === rec.color ? o : ({ ...rec, color: nc } as T);
};

const remapColorPaint = (f: Fill, map: Map<string, string>): Fill => {
  const g = remapColorObj(f, map);
  if (Array.isArray((g as { stops?: unknown[] }).stops))
    (g as { stops: unknown[] }).stops = (g as { stops: unknown[] }).stops.map((s) => remapColorObj(s, map));
  return g;
};

/** 就地改写节点数组里全部 var: 引用（含渐变色标/覆盖值；merge 导入重映射与 MCP 删除变量
 *  detach 烘焙共用）。映射表查不到的引用原样保留。节点对象须是调用方持有的克隆。 */
export function remapVarColors(list: DesignNode[], map: Map<string, string>): void {
  for (const n of list) {
    const rec = n as unknown as Record<string, unknown>;
    if (Array.isArray(rec.fills)) rec.fills = (rec.fills as Fill[]).map((f) => remapColorPaint(f, map));
    if (Array.isArray(rec.strokes)) rec.strokes = (rec.strokes as unknown[]).map((s) => remapColorObj(s, map));
    if (Array.isArray(rec.effects)) rec.effects = (rec.effects as unknown[]).map((e) => remapColorObj(e, map));
    if (Array.isArray(rec.runs)) rec.runs = (rec.runs as unknown[]).map((r) => remapColorObj(r, map));
    if (typeof rec.color === "string") rec.color = mapVarColor(rec.color, map);
    if (rec.overrides && typeof rec.overrides === "object") {
      for (const v of Object.values(rec.overrides as Record<string, unknown>))
        if (v && typeof v === "object") remapVarColors([v as DesignNode], map);
    }
    if ("children" in n && Array.isArray(n.children)) remapVarColors(n.children, map);
  }
}

function parseVariables(raw: unknown, warn?: ParseWarn): VariableDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VariableDef[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 100)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id).slice(0, 60);
    const name = str(o.name).slice(0, 60);
    if (!id || !name) {
      warn?.("变量缺 id/name，已跳过");
      continue;
    }
    if (seen.has(id)) {
      warn?.(`变量 id 重复已去重：${id}`);
      continue;
    }
    seen.add(id);
    const def: VariableDef = { id, name, value: colorOr(o.value, "#000000") };
    const desc = str(o.desc).slice(0, 200);
    if (desc) def.desc = desc;
    out.push(def);
  }
  return out.length ? out : undefined;
}

function parseFill(raw: unknown): Fill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "image") {
    const src = pickStr(o, "src", "image", "url", "path");
    if (!src) return null;
    const f: Fill = { type: "image", src: src.slice(0, 600) };
    if (boolish(o.visible, true) === false) f.visible = false;
    const op = opacity01(o.opacity ?? o.alpha, 1);
    if (op < 1) f.opacity = op;
    const mode = str(o.scaleMode ?? o.fit).toLowerCase();
    if (mode === "fit" || mode === "contain" || mode === "scale-down") f.scaleMode = "fit";
    else if (mode === "stretch" || mode === "fill-stretch") f.scaleMode = "stretch";
    else f.scaleMode = "fill"; // cover/crop/fill 同口径
    return f;
  }
  // 别名容错：{kind:"linear-gradient"} / {linear:true} / 直接 {color:"#xxx"}（缺 type 的实心）
  const rawType = o.type ?? o.kind;
  let type: FillType | null =
    rawType === "linear" || rawType === "linear-gradient" || rawType === "gradient"
      ? "linear"
      : rawType === "radial" || rawType === "radial-gradient"
        ? "radial"
        : rawType === "solid" || rawType === undefined
          ? "solid"
          : null;
  if (!type) return null;
  const f: Fill = { type };
  if (boolish(o.visible, true) === false) f.visible = false;
  const op = opacity01(o.opacity ?? o.alpha, 1);
  if (op < 1) f.opacity = op;
  if (type === "solid") {
    // 纯色兼容：color / fill / value / stops[0].color
    const stop0 = Array.isArray(o.stops) && o.stops[0] && typeof o.stops[0] === "object" ? (o.stops[0] as Record<string, unknown>).color : undefined;
    f.color = colorOr(pick(o, "color", "fill", "value") ?? stop0, "#d9d9d9");
  } else {
    const stops: GradientStop[] = [];
    if (Array.isArray(o.stops)) {
      for (const s of o.stops) {
        if (typeof s !== "object" || s === null) continue;
        const so = s as Record<string, unknown>;
        // {offset,color} 与 {at,color} 两式
        stops.push({ at: clamp(num(so.at ?? so.offset ?? so.position, 0), 0, 1), color: colorOr(so.color, "#000000") });
        if (stops.length >= 8) break;
      }
    }
    if (stops.length === 0) {
      const from = colorOr(pick(o, "from", "start", "colorA"), "#4f46e5");
      const to = colorOr(pick(o, "to", "end", "colorB"), "#06b6d4");
      stops.push({ at: 0, color: from }, { at: 1, color: to });
    }
    stops.sort((a, b) => a.at - b.at);
    f.stops = stops;
    if (type === "linear") {
      // angle 兼容：数字角 / "45deg" / direction:"to bottom" 语义键
      const rawAngle = pick(o, "angle", "rotation", "deg", "direction");
      let a: number | null = num(rawAngle, NaN);
      if (!Number.isFinite(a as number)) {
        const dirMap: Record<string, number> = { "to bottom": 180, "to top": 0, "to right": 90, "to left": 270, bottom: 180, top: 0, right: 90, left: 270 };
        a = dirMap[String(rawAngle ?? "").trim().toLowerCase()] ?? 0;
      }
      if (a !== 0 && Number.isFinite(a as number)) f.angle = (((a as number) % 360) + 360) % 360;
    } else {
      const c = typeof o.center === "object" && o.center !== null ? (o.center as Record<string, unknown>) : null;
      if (c && (typeof c.x === "number" || typeof c.y === "number")) {
        f.center = { x: clamp(num(c.x, 0.5), 0, 1), y: clamp(num(c.y, 0.5), 0, 1) };
      }
    }
  }
  return f;
}

function parseStrokes(raw: unknown): Stroke[] {
  // 别名：单对象 stroke:{...} 或 数字 strokeWidth（配可选 color）
  const list = Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : [];
  const out: Stroke[] = [];
  for (const s of list) {
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    const st: Stroke = {
      color: colorOr(pick(so, "color", "stroke", "value"), "#111111"),
      width: clamp(num(pick(so, "width", "strokeWidth", "size"), 1), 0, 40),
    };
    if (so.align === "inside" || so.align === "outside") st.align = so.align;
    if (so.style === "dashed" || so.style === "dotted") st.style = so.style;
    if (boolish(so.visible, true) === false) st.visible = false;
    out.push(st);
    if (out.length >= 4) break;
  }
  return out;
}

function parseEffects(raw: unknown): Effect[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Effect[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const eo = e as Record<string, unknown>;
    if (eo.type === "drop-shadow" || eo.type === "inner-shadow") {
      out.push({
        type: eo.type,
        visible: eo.visible === false ? false : undefined,
        color: colorOr(eo.color, "#000000"),
        x: clamp(num(eo.x, 0), -200, 200),
        y: clamp(num(eo.y, 4), -200, 200),
        blur: clamp(num(eo.blur, 12), 0, 200),
      });
    } else if (eo.type === "layer-blur") {
      out.push({ type: "layer-blur", visible: eo.visible === false ? false : undefined, blur: clamp(num(eo.blur, 8), 0, 100) });
    }
    if (out.length >= 4) break;
  }
  return out.length ? out : undefined;
}

function parseRadius(raw: unknown): number | [number, number, number, number] | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.x === "number" || typeof o.y === "number") {
      const v = [clamp(num(o.y, 0), 0, 4096), clamp(num(o.x, 0), 0, 4096), clamp(num(o.y, 0), 0, 4096), clamp(num(o.x, 0), 0, 4096)];
      return v.some((r) => r !== 0) ? [v[0]!, v[1]!, v[2]!, v[3]!] : undefined;
    }
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw === 0) return undefined;
    return clamp(raw, 0, 4096);
  }
  if (Array.isArray(raw) && raw.length === 4) {
    const v = raw.map((r) => clamp(num(r, 0), 0, 4096));
    return v.some((r) => r !== 0) ? [v[0]!, v[1]!, v[2]!, v[3]!] : undefined;
  }
  return undefined;
}

function parseRun(raw: unknown): TextRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  const r: TextRun = { text: o.text.slice(0, 20000) };
  // 字段别名：AI 常写 fontSize/fontWeight/fontFamily/fontColor（text 节点顶层简写同样命中）
  const color = pick(o, "color", "fill", "fontColor", "textColor");
  if (color !== undefined) r.color = colorOr(color, "#111111");
  const size = pick(o, "size", "fontSize");
  if (size !== undefined) r.size = clamp(num(size, 16), 1, 400);
  const weight = pick(o, "weight", "fontWeight");
  if (weight !== undefined) r.weight = clamp(num(weight, 400), 100, 1000);
  if (boolish(pick(o, "italic", "isItalic"), false)) r.italic = true;
  if (boolish(pick(o, "underline", "isUnderline"), false)) r.underline = true;
  const font = pick(o, "font", "fontFamily");
  if (typeof font === "string" && font.trim()) r.font = font.slice(0, 120);
  return r;
}

/** 非空字符串字段的首个命中（别名查找用，纯字符串才认） */
function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** 节点类型归一：小写精确 → 常见别名（AI 写 Icon/Circle/Rectangle/img…） */
const TYPE_ALIASES: Record<string, NodeType> = {
  rectangle: "rect",
  square: "rect",
  box: "rect",
  circle: "ellipse",
  oval: "ellipse",
  textbox: "text",
  paragraph: "text",
  label: "text",
  img: "image",
  picture: "image",
  photo: "image",
  bitmap: "image",
  artboard: "frame",
  screen: "frame",
  glyph: "icon",
  lucide: "icon",
  lucideicon: "icon",
  iconnode: "icon",
  path: "vector",
  shape: "vector",
  componentinstance: "instance",
  symbolinstance: "instance",
  instance: "instance",
};

function normalizeNodeType(t: unknown): NodeType | null {
  if (typeof t !== "string") return null;
  const key = t.trim().toLowerCase();
  if (
    key === "frame" || key === "group" || key === "rect" || key === "ellipse" || key === "triangle" ||
    key === "diamond" || key === "pentagon" || key === "hexagon" || key === "star" || key === "line" ||
    key === "arrow" || key === "text" || key === "image" || key === "icon" || key === "vector" ||
    key === "instance"
  ) {
    return key as NodeType;
  }
  return TYPE_ALIASES[key] ?? null;
}

export type ParseWarn = (msg: string) => void;

function parseNode(raw: unknown, seenIds: Set<string>, warn?: ParseWarn): DesignNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const t = normalizeNodeType(o.type);
  if (!t) {
    // 不再静默丢弃：报出来让 agent/用户知道丢了什么
    warn?.(`未知节点类型 "${String(o.type).slice(0, 40)}"（节点被跳过）`);
    return null;
  }

  let id = str(o.id);
  if (!id || seenIds.has(id)) id = uid(t[0]!);
  seenIds.add(id);

  const name0 = str(o.name);
  const base: NodeBase = {
    id,
    name: (name0 || TYPE_LABELS[t as NodeType] || String(t)).slice(0, 120),
    x: clamp(num(o.x), -100000, 100000),
    y: clamp(num(o.y), -100000, 100000),
    w: clamp(num(o.w, 100), 1, 20000),
    h: clamp(num(o.h, 100), 1, 20000),
  };
  const rot = num(o.rotation, 0);
  if (rot !== 0) base.rotation = ((rot % 360) + 360) % 360;
  const op = opacity01(o.opacity, 1);
  if (op < 1) base.opacity = op;
  if (boolish(o.visible, true) === false) base.visible = false;
  if (boolish(o.locked, false)) base.locked = true;
  // 圆角别名：cornerRadius/borderRadius（AI 最常犯的 Figma 口径）
  const radius = parseRadius(pick(o, "radius", "cornerRadius", "borderRadius", "corner_radius"));
  if (radius !== undefined) base.radius = radius;
  const effects = parseEffects(o.effects);
  if (effects) base.effects = effects;
  const interactions = parseInteractions(pick(o, "interactions", "prototype", "triggers"));
  if (interactions) base.interactions = interactions;
  if (typeof o.onTap === "object" && o.onTap !== null) {
    const to = str((o.onTap as Record<string, unknown>).to);
    if (to) base.onTap = { to: to.slice(0, 120) };
  }
  if (boolish(o.mask, false)) base.mask = true;
  const gr = num(o.grow, 0);
  if (gr > 0) base.grow = clamp(gr, 0, 100);
  const blend = normalizeBlendMode(pick(o, "blendMode", "blend", "mixBlendMode"));
  if (blend) base.blendMode = blend;
  if (boolish(pick(o, "flipX", "flipH", "mirrorX"), false)) base.flipX = true;
  if (boolish(pick(o, "flipY", "flipV", "mirrorY"), false)) base.flipY = true;

  if (t === "frame" || t === "group") {
    const children = parseChildren(o.children, seenIds, warn);
    if (t === "group") return { ...base, type: "group", children };
    const node: FrameNode = { ...base, type: "frame", children, fills: fillsForNode(o) };
    const strokes = strokesForNode(o);
    if (strokes.length) node.strokes = strokes;
    if (o.clip === false) node.clip = false;
    if (typeof o.preset === "string" && o.preset in DEVICE_PRESETS) node.preset = o.preset;
    const layout = normalizeLayout(o.layout);
    if (layout) node.layout = layout;
    const scroll = normalizeScrollAxis(pick(o, "scroll", "scrollAxis", "overflow"));
    if (scroll) node.scroll = scroll;
    return node;
  }
  if (t === "text") {
    // 顶层即简写 run：{"type":"text","text":"标题","fontSize":24} 不再丢样式
    const rawRuns: unknown[] = Array.isArray(o.runs) ? o.runs : [o];
    const runs = rawRuns.map(parseRun).filter((r): r is TextRun => r !== null);
    const node: TextNode = { ...base, type: "text", runs: runs.length ? runs.slice(0, 64) : [{ text: "文本" }] };
    if (o.align === "center" || o.align === "right") node.align = o.align;
    if (o.vAlign === "middle" || o.vAlign === "bottom") node.vAlign = o.vAlign;
    if (o.lineHeight !== undefined) node.lineHeight = clamp(num(o.lineHeight, 1.4), 0.5, 4);
    if (o.letterSpacing !== undefined) node.letterSpacing = clamp(num(o.letterSpacing, 0), -20, 40);
    return node;
  }
  if (t === "image") {
    // src 别名：url/href/path（AI 常混用）
    const node: ImageNode = { ...base, type: "image", src: str(pickStr(o, "src", "url", "href", "path") ?? "").slice(0, 600) };
    const fit = str(o.fit).toLowerCase();
    if (fit === "contain" || fit === "stretch" || fit === "scale-down") node.fit = fit === "scale-down" ? "contain" : fit;
    else if (fit === "fill" || fit === "crop") node.fit = fit === "fill" ? "stretch" : "cover";
    const strokes = strokesForNode(o);
    if (strokes.length) node.strokes = strokes;
    return node;
  }
  if (t === "icon") {
    // 图标名：icon/iconName/glyph 优先；只有 name 时且能解析成图标也认（AI 常写 {"type":"icon","name":"home"}）
    const wanted = pickStr(o, "icon", "iconName", "glyph", "symbol") ?? pickStr(o, "name") ?? "";
    const resolved = resolveIconName(wanted);
    if (wanted && !resolved) warn?.(`未知图标名 "${wanted.slice(0, 60)}"（将画占位）`);
    const node: IconNode = {
      ...base,
      type: "icon",
      icon: resolved ?? wanted ?? DEFAULT_ICON,
      color: colorOr(pick(o, "color", "tint", "stroke", "fill"), "#111111"),
      strokeWidth: clamp(num(pick(o, "strokeWidth", "thickness", "weight"), 2), 0.25, 12),
    };
    if (!name0 && resolved) node.name = resolved;
    return node;
  }
  if (t === "vector") {
    const d = pickStr(o, "path", "d");
    if (!d) {
      warn?.("vector 节点缺少 path（SVG d 字符串），已跳过");
      return null;
    }
    const node: VectorNode = { ...base, type: "vector", path: d.slice(0, 40000), fills: fillsForNode(o), strokes: strokesForNode(o) };
    return node;
  }
  if (t === "instance") {
    // 主档引用别名：componentId/ref/component/mainComponent（AI 各家口径）
    const ref = pickStr(o, "componentId", "component", "ref", "mainComponent", "componentRef");
    const node: InstanceNode = { ...base, type: "instance", componentId: (ref ?? "").trim().slice(0, 120) };
    if (!ref) warn?.("instance 缺 componentId（渲染占位框，请用 list_components 查主档 id）");
    // w/h 未显式给出 → 0 哨兵，解析尾程用主档包围盒回填（显式尺寸 = 用户的缩放意图，保留）
    if (o.w === undefined) node.w = 0;
    if (o.h === undefined) node.h = 0;
    const ov = parseOverrides(o.overrides);
    if (ov) node.overrides = ov;
    return node;
  }
  if (t === "line" || t === "arrow") {
    const node: LineNode = { ...base, type: t, strokes: strokesForNode(o) };
    if (!node.strokes.length) node.strokes = [{ color: "#111111", width: 2 }];
    const d = num(o.dir, 0);
    if (d === 1 || d === 2 || d === 3) node.dir = d as LineDir;
    return node;
  }
  const node: ShapeNode = { ...base, type: t as BoxShapeType, fills: fillsForNode(o), strokes: strokesForNode(o) };
  const lt = parseLayerText(pick(o, "text", "label", "layerText"));
  if (lt) node.text = lt;
  return node;
}

/**
 * 内嵌文字宽松解析：接受 "按钮"（裸串）/ {runs|text|label, align, vAlign, ...} / run 数组。
 * 无有效文字返回 null（不落字段，保持序列化幂等）。
 *
 * 导出给 MCP 侧复用：形状标签的写法容错必须只有一份实现，否则
 * "面板/文件写的 {runs:[…]} 工具不认、工具的简写文件不认"这种漂移必然发生。
 */
export function parseLayerText(raw: unknown): LayerText | null {
  if (raw === undefined || raw === null) return null;
  const box = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const src = box ? pick(box, "runs", "text", "label") : raw;
  if (src === undefined || src === null) return null;
  const rawRuns: unknown[] = Array.isArray(src) ? src : typeof src === "string" ? [{ text: src }] : [src];
  const runs = rawRuns.map(parseRun).filter((r): r is TextRun => r !== null).slice(0, 64);
  if (runs.length === 0 || runs.every((r) => !r.text)) return null;
  const out: LayerText = { runs };
  if (box) {
    // 缺省是 center / middle：只有偏离缺省才落字段，保证序列化幂等
    if (box.align === "left" || box.align === "right") out.align = box.align;
    if (box.vAlign === "top" || box.vAlign === "bottom") out.vAlign = box.vAlign;
    if (box.lineHeight !== undefined) out.lineHeight = clamp(num(box.lineHeight, 1.4), 0.5, 4);
    if (box.letterSpacing !== undefined) out.letterSpacing = clamp(num(box.letterSpacing, 0), -20, 40);
  }
  return out;
}

/** 取节点的内嵌文字（仅形状有）；text 节点走自己的 runs，故返回 null */
export const layerText = (n: DesignNode): LayerText | null =>
  n.type === "text" ? null : ((n as { text?: LayerText }).text ?? null);

/**
 * 「可以承载一段文字」的节点：text 节点本身，或形状（内嵌 text 字段，即 Figma 的 layer text）。
 * 双击就地编辑、面板/MCP 改文案都按这个口径判断，避免两处对"哪些节点能写字"各说各话。
 */
export function canHoldText(n: DesignNode): boolean {
  if (n.type === "text") return true;
  return SHAPE_TYPES.includes(n.type);
}

/** 统一的文字读取口：text 节点取 runs，形状取内嵌 text.runs，其余空数组 */
export function nodeTextRuns(n: DesignNode): TextRun[] {
  if (n.type === "text") return n.runs;
  return layerText(n)?.runs ?? [];
}

/** 统一的排版参数读取口（text 节点看自身字段，形状看 LayerText） */
export function nodeTextStyle(n: DesignNode): {
  align: "left" | "center" | "right";
  vAlign: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
} {
  if (n.type === "text") {
    return { align: n.align ?? "left", vAlign: n.vAlign ?? "top", ...(n.lineHeight !== undefined ? { lineHeight: n.lineHeight } : {}), ...(n.letterSpacing !== undefined ? { letterSpacing: n.letterSpacing } : {}) };
  }
  const lt = layerText(n);
  // 形状里的文字是「形状的内容」，缺省双居中（与 select 无关，见 layerTextBlock）
  return { align: lt?.align ?? "center", vAlign: lt?.vAlign ?? "middle", ...(lt?.lineHeight !== undefined ? { lineHeight: lt.lineHeight } : {}), ...(lt?.letterSpacing !== undefined ? { letterSpacing: lt.letterSpacing } : {}) };
}

/**
 * 就地写形状的内嵌标签（LayerText）。
 * 空 runs = **摘掉标签**回到纯色块，而不是留一个空 text 对象——
 * 否则「没写字」和「写了空串」在文档里长得不一样，diff 与体检都难判。
 */
export function applyLayerText(
  shape: ShapeNode,
  runs: TextRun[],
  style?: { align?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom" },
): void {
  if (runs.length === 0 || (runs.length === 1 && runs[0]!.text === "")) {
    delete shape.text;
    return;
  }
  const next: LayerText = { ...(shape.text ?? {}), runs };
  if (style?.align) next.align = style.align;
  if (style?.vAlign) next.vAlign = style.vAlign;
  shape.text = next;
}

/**
 * 把一段文字写进节点（形状写内嵌 text；text 节点写 runs），返回新节点（immutable）。
 * 面板与 MCP 都从这里走，保证「双击矩形打字」与工具写文案落在同一个字段。
 */
export function withTextRuns(
  n: DesignNode,
  runs: TextRun[],
  style?: { align?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom" },
): DesignNode {
  if (n.type === "text") {
    const out = { ...n, runs } as TextNode;
    if (style?.align) out.align = style.align;
    if (style?.vAlign) out.vAlign = style.vAlign;
    return out;
  }
  if (!SHAPE_TYPES.includes(n.type)) return n;
  const shape = { ...n } as ShapeNode;
  applyLayerText(shape, runs, style);
  return shape;
}

function parseFills(raw: unknown): Fill[] {
  if (!Array.isArray(raw)) return [];
  const out: Fill[] = [];
  for (const f of raw) {
    const p = parseFill(f);
    if (p) out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

/** fills 简写（fills 数组缺席时）：fill/background/bg 字符串色或单 fill 对象；none/transparent = 不填 */
function fillsShorthand(o: Record<string, unknown>): Fill[] {
  const v = pick(o, "fill", "background", "bg", "fillColor", "backgroundColor");
  if (v === undefined) return [];
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s || s === "none" || s === "transparent") return [];
    const c = colorOr(v, "");
    return c ? [{ type: "solid", color: c }] : [];
  }
  const f = parseFill(v);
  return f ? [f] : [];
}

/** strokes 简写（strokes 数组缺席时）：stroke/border 字符串色 + strokeWidth；或单 stroke 对象 */
function strokesShorthand(o: Record<string, unknown>): Stroke[] {
  const v = pick(o, "stroke", "border", "borderColor", "outline");
  if (v === undefined) return [];
  if (typeof v === "string") {
    const c = colorOr(v, "");
    if (!c) return [];
    return [{ color: c, width: clamp(num(pick(o, "strokeWidth", "borderWidth", "outlineWidth"), 1), 0, 40) }];
  }
  const st = parseStrokes([v]);
  const w = pick(o, "strokeWidth", "borderWidth", "outlineWidth");
  if (st[0] && w !== undefined) st[0].width = clamp(num(w, 1), 0, 40);
  return st;
}

/** 节点的 fills：数组优先，否则简写 */
function fillsForNode(o: Record<string, unknown>): Fill[] {
  return Array.isArray(o.fills) ? parseFills(o.fills) : fillsShorthand(o);
}

/** 节点的 strokes：数组优先，否则简写 */
function strokesForNode(o: Record<string, unknown>): Stroke[] {
  return Array.isArray(o.strokes) ? parseStrokes(o.strokes) : strokesShorthand(o);
}

/** layout 宽松归一：horizontal/row→h、vertical/column→v；padding 数字→四边；Figma/CSS 对齐别名 */
function normalizeLayout(raw: unknown): FrameLayout | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const modeRaw = str(pick(o, "mode", "direction", "orientation")).toLowerCase();
  const mode: LayoutMode | null =
    modeRaw === "h" || modeRaw === "horizontal" || modeRaw === "row"
      ? "h"
      : modeRaw === "v" || modeRaw === "vertical" || modeRaw === "column"
        ? "v"
        : null;
  if (!mode) return undefined; // 没有 mode 的 layout 无意义，整条丢弃
  const lo: FrameLayout = { mode };
  const gap = num(pick(o, "gap", "itemSpacing", "spacing"), 0);
  if (gap > 0) lo.gap = clamp(gap, 0, 2000);
  const p = o.padding;
  if (typeof p === "number") {
    const v = clamp(num(p, 0), 0, 1000);
    if (v > 0) lo.padding = [v, v, v, v];
  } else if (Array.isArray(p) && p.length === 4) {
    const q = p.map((x) => clamp(num(x, 0), 0, 1000));
    if (q.some((x) => x > 0)) lo.padding = [q[0]!, q[1]!, q[2]!, q[3]!];
  }
  const mainMap: Record<string, MainAlign> = {
    start: "start", min: "start", "flex-start": "start",
    center: "center", middle: "center",
    end: "end", max: "end", "flex-end": "end",
    between: "between", "space-between": "between",
  };
  const main = mainMap[str(pick(o, "main", "primaryAxisAlignItems", "justifyContent")).toLowerCase()];
  if (main && main !== "start") lo.main = main;
  const crossMap: Record<string, CrossAlign> = {
    start: "start", min: "start", "flex-start": "start",
    center: "center", middle: "center",
    end: "end", max: "end", "flex-end": "end",
    stretch: "stretch", fill: "stretch",
  };
  const cross = crossMap[str(pick(o, "cross", "counterAxisAlignItems", "alignItems")).toLowerCase()];
  if (cross && cross !== "start") lo.cross = cross;
  if (o.wrap === true || o.wrap === "true") lo.wrap = true;
  const hugRaw = str(pick(o, "hug", "sizing")).toLowerCase();
  const hugMap: Record<string, "main" | "cross" | "both" | undefined> = {
    main: "main", cross: "cross", both: "both", all: "both",
    none: undefined, fixed: undefined, "": undefined,
  };
  const hug = hugMap[hugRaw];
  if (hug) lo.hug = hug;
  return lo;
}

/**
 * 实例覆盖表容错解析：{ 内部节点id: { 字段: 值 } }。
 * 结构性字段（id/type/children/componentId/overrides）拒绝进覆盖——结构由主档定，覆盖只改样式/几何/文案。
 * 值本身信任 JSON 结构（来自同一文档），字段级合法性在合并渲染时由既有容错路径兜底。
 */
function parseOverrides(raw: unknown): Record<string, Record<string, unknown>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 300)) {
    if (!k.trim()) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const patch: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
      if (fk === "id" || fk === "type" || fk === "children" || fk === "componentId" || fk === "overrides") continue;
      if (fv === undefined) continue;
      patch[fk] = fv;
    }
    if (Object.keys(patch).length) out[k.trim().slice(0, 120)] = patch;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 组件主档表解析：id 在表内去重；节点 id 用独立 seen 集（内部寻址恒为 inst/inner 命名空间，不与页面冲突） */
function parseComponents(raw: unknown, warn?: ParseWarn): ComponentDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ComponentDef[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    let id = str(o.id).trim();
    if (!id) {
      warn?.("组件主档缺 id（已跳过）");
      continue;
    }
    if (seen.has(id)) id = uid("c");
    seen.add(id);
    const nodes = parseChildren(o.nodes ?? o.children, seen, warn);
    if (!nodes.length) {
      warn?.(`组件 "${id}" 主档为空（已跳过）`);
      continue;
    }
    out.push({ id, name: str(o.name, id).slice(0, 120), nodes });
    if (out.length >= 200) break;
  }
  return out.length ? out : undefined;
}

/** 解析尾程：w/h=0 哨兵（JSON 未显式给尺寸）→ 主档包围盒回填；坏引用维持下限尺寸走占位。
 *  主档内部也可能有实例（嵌套组件）→ 资产表同样要扫（漏了会把 0 哨兵带进视图，缩放系数连锁失真） */
function syncSentinelInstanceSizes(doc: DesignDoc): void {
  const list: DesignNode[] = [...walkDoc(doc)].map(({ node }) => node);
  for (const comp of doc.components ?? []) list.push(...walkNodes(comp.nodes));
  for (const node of list) {
    if (node.type !== "instance" || (node.w > 0 && node.h > 0)) continue;
    const b = resolveInstanceBounds(doc, node);
    if (node.w === 0) node.w = Math.max(1, b?.w ?? 100);
    if (node.h === 0) node.h = Math.max(1, b?.h ?? 100);
  }
}

function parseChildren(raw: unknown, seenIds: Set<string>, warn?: ParseWarn): DesignNode[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignNode[] = [];
  for (const c of raw) {
    const n = parseNode(c, seenIds, warn);
    if (n) out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

function parsePage(raw: unknown, seenIds: Set<string>, warn?: ParseWarn): Page | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  let id = str(o.id);
  if (!id || seenIds.has(id)) id = uid("p");
  seenIds.add(id);
  return { id, name: str(o.name, "页面").slice(0, 80), nodes: parseChildren(o.nodes, seenIds, warn) };
}

/** 容错解析入口：坏档绝不抛错，能救多少救多少 */
export function parseDesignDoc(json: string): ParseResult {
  const warnings: string[] = [];
  let raw: unknown;
  let fixes: string[] | undefined;
  try {
    raw = JSON.parse(json);
  } catch {
    // ② 手写 JSON 常见坏写法（围栏/注释/尾逗号/单引号/裸键/夹带说明/截断…）先修再解析
    const fixed = fixJsonText(json);
    if (!fixed.changed) return { doc: blankDoc(), warnings: ["JSON 无法解析"], fatal: true };
    try {
      raw = JSON.parse(fixed.text);
      fixes = fixed.fixes;
      warnings.push(`已自动修复 JSON：${fixed.fixes.join("、")}`);
    } catch {
      return { doc: blankDoc(), warnings: ["JSON 无法解析（自动修复后仍失败）"], fatal: true, fixes: fixed.fixes };
    }
  }
  if (typeof raw !== "object" || raw === null) return { doc: blankDoc(), warnings: ["文档不是对象"], fatal: true };
  const o = raw as Record<string, unknown>;
  const seenIds = new Set<string>();
  // 节点级容错提示归并（未知类型/未知图标…）：同类合并计数，避免刷屏
  const warnCounts = new Map<string, number>();
  const warn: ParseWarn = (msg) => warnCounts.set(msg, (warnCounts.get(msg) ?? 0) + 1);
  const meta = typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {};
  const pages: Page[] = [];
  if (Array.isArray(o.pages)) {
    for (const p of o.pages) {
      const page = parsePage(p, seenIds, warn);
      if (page) pages.push(page);
      if (pages.length >= 20) break;
    }
  }
  if (pages.length === 0) pages.push({ id: uid("p"), name: "页面 1", nodes: [] });
  let activePage = str(o.activePage);
  if (!pages.some((p) => p.id === activePage)) activePage = pages[0]!.id;
  const components = parseComponents(o.components, warn);
  const variables = parseVariables(o.variables, warn);
  for (const [msg, n] of warnCounts) warnings.push(n > 1 ? `${msg} ×${n}` : msg);
  const doc: DesignDoc = {
    version: DOC_VERSION,
    meta: { name: str(meta.name, "UI 设计").slice(0, 120) || "UI 设计", kind: "uidesign" },
    activePage,
    pages,
    ...(components ? { components } : {}),
    ...(variables ? { variables } : {}),
  };
  syncSentinelInstanceSizes(doc);
  // 引用完整性提示：实例指向不存在的主档 → 渲染为占位框（不丢弃，修好引用即恢复）
  if (components) {
    const ids = new Set(components.map((c) => c.id));
    const missing = new Set<string>();
    for (const { node } of walkDoc(doc))
      if (node.type === "instance" && node.componentId && !ids.has(node.componentId)) missing.add(node.componentId);
    for (const m of [...missing].slice(0, 8)) warnings.push(`实例引用了不存在的组件 "${m.slice(0, 40)}"（显示占位框）`);
  }
  if (variables) {
    const ids = new Set(variables.map((v) => v.id));
    const missing = [...collectVarRefs(doc).keys()].filter((id) => !ids.has(id)).slice(0, 8);
    for (const m of missing) warnings.push(`颜色引用了未定义的变量 "var:${m}"（显示为警示粉）`);
  }
  return { doc, warnings, fatal: false, fixes };
}

export function serializeDoc(doc: DesignDoc): string {
  return JSON.stringify(doc, null, 2);
}

/* ---------------- 统计摘要（首页卡片用） ---------------- */

export type DocStats = { frames: number; nodes: number; previews: { x: number; y: number; w: number; h: number; bg: string }[] };

/** 当前页画板布局 + 全档节点数（宿主 listCanvasDocs 用同款规则，改这里记得同步） */
export function docStats(doc: DesignDoc): DocStats {
  const page = doc.pages.find((p) => p.id === doc.activePage) ?? doc.pages[0]!;
  let nodes = 0;
  for (const _ of walkDoc(doc)) nodes++;
  const previews: DocStats["previews"] = [];
  for (const n of page.nodes) {
    if (n.type !== "frame") continue;
    const first = n.fills.find((f) => f.type === "solid" && f.visible !== false);
    previews.push({ x: n.x, y: n.y, w: n.w, h: n.h, bg: resolveVarColor(doc, first?.color, "#ffffff") });
    if (previews.length >= 24) break;
  }
  return { frames: previews.length, nodes, previews };
}
