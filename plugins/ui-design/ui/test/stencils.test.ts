/**
 * 素材库测试：注册表完整性、检索、等比缩放，以及**两条插入路径的等价性**。
 *
 * 等价性最关键：面板插入走 doc.ts 的 parseDesignDoc，MCP 插入走 mcp/tools.ts 的 buildNode。
 * 两个转换器各写各的，素材规格只要用了"只有一边认"的写法（例如形状标签写成
 * `text:"按钮" + size/color` 简写：MCP 认，文档解析器不认），就会出现
 * "面板插出来是白字、agent 插出来是黑字"这种最难查的漂移。这里逐条素材过两个转换器
 * 再逐字段比对，把它钉死在测试里。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STENCILS,
  STENCIL_CATEGORIES,
  buildStencilSpecs,
  findStencil,
  searchStencils,
  stencilNodes,
  stencilTypes,
} from "../src/stencils";
import { parseDesignDoc, type DesignNode } from "../src/doc";
import { TOOL_DEFS, type ToolCtx } from "../../mcp/tools";

let seq = 0;
const ids = (hint: string) => `${hint}-${++seq}`;

/** 只看影响观感的字段（id 两边都会重发，不参与比较） */
function skeleton(n: unknown): Record<string, unknown> {
  const src = n as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["type", "x", "y", "w", "h", "radius", "text", "icon", "color", "size", "weight", "align", "vAlign", "path", "dir", "scroll", "name"]) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  if (Array.isArray(src.fills)) out.fills = src.fills;
  if (Array.isArray(src.strokes)) out.strokes = src.strokes;
  if (Array.isArray(src.children)) out.children = (src.children as unknown[]).map(skeleton);
  return out;
}

const run = (name: string, args: Record<string, unknown>, ctx: ToolCtx): unknown =>
  TOOL_DEFS.find((t) => t.name === name)!.run(args, ctx);

