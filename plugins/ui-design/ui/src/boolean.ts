/**
 * 布尔运算（并集/减去/交集/排除）—— 参数化形状与全直线 vector 节点 → 多边形 →
 * polygon-clipping（MIT）→ 合并后的 SVG path d。
 *
 * v1 约束：
 *  - 参与运算的节点必须同容器同层（与 group_nodes 一致），坐标折算到该容器局部系
 *  - 支持 rect/ellipse/triangle/diamond/pentagon/hexagon/star + 全直线 vector；
 *    含曲线（C/S/Q/T/A）的 vector 暂不支持（抛可读错误）
 *  - 减法语义 = 数组第一个节点（最底层）减去其余
 *  - 结果是「烤平」的矢量路径（vector 节点），不是实时布尔组（Figma 的 live boolean 后续再说）
 */
import { union as clipUnion, difference as clipDiff, intersection as clipIntersect, xor as clipXor } from "polygon-clipping";
import { shapePath } from "./leafer/scene";
import { radiusProp, } from "./leafer/scene";
import type { DesignNode } from "./doc";

export const BOOL_OPS = ["union", "subtract", "intersect", "exclude"] as const;
export type BooleanOp = (typeof BOOL_OPS)[number];

/** 运算别名归一（merge/add/join→union，minus/cut→subtract，xor→exclude） */
export function normalizeBoolOp(raw: unknown): BooleanOp | null {
  const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const map: Record<string, BooleanOp> = {
    union: "union", merge: "union", add: "union", join: "union", unite: "union",
    subtract: "subtract", minus: "subtract", cut: "subtract", difference: "subtract",
    intersect: "intersect", intersection: "intersect",
    exclude: "exclude", xor: "exclude",
  };
  return map[t] ?? null;
}

/** 参与布尔的节点类型（text/image/icon/frame/group 不行） */
export function isBoolShape(node: DesignNode): boolean {
  return (
    node.type === "rect" || node.type === "ellipse" || node.type === "triangle" ||
    node.type === "diamond" || node.type === "pentagon" || node.type === "hexagon" ||
    node.type === "star" || node.type === "vector"
  );
}

type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[];

const r2 = (v: number): number => Math.round(v * 100) / 100;

/* ---------------- 形状 → 环（节点局部系，0..w/h） ---------------- */

/** 圆角矩形（角弧各 5 段近似） */
function roundedRectRing(w: number, h: number, radius: number | number[] | undefined): Ring {
  const r4 = typeof radius === "number"
    ? [radius, radius, radius, radius]
    : Array.isArray(radius) ? radius : [0, 0, 0, 0];
  const [tl, tr, br, bl] = r4.map((v) => Math.max(0, Math.min(v ?? 0, w / 2, h / 2)));
  const ring: Ring = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const seg = 5;
    for (let i = 0; i <= seg; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  if (tl <= 0) ring.push([0, 0]);
  else arc(tl, tl, tl, Math.PI, Math.PI * 1.5);
  if (tr <= 0) ring.push([w, 0]);
  else arc(w - tr, tr, tr, Math.PI * 1.5, Math.PI * 2);
  if (br <= 0) ring.push([w, h]);
  else arc(w - br, h - br, br, 0, Math.PI * 0.5);
  if (bl <= 0) ring.push([0, h]);
  else arc(bl, h - bl, bl, Math.PI * 0.5, Math.PI);
  // 去重相邻重复点
  return ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1]![0], p[1] - ring[i - 1]![1]) > 1e-6);
}

function ellipseRing(w: number, h: number, seg = 64): Ring {
  const ring: Ring = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    ring.push([(w / 2) * (1 + Math.cos(a)), (h / 2) * (1 + Math.sin(a))]);
  }
  return ring;
}

