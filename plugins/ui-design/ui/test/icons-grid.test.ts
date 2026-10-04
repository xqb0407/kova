/**
 * 图标栅格回归（battery 贴边事故）：gen-icons.mjs 曾把 rect 的 x+rx 字符串拼接
 * （"2"+"2"="22"）→ 电池主体整体右移出格；又把以小写 m 开头的独立 <path> 直接串接
 * → 首笔以"上一段终点"为基准错位。渲染端按 24 栅格等比缩放居中，路径出格 = 图标贴边/出画板。
 * 本测试对全部 ICONS 做笔迹追踪（弧段 flag 感知），断言落笔点都在 24 栅格内。
 */
import { describe, expect, test } from "bun:test";
import { ICONS } from "../src/icons/data";

/** SVG path 笔迹落点（只含终点，不含控制点/弧参数；A 的 laf/sf 按单字符消费） */
function penPoints(d: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let i = 0;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  const skipWs = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const num = (): number | null => {
    skipWs();
    const m = /^[-+]?(?:\d*\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = (): number | null => {
    skipWs();
    const c = d[i];
    if (c === "0" || c === "1") {
      i++;
      return Number(c);
    }
    return null;
  };
  while (i < d.length) {
    skipWs();
    if (i >= d.length) break;
    const c = d[i]!;
    if (/[a-zA-Z]/.test(c)) {
      cmd = c;
      i++;
    }
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    if (lower === "z") {
      x = sx;
      y = sy;
      continue;
    }
    if (lower === "m" || lower === "l" || lower === "t") {
      const a = num();
      const b = num();
      if (a === null || b === null) break;
      x = rel ? x + a : a;
      y = rel ? y + b : b;
      pts.push([x, y]);
      if (lower === "m") {
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
      }
    } else if (lower === "h" || lower === "v") {
      const a = num();
      if (a === null) break;
      if (lower === "h") x = rel ? x + a : a;
      else y = rel ? y + a : a;
      pts.push([x, y]);
    } else if (lower === "c") {
      const p: number[] = [];
      for (let k = 0; k < 6; k++) {
        const v = num();
        if (v === null) break;
        p.push(v);
      }
      if (p.length < 6) break;
      x = rel ? x + p[4]! : p[4]!;
      y = rel ? y + p[5]! : p[5]!;
      pts.push([x, y]);
    } else if (lower === "s" || lower === "q") {
      const p: number[] = [];
      for (let k = 0; k < 4; k++) {
        const v = num();
        if (v === null) break;
        p.push(v);
      }
      if (p.length < 4) break;
      x = rel ? x + p[2]! : p[2]!;
      y = rel ? y + p[3]! : p[3]!;
      pts.push([x, y]);
    } else if (lower === "a") {
      if (num() === null || num() === null || num() === null) break;
      if (flag() === null || flag() === null) break;
      const a = num();
      const b = num();
      if (a === null || b === null) break;
      x = rel ? x + a : a;
      y = rel ? y + b : b;
      pts.push([x, y]);
    } else break;
  }
  return pts;
}

describe("图标 24 栅格", () => {
  test("全部图标笔迹落点在栅格内（±1.5 容差）", () => {
    const bad: string[] = [];
    for (const [name, d] of Object.entries(ICONS)) {
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      for (const [px, py] of penPoints(d)) {
        if (px < minx) minx = px;
        if (px > maxx) maxx = px;
        if (py < miny) miny = py;
        if (py > maxy) maxy = py;
      }
      if (minx < -1.5 || miny < -1.5 || maxx > 25.5 || maxy > 25.5) {
        bad.push(`${name}: x[${minx},${maxx}] y[${miny},${maxy}]`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("battery 主体在格内（事故图标点名回归）", () => {
    const pts = penPoints(ICONS["battery-full"]!);
    const xs = pts.map((p) => p[0]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(22.01); // 桩在 x=22，主体 ≤20
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2);
  });
});
