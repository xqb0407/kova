/**
 * 节点 → CSS 声明串（纯函数，检视器「代码」分区与复制用）。
 * 近似口径说明：
 *  - 多填充按 CSS 层序（首个声明画在最上，故数组反序输出）；渐变层的 fill.opacity 不并入
 *    （CSS 渐变无逐层 alpha，用 rgba 色标表达需改档，导出侧忽略）。
 *  - 描边只取第一条可见 stroke：center→border；inside→inset 环阴影；outside→外扩环阴影。
 *  - 椭圆 border-radius:50%；多角星/五边等 CSS 画不了真形，附注释提示改用 SVG 导出。
 *  - 投影/内投影 → box-shadow；层模糊（毛玻璃口径）→ backdrop-filter（含 -webkit 前缀）。
 *  - 文本取首 run 样式（多 run 富文本无法单块表达，附注释）。
 *  - 选择器 = 图层名 ASCII slug；纯中文/uuid 脸名退回类型名（.frame/.rect），原名以注释保留。
 */
import { radiusProp } from "./leafer/scene";
import {
  TYPE_LABELS,
  bakeInstanceNodes,
  resolveVarColor,
  type DesignDoc,
  type DesignNode,
  type Fill,
  type InstanceNode,
  type Stroke,
} from "./doc";

const px = (v: number): string => `${Math.round(v * 100) / 100}px`;

