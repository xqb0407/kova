/**
 * 节点 → CSS 声明串（纯函数，检视器「代码」分区与复制用）。
 * 近似口径说明：
 *  - 多填充按 CSS 层序（首个声明画在最上，故数组反序输出）；渐变层的 fill.opacity 不并入
 *    （CSS 渐变无逐层 alpha，用 rgba 色标表达需改档，导出侧忽略）。
 *  - 描边只取第一条可见 stroke：center→border；inside→inset 环阴影；outside→外扩环阴影。
 *  - 椭圆 border-radius:50%；多角星/五边等 CSS 画不了真形，附注释提示改用 SVG 导出。
 *  - 投影/内投影/层模糊 → box-shadow / filter 逐条对应；层模糊与阴影互不冲突（不同属性）。
 *  - 文本取首 run 样式（多 run 富文本无法单块表达，附注释）。
 *  - 选择器 = 图层名 ASCII slug；纯中文/uuid 脸名退回类型名（.frame/.rect），原名以注释保留。
 */
import { radiusProp } from "./leafer/scene";
import { TYPE_LABELS, type DesignNode, type Fill, type Stroke } from "./doc";

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

function fillDecl(f: Fill): string | null {
  if (f.visible === false) return null;
  const op = f.opacity ?? 1;
  if (f.type === "solid") return withAlpha(f.color ?? "#000000", op);
  const stops = (f.stops ?? []).map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  if (!stops) return null;
  if (f.type === "linear") {
    // 档角度：顺时针、0=自上而下；CSS 0deg=自下而上 → css = 180 + θ
    return `linear-gradient(${((180 + (f.angle ?? 0)) % 360 + 360) % 360}deg, ${stops})`;
  }
  const cx = Math.round((f.center?.x ?? 0.5) * 100);
  const cy = Math.round((f.center?.y ?? 0.5) * 100);
  return `radial-gradient(circle at ${cx}% ${cy}%, ${stops})`;
}

function strokeRingAndBorder(s: Stroke): { border?: string; ring?: string } {
  const style = s.style === "dashed" ? "dashed" : s.style === "dotted" ? "dotted" : "solid";
  const w = px(s.width);
  if (s.align === "inside") return { ring: `inset 0 0 0 ${w} ${s.color}` };
  if (s.align === "outside") return { ring: `0 0 0 ${w} ${s.color}` };
  return { border: `${w} ${style} ${s.color}` };
}

/** 生成节点 CSS 声明行数组（不含选择器） */
export function nodeCssDecls(node: DesignNode): string[] {
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
  if (node.rotation) d.push(`transform: rotate(${Math.round(node.rotation * 100) / 100}deg);`);
  if (node.opacity !== undefined && node.opacity < 1) d.push(`opacity: ${node.opacity};`);

  // 背景（含画板底色）：数组反序 = CSS 层序（先声明画在最上）
  const shadows: string[] = [];
  let border: string | null = null;
  if ("fills" in node) {
    const layers = node.fills
      .map((f) => fillDecl(f))
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
      const r = strokeRingAndBorder(s);
      if (r.border) border = r.border;
      if (r.ring) shadows.push(r.ring);
    }
  }
  if (border) d.push(`border: ${border};`);
  for (const e of node.effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow") shadows.push(`${px(e.x)} ${px(e.y)} ${px(e.blur)} ${e.color}`);
    else if (e.type === "inner-shadow") shadows.push(`inset ${px(e.x)} ${px(e.y)} ${px(e.blur)} ${e.color}`);
    else d.push(`filter: blur(${px(e.blur)});`);
  }
  if (shadows.length) d.push(`box-shadow: ${shadows.join(", ")};`);

  if (node.type === "text") {
    const r = node.runs[0];
    if (r) {
      if (r.color) d.push(`color: ${r.color};`);
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

/** 完整 CSS 代码块（「代码」分区直接展示/复制） */
export function nodeToCss(node: DesignNode): string {
  const sel = cssSelectorOf(node);
  const slug = asciiSlug(node.name);
  const name = node.name.trim();
  // 选择器没能承载图层名（中文名被剥空/换类型、或名字被消毒改写过）时，注释保留原名；uuid 脸的名字不配出现
  const head = !looksUuid(slug, node.id) && name && name.toLowerCase() !== sel.slice(1) ? `/* ${name} */\n` : "";
  const decls = nodeCssDecls(node);
  return `${head}${sel} {\n${decls.map((l) => `  ${l}`).join("\n")}\n}`;
}
