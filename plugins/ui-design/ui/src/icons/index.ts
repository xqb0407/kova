/**
 * 内置图标库（lucide，ISC）：数据在 data.ts（scripts/gen-icons.mjs 生成，勿手改）。
 * 这里提供：名字归一/解析（含别名与容错）/搜索 / 渲染规格（24 栅格 → 节点盒）。
 * 面板画布（leafer/scene）、SVG 导出（svg.ts）、MCP 截图共用同一份渲染规格。
 */
import { ICONS, ICON_ALIASES } from "./data";

export const DEFAULT_ICON = "star";

/** 名字归一：去 lucide-/icon- 前缀、驼峰转 kebab、下划线/空格转 -、全小写 */
export function normalizeIconName(raw: string): string {
  return (raw || "")
    .trim()
    .replace(/^(lucide|icon)[-:_]/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

const COMPACT: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const n of Object.keys(ICONS)) m.set(n.replace(/-/g, ""), n);
  return m;
})();

/** 解析图标名：精确 → 别名（home→house）→ 去分隔符容错；未知名 null（调用方画占位） */
export function resolveIconName(raw: string): string | null {
  const key = normalizeIconName(raw);
  if (!key) return null;
  if (key in ICONS) return key;
  const alias = ICON_ALIASES[key];
  if (alias) return alias;
  return COMPACT.get(key.replace(/-/g, "")) ?? null;
}

const SORTED = Object.keys(ICONS).sort();

/** 搜索：精确 > 前缀 > 包含；别名命中折算到规范名去重；空 query 回字母序前 limit */
export function searchIcons(query: string, limit = 40): string[] {
  const q = normalizeIconName(query);
  if (!q) return SORTED.slice(0, limit);
  if (q in ICONS) return [q];
  if (q in ICON_ALIASES) return [ICON_ALIASES[q]!];
  const out: { n: string; s: number }[] = [];
  const seen = new Set<string>();
  for (const n of SORTED) {
    if (n.startsWith(q)) out.push({ n, s: 0 });
    else if (n.includes(q)) out.push({ n, s: 1 });
    else seen.add(n);
  }
  for (const [a, target] of Object.entries(ICON_ALIASES)) {
    if (seen.has(target)) continue;
    if (a.startsWith(q) || a.includes(q)) out.push({ n: target, s: a.startsWith(q) ? 0 : 1 });
  }
  return out
    .sort((x, y) => x.s - y.s || x.n.localeCompare(y.n))
    .slice(0, limit)
    .map((o) => o.n);
}

/** 图标名 → 合并 d 串；未知名 null */
export function iconD(name: string): string | null {
  const r = resolveIconName(name);
  return r ? (ICONS[r] ?? null) : null;
}

const r2 = (v: number): string => {
  const n = Math.round(v * 100) / 100;
  return Object.is(n, -0) ? "0" : String(n);
};

/**
 * SVG path 坐标变换（等比缩放 s + 平移 tx/ty）。覆盖全部命令：
 * 绝对坐标乘 s 加平移，相对增量只乘 s；A 弧的 rx/ry 同缩放、旋转与 flag 原样。
 */
export function transformPathD(d: string, s: number, tx: number, ty: number): string {
  if (!d) return d;
  if (s === 1 && tx === 0 && ty === 0) return d;
  const tokens = d.match(/[a-df-zA-DF-Z]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const counts: Record<string, number> = { m: 2, l: 2, t: 2, c: 6, s: 4, q: 4, a: 7, h: 1, v: 1 };
  const X = (v: number) => r2(v * s + tx);
  const Y = (v: number) => r2(v * s + ty);
  const dx = (v: number) => r2(v * s);
  let out = "";
  let i = 0;
  let cmd = "";
  const pair = (rel: boolean, x: number, y: number) => (rel ? `${dx(x)} ${dx(y)}` : `${X(x)} ${Y(y)}`);
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd.toLowerCase() === "z") {
        out += cmd;
        continue;
      }
    }
    const lower = cmd.toLowerCase();
    const n = counts[lower];
    if (!n) {
      i++; // 防御：未知命令丢弃 token
      continue;
    }
    // 小写命令 = 相对坐标；大写 = 绝对
  const rel = cmd === lower;
    const vals: number[] = [];
    let guard = 0;
    while (vals.length < n && i < tokens.length && guard++ < 64) {
      const t2 = tokens[i]!;
      if (/^[a-zA-Z]$/.test(t2)) break;
      const v = Number(t2);
      vals.push(Number.isFinite(v) ? v : 0);
      i++;
    }
    if (vals.length < n) break;
    switch (lower) {
      case "m":
      case "l":
      case "t":
        out += `${cmd}${pair(rel, vals[0]!, vals[1]!)}`;
        break;
      case "c":
        out += `${cmd}${pair(rel, vals[0]!, vals[1]!)} ${pair(rel, vals[2]!, vals[3]!)} ${pair(rel, vals[4]!, vals[5]!)}`;
        break;
      case "s":
      case "q":
        out += `${cmd}${pair(rel, vals[0]!, vals[1]!)} ${pair(rel, vals[2]!, vals[3]!)}`;
        break;
      case "a":
        out += `${cmd}${dx(vals[0]!)} ${dx(vals[1]!)} ${r2(vals[2]!)} ${vals[3]} ${vals[4]} ${pair(rel, vals[5]!, vals[6]!)}`;
        break;
      case "h":
        out += `${cmd}${rel ? dx(vals[0]!) : X(vals[0]!)}`;
        break;
      case "v":
        out += `${cmd}${rel ? dx(vals[0]!) : Y(vals[0]!)}`;
        break;
    }
  }
  return out;
}

/** 图标绘制规格：24 栅格等比缩放居中到盒内（短边贴合），stroke 宽按同比例换算成绝对值 */
export function iconDrawSpec(
  icon: string,
  w: number,
  h: number,
  strokeWidth: number,
): { d: string; sw: number } | null {
  const d0 = iconD(icon);
  if (!d0 || !(w > 0) || !(h > 0)) return null;
  const s = Math.min(w, h) / 24;
  return {
    d: transformPathD(d0, s, (w - 24 * s) / 2, (h - 24 * s) / 2),
    sw: Math.max(0.5, strokeWidth * s),
  };
}