/** #hex(3/6/8) → rgba() 串（opacity<1 时用）；解析失败原样返回 */
export function withAlpha(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  let m = /^#([0-9a-fA-F]{3})$/.exec(color);
  if (m) color = `#${m[1]!.split("").map((c) => c + c).join("")}`;
  m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
  if (!m) return color;
  const r = parseInt(m[1]!.slice(0, 2), 16);
  const g = parseInt(m[1]!.slice(2, 4), 16);
  const b = parseInt(m[1]!.slice(4, 6), 16);
  const a = Math.round(opacity * 100) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function fillDecl(f: Fill, doc?: DesignDoc): string | null {
  if (f.visible === false) return null;
  const op = f.opacity ?? 1;
  if (f.type === "image") {
    if (!f.src) return null;
    // CSS 口径：cover/contain/100% 100%（拉伸）；工作区相对路径随 HTML 原型/工程包同目录可用
    const size = f.scaleMode === "fit" ? "contain" : f.scaleMode === "stretch" ? "100% 100%" : "cover";
    return `url("${f.src}") center / ${size} no-repeat`;
  }
  if (f.type === "solid") return withAlpha(resolveVarColor(doc, f.color), op);
  const stops = (f.stops ?? []).map((s) => `${resolveVarColor(doc, s.color)} ${Math.round(s.at * 100)}%`).join(", ");
  if (!stops) return null;
  if (f.type === "linear") {
    // 档角度：顺时针、0=自上而下；CSS 0deg=自下而上 → css = 180 + θ
    return `linear-gradient(${((180 + (f.angle ?? 0)) % 360 + 360) % 360}deg, ${stops})`;
  }
  const cx = Math.round((f.center?.x ?? 0.5) * 100);
  const cy = Math.round((f.center?.y ?? 0.5) * 100);
  return `radial-gradient(circle at ${cx}% ${cy}%, ${stops})`;
}

function strokeRingAndBorder(s: Stroke, doc?: DesignDoc): { border?: string; ring?: string } {
  const style = s.style === "dashed" ? "dashed" : s.style === "dotted" ? "dotted" : "solid";
  const w = px(s.width);
  const color = resolveVarColor(doc, s.color);
  if (s.align === "inside") return { ring: `inset 0 0 0 ${w} ${color}` };
  if (s.align === "outside") return { ring: `0 0 0 ${w} ${color}` };
  return { border: `${w} ${style} ${color}` };
}

/** 生成节点 CSS 声明行数组（不含选择器） */
export function nodeCssDecls(node: DesignNode, doc?: DesignDoc): string[] {
  const d: string[] = [];
  d.push(`position: absolute;`, `left: ${px(node.x)};`, `top: ${px(node.y)};`);
  d.push(`width: ${px(node.w)};`, `height: ${px(node.h)};`);
  if (node.type === "ellipse") d.push(`border-radius: 50%;`);
  else {
    const rad = radiusProp(node);
    if (typeof rad === "number") {
      if (rad > 0) d.push(`border-radius: ${px(rad)};`);
    } else if (Array.isArray(rad)) {
      if (rad.some((v) => v > 0)) d.push(`border-radius: ${rad.map(px).join(" ")};`);
    }
  }
  if (node.type === "vector") d.push(`clip-path: path("${node.path}");`);
  if (node.rotation) d.push(`transform: rotate(${Math.round(node.rotation * 100) / 100}deg);`);
  if (node.flipX && node.flipY) d.push(`transform: scale(-1, -1);`);
  else if (node.flipX) d.push(`transform: scaleX(-1);`);
  else if (node.flipY) d.push(`transform: scaleY(-1);`);
  if (node.blendMode) d.push(`mix-blend-mode: ${node.blendMode};`);
  if (node.opacity !== undefined && node.opacity < 1) d.push(`opacity: ${node.opacity};`);

  // 背景（含画板底色）：数组反序 = CSS 层序（先声明画在最上）
  const shadows: string[] = [];
  let border: string | null = null;
  if ("fills" in node) {
    const layers = node.fills
      .map((f) => fillDecl(f, doc))
      .filter((x): x is string => !!x)
      .reverse();
    if (node.type === "frame") {
      // 画板不裁切时 CSS 表达不了 overflow 语义差异，统一 hidden 最贴近视觉
      d.push(`overflow: ${node.clip === false ? "visible" : "hidden"};`);
    }
    if (layers.length === 1) d.push(`background: ${layers[0]};`);
    else if (layers.length > 1) d.push(`background: ${layers.join(", ")};`);
    else if (node.type === "frame") d.push(`background: transparent;`);
  }
  if ("strokes" in node && node.strokes) {
    const s = node.strokes.find((x) => x.visible !== false && x.width > 0);
    if (s) {
      const r = strokeRingAndBorder(s, doc);
      if (r.border) border = r.border;
      if (r.ring) shadows.push(r.ring);
    }
  }
  if (border) d.push(`border: ${border};`);
  for (const e of node.effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow") shadows.push(`${px(e.x)} ${px(e.y)} ${px(e.blur)} ${resolveVarColor(doc, e.color)}`);
    else if (e.type === "inner-shadow") shadows.push(`inset ${px(e.x)} ${px(e.y)} ${px(e.blur)} ${resolveVarColor(doc, e.color)}`);
    else {
      // layer-blur 在档内当 iOS 毛玻璃（背景模糊）用：CSS 正确表达是 backdrop-filter；
      // filter:blur 会糊掉元素自身（含文字），复制走必翻车。画布/导出侧均不渲染该模糊。
      d.push(`-webkit-backdrop-filter: blur(${px(e.blur)});`);
      d.push(`backdrop-filter: blur(${px(e.blur)});`);
    }
  }
  if (shadows.length) d.push(`box-shadow: ${shadows.join(", ")};`);

  if (node.type === "text") {
    const r = node.runs[0];
    if (r) {
      if (r.color) d.push(`color: ${resolveVarColor(doc, r.color)};`);
      if (r.size) d.push(`font-size: ${px(r.size)};`);
      if (r.weight && r.weight !== 400) d.push(`font-weight: ${r.weight};`);
      if (r.italic) d.push(`font-style: italic;`);
      if (r.underline) d.push(`text-decoration: underline;`);
      if (r.font) d.push(`font-family: "${r.font}";`);
    }
    d.push(`line-height: ${(node.lineHeight ?? 1.4)};`);
    if (node.letterSpacing) d.push(`letter-spacing: ${px(node.letterSpacing)};`);
    d.push(`text-align: ${node.align ?? "left"};`);
    if (node.runs.length > 1) d.push(`/* 富文本含 ${node.runs.length} 段样式，此处取首段 */`);
  }
  if (node.type === "image") {
    const fit = node.fit === "contain" ? "contain" : node.fit === "stretch" ? "100% 100%" : "cover";
    d.push(`background-image: url("${node.src}");`, `background-size: ${fit};`, `background-position: center;`);
  }
  if (node.type === "line" || node.type === "arrow") d.push(`/* ${TYPE_LABELS[node.type]}：请用 SVG 导出获取矢量 */`);
  if (["triangle", "diamond", "pentagon", "hexagon", "star"].includes(node.type))
    d.push(`/* ${TYPE_LABELS[node.type]}：CSS 无法精确表达，请用 SVG 导出 */`);
  return d;
}

/** 名字 → ASCII slug（小写、非字母数字转连字符）；中文名会被剥空 */
function asciiSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * uuid 脸判定：slug 即节点 id，或「长 8+ 位、数字 ≥4、最长连续字母 ≤3」
 * （uid() 产出的 base36 时间戳正是这种形态；"card2024" 这类正常命名不受影响）
 */
function looksUuid(slug: string, id: string): boolean {
  if (!slug) return false;
  if (slug === id.toLowerCase()) return true;
  if (slug.length < 8) return false;
  const digits = (slug.match(/\d/g) ?? []).length;
  const maxRun = Math.max(...slug.split(/[^a-z]+/).map((w) => w.length));
  return digits >= 4 && maxRun <= 3;
}

/**
 * 选择器名：图层名的 ASCII slug；纯中文/无意义名（uuid 脸）退回类型名
 * （.frame/.rect…），原始图层名由 nodeToCss 以注释保留——选择器里绝不出现 uuid。
 */
export function cssSelectorOf(node: DesignNode): string {
  const slug = asciiSlug(node.name);
  if (slug && !looksUuid(slug, node.id)) return `.${slug}`;
  return `.${asciiSlug(node.type) || "node"}`;
}

/**
 * 实例节点本身没有可导出的样式字段（fills 等在解析视图里）：给 css/code 生成前
 * 先烤平成普通节点。单根视图 → 借实例的名字/位置/整体变换（选择器与实例身份一致）；
 * 多根 → 裹一层隐式 frame（实例盒即框）。主档缺失时原样返回（退化为空盒，不崩）。
 */
export function flattenForCss(node: DesignNode, doc?: DesignDoc): DesignNode {
  if (node.type !== "instance" || !doc) return node;
  const inst = node as InstanceNode;
  const baked = bakeInstanceNodes(doc, inst);
  if (!baked || baked.length === 0) return node;
  if (baked.length === 1) {
    const r = baked[0]!;
    return {
      ...r,
      id: inst.id,
      name: inst.name,
      x: inst.x,
      y: inst.y,
      ...(inst.rotation ? { rotation: (r.rotation ?? 0) + inst.rotation } : {}),
      ...(inst.opacity !== undefined ? { opacity: (r.opacity ?? 1) * inst.opacity } : {}),
    };
  }
  return {
    id: inst.id,
    type: "frame",
    name: inst.name,
    x: inst.x,
    y: inst.y,
    w: inst.w,
    h: inst.h,
    ...(inst.rotation ? { rotation: inst.rotation } : {}),
    ...(inst.opacity !== undefined ? { opacity: inst.opacity } : {}),
    clip: false,
    fills: [],
    strokes: [],
    children: baked,
  } as unknown as DesignNode;
}

/** 完整 CSS 代码块（「代码」分区直接展示/复制） */
export function nodeToCss(node: DesignNode, doc?: DesignDoc): string {
  node = flattenForCss(node, doc);
  const sel = cssSelectorOf(node);
  const slug = asciiSlug(node.name);
  const name = node.name.trim();
  // 选择器没能承载图层名（中文名被剥空/换类型、或名字被消毒改写过）时，注释保留原名；uuid 脸的名字不配出现
  const head = !looksUuid(slug, node.id) && name && name.toLowerCase() !== sel.slice(1) ? `/* ${name} */\n` : "";
  const decls = nodeCssDecls(node, doc);
  return `${head}${sel} {\n${decls.map((l) => `  ${l}`).join("\n")}\n}`;
}

/* ---------------- Dev Mode：SwiftUI / Jetpack Compose 代码生成 ---------------- */

export type CodeLang = "css" | "swiftui" | "compose";

/** hex（#rgb/#rrggbb/#rrggbbaa）→ 0..1 分量；无法解析返回 null */
function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  let s = (hex || "").trim();
  if (!s.startsWith("#")) return null;
  s = s.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 6) s = s + "ff"; // 统一成 RRGGBBAA 再解析
  if (s.length !== 8) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  const r = ((n >>> 24) & 255) / 255;
  const g = ((n >>> 16) & 255) / 255;
  const b = ((n >>> 8) & 255) / 255;
  const a = s.length === 8 ? (n & 255) / 255 : 1;
  return { r, g, b, a };
}