/** 解析全直线 path d（M/L/H/V/Z；含曲线抛错）→ 环（按 Z 切分） */
export function pathDRings(d: string): Ring[] {
  // 字符类排除 e/E（科学计数法归数字）；曲线命令 C/S/Q/T/A 必须被捕获并抛错
  const tokens = d.match(/[A-DF-Za-df-z]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const rings: Ring[] = [];
  let cur: Ring = [];
  let cx = 0;
  let cy = 0;
  let cmd = "";
  let i = 0;
  const num = (): number => {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) throw new Error(`布尔运算暂不支持曲线路径（含 "${t}"），只支持直线段`);
    i++;
    return Number(t);
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        if (cur.length) rings.push(cur);
        cur = [];
        continue;
      }
    }
    const lower = cmd.toLowerCase();
    const rel = cmd === lower; // 小写 = 相对坐标
    switch (lower) {
      case "m":
      case "l": {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        if (lower === "m" && cur.length) {
          rings.push(cur);
          cur = [];
        }
        cur.push([x, y]);
        cx = x;
        cy = y;
        // SVG 规范：M 后的隐式续对是 lineto（不是新的 moveto）
        if (lower === "m") cmd = rel ? "l" : "L";
        break;
      }
      case "h": {
        let x = num();
        if (rel) x += cx;
        cur.push([x, cy]);
        cx = x;
        break;
      }
      case "v": {
        let y = num();
        if (rel) y += cy;
        cur.push([cx, y]);
        cy = y;
        break;
      }
      default:
        throw new Error(`布尔运算暂不支持曲线路径（含 "${cmd}"），只支持直线段`);
    }
  }
  if (cur.length) rings.push(cur);
  return rings.filter((r) => r.length >= 3);
}

/** 节点几何 → 多边形（已折算到父容器局部坐标：旋转绕盒中心 + 平移 x/y） */
function nodeToPolys(node: DesignNode): Poly {
  let local: Ring[];
  if (node.type === "rect") {
    local = [roundedRectRing(node.w, node.h, radiusProp(node))];
  } else if (node.type === "ellipse") {
    local = [ellipseRing(node.w, node.h)];
  } else if (node.type === "vector") {
    local = pathDRings(node.path);
  } else {
    const d = shapePath(node.type, node.w, node.h);
    if (!d) throw new Error(`节点类型 ${node.type} 不支持布尔运算`);
    local = pathDRings(d);
  }
  const a = ((node.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = node.w / 2;
  const cy = node.h / 2;
  const place = (ring: Ring): Ring =>
    ring.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      return [r2(node.x + cx + dx * cos - dy * sin), r2(node.y + cy + dx * sin + dy * cos)] as Pt;
    });
  return local.map(place);
}

/* ---------------- 主入口 ---------------- */

export type BoolResult = { d: string; bbox: { x: number; y: number; w: number; h: number } };

/** N 个同容器形状 → 布尔结果的 path d 与包围盒（空结果返回 d:""） */
export function booleanPath(op: BooleanOp, nodes: DesignNode[]): BoolResult {
  if (nodes.length === 0) throw new Error("布尔运算需要至少一个形状");
  const polys = nodes.map(nodeToPolys);
  let result: Poly[];
  try {
    if (op === "union") {
      result = clipUnion(polys[0]!, ...polys.slice(1)) as Poly[];
    } else if (op === "subtract") {
      result = clipDiff(polys[0]!, ...polys.slice(1)) as Poly[];
    } else if (op === "intersect") {
      result = clipIntersect(polys[0]!, ...polys.slice(1)) as unknown as Poly[];
    } else {
      // xor 逐对折叠（多形状异或）
      let acc: Poly = polys[0]!;
      for (const p of polys.slice(1)) {
        acc = clipXor(acc, p) as unknown as Poly;
      }
      result = acc as unknown as Poly[];
    }
  } catch (err) {
    throw new Error(`布尔运算失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const pts: Pt[] = [];
  for (const poly of result) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      pts.push(...ring);
    }
  }
  if (!pts.length) return { d: "", bbox: { x: 0, y: 0, w: 0, h: 0 } };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // 结果按包围盒归零：vector.path 约定是节点局部坐标（渲染时节点自带 x/y 平移，不能双算）
  let d = "";
  for (const poly of result) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      d += `M${r2(ring[0]![0] - x)} ${r2(ring[0]![1] - y)}`;
      for (let i = 1; i < ring.length; i++) d += `L${r2(ring[i]![0] - x)} ${r2(ring[i]![1] - y)}`;
      d += "Z";
    }
  }
  return { d, bbox: { x: r2(x), y: r2(y), w: r2(Math.max(...xs) - x), h: r2(Math.max(...ys) - y) } };
}
