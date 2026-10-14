/**
 * 从 node_modules/lucide-react 提取全部图标，生成 ui/src/icons/data.ts。
 * 每个图标的多元素（path/circle/rect/line/polyline/polygon）统一合并成一个
 * SVG path d 字符串（24×24 栅格、stroke 语义），渲染端零转换直接用。
 * 别名（home→house、user-2→user-round…）单独成表，查询时归一。
 * 用法：cd plugins/ui-design && bun run scripts/gen-icons.mjs
 */
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = path.resolve(import.meta.dirname, "..");
const ICONS_DIR = path.join(PLUGIN, "node_modules/lucide-react/dist/esm/icons");
const OUT = path.join(PLUGIN, "ui/src/icons/data.ts");

const r2 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 100) / 100);
};

/**
 * 元素 d 以相对 m 开头时的绝对化：独立 <path> 元素的起始笔位在 (0,0)，
 * "m6 6 12 12" = 移到 (6,6) 再相对画线。直接拼到别的片段后面会让首段 m
 * 以"上一段的终点"为基准整体错位（如 x 图标第二笔跑到 (24,36)）。
 * 转法：首 m→M（数值即绝对起点），其余隐式相对对用显式 l 承接，命令尾巴原样保留。
 */
function fixLeadingMove(d) {
  const t = d.trim();
  if (!/^m/.test(t)) return t;
  const toks = t.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 1;
  const nums = [];
  while (i < toks.length && !/^[a-zA-Z]$/.test(toks[i])) {
    nums.push(Number(toks[i]));
    i++;
  }
  if (nums.length < 2) return t;
  let out = `M${r2(nums[0])} ${r2(nums[1])}`;
  const rest = nums.slice(2);
  if (rest.length >= 2) out += "l" + rest.map((v) => r2(v)).join(" ");
  return out + " " + toks.slice(i).join(" ");
}

/** 单个 SVG 元素 → path d 片段（stroke 语义，闭合形状补 Z） */
function elementToD(tag, a) {
  const num = (k, d = 0) => r2(a?.[k] ?? d);
  switch (tag) {
    case "path":
      return fixLeadingMove(String(a.d ?? ""));
    case "circle": {
      const r = num("r");
      const cx = num("cx");
      const cy = num("cy");
      return `M${r2(cx - r)} ${cy}a${r} ${r} 0 1 0 ${r2(2 * r)} 0a${r} ${r} 0 1 0 ${r2(-2 * r)} 0`;
    }
    case "ellipse": {
      const rx = num("rx");
      const ry = num("ry", rx);
      const cx = num("cx");
      const cy = num("cy");
      return `M${r2(cx - rx)} ${cy}a${rx} ${ry} 0 1 0 ${r2(2 * rx)} 0a${rx} ${ry} 0 1 0 ${r2(-2 * rx)} 0`;
    }
    case "rect": {
      // 必须数值化：r2() 返回字符串，"x + rx" 会变字符串拼接（x=2,rx=2 → "22"），
      // 起点整体右移 → 圆角矩形类图标（battery/align-*/ad…）全部出 24 栅格
      const x = Number(a?.x ?? 0);
      const y = Number(a?.y ?? 0);
      const w = Number(a?.width ?? 0);
      const h = Number(a?.height ?? 0);
      const rx0 = a.rx !== undefined ? Number(a.rx) : a.ry !== undefined ? Number(a.ry) : 0;
      const ry0 = a.ry !== undefined ? Number(a.ry) : a.rx !== undefined ? Number(a.rx) : 0;
      const rx = Math.min(rx0, w / 2);
      const ry = Math.min(ry0, h / 2);
      if (!(rx > 0) || !(ry > 0)) return `M${r2(x)} ${r2(y)}h${r2(w)}v${r2(h)}h${r2(-w)}Z`;
      return (
        `M${r2(x + rx)} ${r2(y)}h${r2(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${rx} ${ry}` +
        `v${r2(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${-rx} ${ry}` +
        `h${r2(-(w - 2 * rx))}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}` +
        `v${r2(-(h - 2 * ry))}a${rx} ${ry} 0 0 1 ${rx} ${-ry}Z`
      );
    }
    case "line":
      return `M${num("x1")} ${num("y1")}L${num("x2")} ${num("y2")}`;
    case "polyline":
    case "polygon": {
      const pts = String(a.points ?? "")
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (pts.length < 4) return "";
      let d = `M${r2(pts[0])} ${r2(pts[1])}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${r2(pts[i])} ${r2(pts[i + 1])}`;
      return tag === "polygon" ? `${d}Z` : d;
    }
    default:
      return "";
  }
}

const kebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const icons = new Map(); // canonical name → d
const aliases = new Map(); // alias → canonical
let version = "unknown";

const files = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".mjs") && !f.endsWith(".mjs.map"));
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(ICONS_DIR, file)).href);
  const data = mod.__iconData;
  if (!data || typeof data.name !== "string") continue; // 纯 re-export 的别名文件
  version = mod.__iconData && file === `${data.name}.mjs` ? version : version;
  const parts = [];
  for (const [tag, attrs] of data.node ?? []) {
    const d = elementToD(tag, attrs ?? {});
    if (d) parts.push(d);
  }
  const d = parts.join("");
  if (!d) continue;
  const name = kebab(data.name);
  icons.set(name, d);
  for (const alias of data.aliases ?? []) {
    const a = kebab(String(alias));
    if (a && a !== name && !aliases.has(a)) aliases.set(a, name);
  }
}

// 别名不与规范名冲突（冲突时规范名优先）
for (const name of icons.keys()) aliases.delete(name);

const lines = [];
lines.push("/**");
lines.push(" * 由 scripts/gen-icons.mjs 从 node_modules/lucide-react 自动生成（lucide，ISC License）。");
lines.push(" * 勿手改。ICONS：规范名 → 合并后的 SVG path d（24×24 栅格，stroke 语义，fill:none）。");
lines.push(" * ICON_ALIASES：历史别名/简写 → 规范名（如 home→house）。");
lines.push(" */");
lines.push("");
lines.push("export const ICONS: Record<string, string> = {");
for (const [name, d] of [...icons.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`  "${name}": "${d.replace(/\\/g, "\\\\")}",`);
}
lines.push("};");
lines.push("");
lines.push("export const ICON_ALIASES: Record<string, string> = {");
for (const [a, n] of [...aliases.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
  lines.push(`  "${a}": "${n}",`);
}
lines.push("};");
lines.push("");
writeFileSync(OUT, lines.join("\n"));

const bytes = Buffer.byteLength(lines.join("\n"));
console.log(`icons: ${icons.size} 个规范名 + ${aliases.size} 个别名 → ${OUT}（${(bytes / 1024).toFixed(0)}KB）`);