const swiftColor = (hex: string): string => {
  const c = hexToRgba(hex);
  if (!c) return ".clear";
  return c.a >= 1
    ? `Color(red: ${c.r.toFixed(3)}, green: ${c.g.toFixed(3)}, blue: ${c.b.toFixed(3)})`
    : `Color(red: ${c.r.toFixed(3)}, green: ${c.g.toFixed(3)}, blue: ${c.b.toFixed(3)}, opacity: ${c.a.toFixed(3)})`;
};

const composeColor = (hex: string): string => {
  const c = hexToRgba(hex);
  if (!c) return "Color.Transparent";
  const argb =
    Math.round(c.a * 255).toString(16).padStart(2, "0") +
    Math.round(c.r * 255).toString(16).padStart(2, "0") +
    Math.round(c.g * 255).toString(16).padStart(2, "0") +
    Math.round(c.b * 255).toString(16).padStart(2, "0");
  return `Color(0x${argb.toUpperCase()})`;
};

const BLEND_SWIFT: Record<string, string> = {
  multiply: ".multiply", screen: ".screen", overlay: ".overlay", darken: ".darken", lighten: ".lighten",
  "color-dodge": ".colorDodge", "color-burn": ".colorBurn", "hard-light": ".hardLight", "soft-light": ".softLight",
  difference: ".difference", exclusion: ".exclusion", hue: ".hue", saturation: ".saturation",
  color: ".color", luminosity: ".luminosity",
};