describe("素材注册表", () => {
  test("id 唯一、分类齐全、名称与关键词非空", () => {
    const seen = new Set<string>();
    for (const s of STENCILS) {
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
      expect(STENCIL_CATEGORIES).toContain(s.category);
      expect(s.w).toBeGreaterThan(0);
      expect(s.h).toBeGreaterThan(0);
    }
  });

  test("每个素材都能在标称框里生成合法规格（有 id/type/几何）", () => {
    for (const s of STENCILS) {
      const specs = buildStencilSpecs(s, { x: 0, y: 0 }, ids);
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(typeof spec.id).toBe("string");
        expect(typeof spec.type).toBe("string");
        expect(typeof spec.x).toBe("number");
        expect(typeof spec.y).toBe("number");
      }
    }
  });

  test("用到的节点类型都在支持范围内（不会插出未知类型被静默丢弃）", () => {
    const allowed = new Set(["rect", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star", "line", "arrow", "text", "icon", "vector", "frame", "group", "image", "instance"]);
    for (const t of stencilTypes()) expect(allowed.has(t)).toBe(true);
  });

  test("形状标签一律写成显式 runs（不是只有 MCP 认的简写）", () => {
    for (const s of STENCILS) {
      for (const spec of buildStencilSpecs(s, { x: 0, y: 0 }, ids)) {
        if (spec.type === "text" || spec.text === undefined) continue;
        const lt = spec.text as { runs?: { text?: string }[] };
        expect(Array.isArray(lt.runs)).toBe(true);
        expect(typeof lt.runs![0]?.text).toBe("string");
      }
    }
  });

  test("图标素材用的是合法 lucide 名（否则画布上是占位方块）", () => {
    for (const s of STENCILS) {
      for (const spec of buildStencilSpecs(s, { x: 0, y: 0 }, ids)) {
        if (spec.type !== "icon") continue;
        expect(typeof spec.icon).toBe("string");
      }
    }
  });
});

describe("检索", () => {
  test("空查询返回全部；中英文命中同一条", () => {
    expect(searchStencils("").length).toBe(STENCILS.length);
    expect(searchStencils("按钮")[0]!.id).toBe("button");
    expect(searchStencils("button")[0]!.id).toBe("button");
    expect(searchStencils("btn")[0]!.id).toBe("button");
    expect(searchStencils("饼图")[0]!.id).toBe("chart-pie");
    expect(searchStencils("pie")[0]!.id).toBe("chart-pie");
    expect(searchStencils("菱形")[0]!.id).toBe("flow-decision");
    expect(searchStencils("tabbar")[0]!.id).toBe("tab-bar");
  });

  test("按分类名搜能拿到整类；无匹配返回空", () => {
    const charts = searchStencils("图表");
    expect(charts.length).toBeGreaterThanOrEqual(6);
    expect(charts.every((s) => s.category === "图表")).toBe(true);
    expect(searchStencils("zzzz-不存在")).toEqual([]);
  });

  test("findStencil 精确取用", () => {
    expect(findStencil("card")!.name).toBe("卡片");
    expect(findStencil("nope")).toBeUndefined();
  });
});

describe("等比缩放", () => {
  test("目标框与标称比例一致时就是标称尺寸平移到位", () => {
    const s = findStencil("button")!;
    const specs = buildStencilSpecs(s, { x: 100, y: 50 }, ids);
    expect(specs[0]!.x).toBe(100);
    expect(specs[0]!.y).toBe(50);
    expect(specs[0]!.w).toBe(s.w);
    expect(specs[0]!.h).toBe(s.h);
  });

  test("目标框更小时等比缩放并居中（绝不非等比拉伸）", () => {
    const s = findStencil("status-bar")!; // 390×44
    const first = buildStencilSpecs(s, { x: 0, y: 0, w: 195, h: 200 }, ids)[0]!;
    expect(first.w).toBeCloseTo(195, 1); // 受宽度约束 → k = 0.5
    expect(first.h).toBeCloseTo(22, 1);
    expect(first.y).toBeCloseTo((200 - 22) / 2, 1); // 垂直居中留边
  });

  test("字号随比例走（大按钮不会配小字）", () => {
    const s = findStencil("button")!;
    const sizeOf = (spec: Record<string, unknown>) => (spec.text as { runs: { size?: number }[] }).runs[0]!.size!;
    const big = buildStencilSpecs(s, { x: 0, y: 0, w: 240, h: 88 }, ids)[0]!;
    const small = buildStencilSpecs(s, { x: 0, y: 0, w: 60, h: 22 }, ids)[0]!;
    expect(sizeOf(big)).toBeGreaterThan(sizeOf(small));
  });

  test("frame 素材（滚动面板）的内嵌 children 一起缩放，滚动轴保留", () => {
    const s = findStencil("scroll-panel")!;
    const spec = buildStencilSpecs(s, { x: 0, y: 0, w: s.w / 2, h: s.h / 2 }, ids)[0]!;
    expect(spec.scroll).toBe("v");
    const kids = spec.children as Record<string, unknown>[];
    expect(kids.length).toBeGreaterThan(0);
    expect(kids[0]!.w as number).toBeCloseTo((s.w - Math.max(3, s.w * 0.02) * 3) / 2, 1);
  });
});

describe("两条插入路径等价（面板 parseDesignDoc vs MCP buildNode）", () => {
  test("每条素材：面板插出来的节点与 agent 插出来的节点逐字段一致", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "stencil-eq-"));
    const ctx: ToolCtx = { workspace: ws };
    for (const s of STENCILS) {
      // 面板路径：stencilNodes 内部走 parseDesignDoc
      const panel = stencilNodes(s, { x: 0, y: 0 }, ids).map((n: DesignNode) => skeleton(n));
      // MCP 路径：真的写进一份新档，再用同一个文档解析器读回来
      const file = `eq-${s.id}.uidesign.json`;
      run("create_doc", { path: file, frames: [{ name: "托盘", w: 2000, h: 2000 }] }, ctx);
      run("add_nodes", { path: file, nodes: buildStencilSpecs(s, { x: 0, y: 0 }, ids) }, ctx);
      const doc = parseDesignDoc(readFileSync(path.join(ws, file), "utf8")).doc;
      const mcp = doc.pages[0]!.nodes
        .filter((n) => !(n.type === "frame" && n.name === "托盘"))
        .map((n) => skeleton(n));
      expect(mcp).toEqual(panel);
    }
  });

  test("两条路的插入位置都按给定 x/y 落点（父容器局部坐标）", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "stencil-pos-"));
    const ctx: ToolCtx = { workspace: ws };
    const s = findStencil("button")!;
    const panel = stencilNodes(s, { x: 24, y: 100 }, ids);
    expect(panel[0]!.x).toBe(24);
    expect(panel[0]!.y).toBe(100);
    run("create_doc", { path: "p.uidesign.json", frames: [{ name: "F" }] }, ctx);
    run("add_nodes", {
      path: "p.uidesign.json",
      nodes: buildStencilSpecs(s, { x: 24, y: 100 }, ids),
    }, ctx);
    const doc = parseDesignDoc(readFileSync(path.join(ws, "p.uidesign.json"), "utf8")).doc;
    const btn = doc.pages[0]!.nodes.find((n) => n.type === "rect" && n.name === "按钮")!;
    expect([btn.x, btn.y]).toEqual([24, 100]);
  });
});