const BLEND_COMPOSE: Record<string, string> = {
  multiply: "BlendMode.Multiply", screen: "BlendMode.Screen", overlay: "BlendMode.Overlay",
  darken: "BlendMode.Darken", lighten: "BlendMode.Lighten", "color-dodge": "BlendMode.ColorDodge",
  "color-burn": "BlendMode.ColorBurn", "hard-light": "BlendMode.HardLight", "soft-light": "BlendMode.SoftLight",
  difference: "BlendMode.Difference", exclusion: "BlendMode.Exclusion", hue: "BlendMode.Hue",
  saturation: "BlendMode.Saturation", color: "BlendMode.Color", luminosity: "BlendMode.Luminosity",
};

const firstSolid = (node: DesignNode): string | null => {
  if (!("fills" in node)) return null;
  const f = (node.fills ?? []).find((x) => x.visible !== false);
  if (!f) return null;
  if (f.type === "solid") return f.color ?? null;
  return null; // 渐变 v1 不展开（CSS 侧已支持）
};

const fontWeightSwift = (w?: number): string =>
  (w ?? 400) >= 700 ? ".bold" : (w ?? 400) >= 600 ? ".semibold" : (w ?? 400) >= 500 ? ".medium" : ".regular";

/** 单节点 → 目标语言代码（属性级对齐 Figma Dev Mode 口径；widget 树不做翻译） */
export function nodeToCode(node: DesignNode, lang: CodeLang, doc?: DesignDoc): string {
  if (lang === "css" || lang === undefined) return nodeToCss(node, doc);
  node = flattenForCss(node, doc);
  const indent = "    ";
  const lines: string[] = [];
  const head = `// ${node.name}（${node.type}）`;

  if (lang === "swiftui") {
    lines.push(head);
    const isText = node.type === "text";
    if (isText) {
      const t = node as TextNodeOf;
      const text = t.runs.map((r) => r.text).join("");
      lines.push(`Text("${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200)}")`);
      const r0 = t.runs[0];
      lines.push(`${indent}.font(.system(size: ${r0?.size ?? 14}, weight: ${fontWeightSwift(r0?.weight)}))`);
      lines.push(`${indent}.foregroundColor(${swiftColor(r0?.color ?? "#111111")})`);
    } else {
      const shape = node.type === "ellipse" ? "Ellipse()" : node.radius ? `RoundedRectangle(cornerRadius: ${typeof node.radius === "number" ? node.radius : Math.max(...node.radius)})` : "Rectangle()";
      lines.push(shape);
      const solid = firstSolid(node);
      if (solid) lines.push(`${indent}.fill(${swiftColor(solid)})`);
      lines.push(`${indent}.frame(width: ${Math.round(node.w)}, height: ${Math.round(node.h)})`);
    }
    if (node.rotation) lines.push(`${indent}.rotationEffect(.degrees(${Math.round(node.rotation * 100) / 100}))`);
    if (node.flipX || node.flipY) lines.push(`${indent}.scaleEffect(x: ${node.flipX ? -1 : 1}, y: ${node.flipY ? -1 : 1})`);
    if (node.blendMode) lines.push(`${indent}.blendMode(${BLEND_SWIFT[node.blendMode] ?? ".normal"})`);
    if (node.opacity !== undefined && node.opacity < 1) lines.push(`${indent}.opacity(${node.opacity})`);
    for (const e of node.effects ?? []) {
      if (e.visible === false) continue;
      if (e.type === "layer-blur") lines.push(`${indent}.blur(radius: ${(e.blur ?? 0) / 2})`);
      else lines.push(`${indent}.shadow(color: ${swiftColor(e.color ?? "#000000")}, radius: ${(e.blur ?? 0) / 2}, x: ${e.x ?? 0}, y: ${e.y ?? 0})`);
    }
    return lines.join("\n");
  }

  // Compose
  lines.push(head);
  if (node.type === "text") {
    const t = node as TextNodeOf;
    const text = t.runs.map((r) => r.text).join("");
    const r0 = t.runs[0];
    lines.push(`Text("${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").slice(0, 200)}")`);
    lines.push(`${indent}fontSize = ${r0?.size ?? 14}.sp, fontWeight = ${(r0?.weight ?? 400) >= 600 ? "FontWeight.SemiBold" : "FontWeight.Normal"}, color = ${composeColor(r0?.color ?? "#111111")}`);
  } else {
    const solid = firstSolid(node);
    const shape = node.radius ? `RoundedCornerShape(${typeof node.radius === "number" ? node.radius : Math.max(...node.radius)}.dp)` : "RectangleShape";
    lines.push(`Box(modifier = Modifier`);
    lines.push(`${indent}.size(${Math.round(node.w)}.dp, ${Math.round(node.h)}.dp)`);
    if (solid) lines.push(`${indent}.background(${composeColor(solid)}, ${shape})`);
  }
  if (node.rotation) lines.push(`${indent}.graphicsLayer { rotationZ = ${Math.round(node.rotation * 100) / 100}f }`);
  if (node.flipX || node.flipY) lines.push(`${indent}.graphicsLayer { scaleX = ${node.flipX ? -1 : 1}f; scaleY = ${node.flipY ? -1 : 1}f }`);
  if (node.blendMode) lines.push(`${indent}.blendMode(${BLEND_COMPOSE[node.blendMode] ?? "BlendMode.Normal"})`);
  if (node.opacity !== undefined && node.opacity < 1) lines.push(`${indent}.alpha(${node.opacity}f)`);
  lines.push(`)`);
  return lines.join("\n");
}

/** TextNode 形状引用（避免循环 import 的轻量结构） */
type TextNodeOf = { type: "text"; runs: { text: string; size?: number; weight?: number; color?: string }[] } & DesignNode;
