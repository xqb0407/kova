/**
 * CanvasDoc v3 模型测试：旧档（v1 slides / v2 frames）拍平迁移、容错解析（含 draw）、
 * 序列化往返、元素级解析白名单。
 */
import { describe, expect, test } from "bun:test";
import {
  blankDoc,
  CANVAS_ROOT,
  DEFAULT_TABLE_ROWS,
  DOC_VERSION,
  docKindOf,
  DRAW_MAX_POINTS,
  drawFromPoints,
  isDarkColor,
  drawNaturalBox,
  parseDoc,
  serializeDoc,
  uid,
  type ChartEl,
  type DrawEl,
  type ShapeEl,
  type TableEl,
} from "../src/doc";

const v2Doc = {
  version: 2,
  meta: { name: "旧文档", pagePreset: "16:9" },
  objects: [{ kind: "shape", id: "o1", shape: "rect", x: 500, y: 500, w: 50, h: 50, fill: "#0a84ff" }],
  frames: [
    { id: "a", x: 1000, y: 200, w: 1280, h: 720, background: "#ffffff", elements: [{ kind: "text", id: "t1", x: 10, y: 20, w: 100, h: 40, runs: ["你好"] }] },
    { id: "b", x: 0, y: 0, w: 1280, h: 720, background: "#111318", elements: [] },
  ],
};

describe("v2 frames → v3 拍平迁移", () => {
  test("页框元素平移为画布绝对坐标；objects 保留在前", () => {
    const doc = parseDoc(v2Doc)!;
    expect(doc.version).toBe(DOC_VERSION);
    expect(doc.meta).toEqual({ name: "旧文档" }); // pagePreset 随页面概念一起消失
    expect(doc.objects[0]!.id).toBe("o1");
    const t1 = doc.objects[1]!;
    expect([t1.x, t1.y]).toEqual([1000 + 10, 200 + 20]); // 页框偏移计入
    expect(doc.objects.length).toBe(3);
  });

  test("非白页框背景 → 同尺寸矩形保底色；白背景不补", () => {
    const doc = parseDoc(v2Doc)!;
    const bgRect = doc.objects.find((e) => e.id.startsWith("e") && e.kind === "shape" && (e as ShapeEl).fill === "#111318") as ShapeEl | undefined;
    expect(bgRect).toBeDefined();
    expect([bgRect!.x, bgRect!.y, bgRect!.w, bgRect!.h]).toEqual([0, 0, 1280, 720]);
    // 白页框（#ffffff）不产生底色块
    expect(doc.objects.filter((e) => e.kind === "shape" && (e as ShapeEl).fill === "#ffffff").length).toBe(0);
  });

  test("id 冲突时重发并重映射 startBind/groupId 引用", () => {
    const doc = parseDoc({
      version: 2,
      meta: { name: "x" },
      objects: [{ kind: "shape", id: "dup", shape: "rect", x: 0, y: 0, w: 10, h: 10 }],
      frames: [
        {
          id: "f", x: 0, y: 0, w: 100, h: 100, background: "#ffffff",
          elements: [
            { kind: "shape", id: "dup", shape: "rect", x: 20, y: 20, w: 10, h: 10 },
            { kind: "shape", id: "ln", shape: "arrow", x: 0, y: 0, w: 10, h: 10, startBind: "dup", endBind: "dup" },
            { kind: "text", id: "tx", x: 0, y: 0, w: 10, h: 10, runs: ["x"], groupId: "dup" },
          ],
        },
      ],
    })!;
    const ids = doc.objects.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // 全档唯一
    const ln = doc.objects.find((e) => e.id === "ln") as ShapeEl;
    const movedDup = doc.objects.find((e) => e.kind === "shape" && e.id !== "dup" && e.id !== "ln" && (e as ShapeEl).shape === "rect") as ShapeEl;
    expect(ln.startBind).toBe(movedDup.id); // 引用跟着重映射到新 id
    const tx = doc.objects.find((e) => e.id === "tx")!;
    expect(tx.groupId).toBe(movedDup.id);
  });

  test("迁移幂等：拍平后的 v3 文档再过 parseDoc 不变", () => {
    const once = parseDoc(v2Doc)!;
    const twice = parseDoc(JSON.parse(serializeDoc(once)))!;
    const thrice = parseDoc(JSON.parse(serializeDoc(twice)))!;
    expect(serializeDoc(thrice)).toBe(serializeDoc(twice)); // 解析产物键序规范化后稳定
  });
});

describe("v1 slides → v3 拍平", () => {
  test("slides 数组与 frames 同路拍平", () => {
    const doc = parseDoc({
      version: 1,
      meta: { name: "旧", pagePreset: "16:9" },
      slides: [
        { id: "a", x: 0, y: 0, w: 1280, h: 720, background: "#ffffff", elements: [{ kind: "text", id: "t1", x: 10, y: 20, w: 100, h: 40, runs: ["你好"] }] },
      ],
    })!;
    expect(doc.version).toBe(DOC_VERSION);
    expect(doc.objects.length).toBe(1);
    expect([doc.objects[0]!.x, doc.objects[0]!.y]).toEqual([10, 20]);
  });
});

describe("v3 解析", () => {
  test("objects 直入；缺省坐标落 0", () => {
    const doc = parseDoc({
      version: 3,
      meta: { name: "x" },
      objects: [{ kind: "shape", id: "o1", shape: "rect", x: 500, y: 500, w: 50, h: 50, fill: "#0a84ff" }],
    })!;
    expect(doc.objects[0]!.x).toBe(500);
    expect(doc.meta.name).toBe("x");
  });

  test("非文档 JSON → null", () => {
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc("string")).toBeNull();
    expect(parseDoc({})).toBeNull();
    expect(parseDoc({ slides: "no" })).toBeNull();
  });

  test("draw 解析：点集清洗、少于 2 点丢弃、粗细夹取、点数封顶", () => {
    const doc = parseDoc({
      objects: [
        { kind: "draw", id: "d1", x: 0, y: 0, w: 10, h: 10, points: [[0, 0], [5, 5], "junk", [1], [10, 10]] },
        { kind: "draw", id: "d2", points: [[1, 1]] },
        { kind: "draw", id: "d3", points: Array.from({ length: DRAW_MAX_POINTS + 500 }, (_, k) => [k % 9, k % 7]), strokeWidth: 999 },
      ],
    })!;
    expect(doc.objects.map((o) => o.id)).toEqual(["d1", "d3"]);
    const d1 = doc.objects[0] as DrawEl;
    expect(d1.points).toEqual([[0, 0], [5, 5], [10, 10]]);
    const d3 = doc.objects[1] as DrawEl;
    expect(d3.points.length).toBe(DRAW_MAX_POINTS);
    expect(d3.strokeWidth).toBe(40);
  });
});

describe("构造与序列化", () => {
  test("blankDoc 是合法 v3 空画布；序列化往返一致", () => {
    const doc = blankDoc("演示");
    expect(doc.version).toBe(DOC_VERSION);
    expect(doc.meta).toEqual({ name: "演示" });
    expect(doc.objects).toEqual([]);
    const round = parseDoc(JSON.parse(serializeDoc(doc)))!;
    expect(serializeDoc(round)).toBe(serializeDoc(doc));
  });

  test("CANVAS_ROOT 哨兵不与生成 id 冲突（uid 前缀均为小写字母+数字）", () => {
    expect(uid("e").startsWith(CANVAS_ROOT)).toBe(false);
  });
});

describe("drawFromPoints 笔迹提交", () => {
  test("包围盒归一：元素落最小点，点集相对包围盒 0.1px 取整", () => {
    const el = drawFromPoints([[350.26, 99.7], [120, 40.5], [400, 210.34]], { stroke: "#0a84ff", strokeWidth: 4 })!;
    expect(el.kind).toBe("draw");
    expect(el.x).toBeCloseTo(120, 6);
    expect(el.y).toBeCloseTo(40.5, 6);
    expect(el.w).toBeCloseTo(280, 6);
    expect(el.h).toBeCloseTo(169.8, 6);
    expect(el.points[0]).toEqual([230.3, 59.2]);
    expect(el.stroke).toBe("#0a84ff");
    expect(el.strokeWidth).toBe(4);
  });

  test("少于 2 点 → null；超上限均匀抽稀且保留末点", () => {
    expect(drawFromPoints([[0, 0]])).toBeNull();
    const many = Array.from({ length: DRAW_MAX_POINTS * 2 }, (_, i) => [i, i % 37] as [number, number]);
    const el = drawFromPoints(many)!;
    expect(el.points.length).toBe(DRAW_MAX_POINTS);
    // 抽稀后终点 = 原始终点（相对最小点 (0,0)）
    expect(el.points[el.points.length - 1]).toEqual([DRAW_MAX_POINTS * 2 - 1, (DRAW_MAX_POINTS * 2 - 1) % 37]);
  });

  test("自然点盒与元素盒解耦：resize 只改 w/h，点集不动、渲染仍拉伸贴合", () => {
    const el = drawFromPoints([[10, 10], [110, 60], [210, 10]])!;
    expect([drawNaturalBox(el).w, drawNaturalBox(el).h]).toEqual([200, 50]);
    expect([el.w, el.h]).toEqual([200, 50]); // 提交时自然盒=元素盒
    const resized = { ...el, w: 1000, h: 250 }; // 模拟手柄拉伸
    expect([drawNaturalBox(resized).w, drawNaturalBox(resized).h]).toEqual([200, 50]);
    const round = parseDoc(JSON.parse(serializeDoc({ version: DOC_VERSION, meta: { name: "t" }, objects: [resized] })))!;
    expect(round.objects[0]!.kind).toBe("draw"); // 拉伸态可序列化往返
  });
});

describe("table/chart/groupId/新形状解析", () => {
  const obj = (o: Record<string, unknown>) =>
    parseDoc({ version: DOC_VERSION, meta: { name: "x" }, objects: [o] })!;

  test("table：行清洗（截断 500）、colWidths 过滤非正数、header=false 落键、size 夹取", () => {
    const doc = obj({
      kind: "table", id: "t1", x: 0, y: 0, w: 300, h: 120,
      rows: [["列 A", "列 B"], ["x".repeat(600), 42], "junk"],
      colWidths: [2, 0, -1],
      header: false,
      size: 400,
    });
    const t = doc.objects[0] as TableEl;
    expect(t.rows).toEqual([["列 A", "列 B"], ["x".repeat(500), ""]]); // 非字符串单元格按空串容错
    expect(t.rows.length).toBeLessThanOrEqual(100);
    expect(t.colWidths).toEqual([2]);
    expect(t.header).toBe(false);
    expect(t.size).toBe(96);
  });

  test("table：空 rows 回退默认；header 缺省不落键；非色值丢弃", () => {
    const doc = obj({ kind: "table", id: "t2", x: 0, y: 0, w: 300, h: 120, rows: [], fill: "red" });
    const t = doc.objects[0] as TableEl;
    expect(t.rows).toEqual(DEFAULT_TABLE_ROWS);
    expect("header" in t).toBe(false);
    expect(t.fill).toBeUndefined();
  });

  test("chart：labels 去空、series 收 finite 数（空 data 丢弃）、kind 校验、colors 过滤、size 夹取", () => {
    const doc = obj({
      kind: "chart", id: "c1", x: 0, y: 0, w: 300, h: 200,
      labels: ["一", "", "三"],
      series: [{ name: "A", data: [1, "2", null, 3] }, { name: "B", data: [] }],
      chart: "pie",
      colors: ["#166534", "nope"],
      size: 1,
      showLegend: true,
    });
    const c = doc.objects[0] as ChartEl;
    expect(c.labels).toEqual(["一", "三"]);
    expect(c.series).toEqual([{ name: "A", data: [1, 2, 0, 3] }]); // null → Number("") = 0 容错收数
    expect(c.chart).toBe("pie");
    expect(c.colors).toEqual(["#166534"]);
    expect(c.size).toBe(6);
    expect(c.showLegend).toBe(true);
  });

  test("chart：labels 或 series 全空 → 元素丢弃", () => {
    const doc = obj({ kind: "chart", id: "c2", x: 0, y: 0, w: 300, h: 200, labels: [], series: [] });
    expect(doc.objects.length).toBe(0);
  });

  test("groupId：合法保留并截断 64；空白丢弃", () => {
    const long = "g".repeat(100);
    const doc = obj({ kind: "text", id: "a", x: 0, y: 0, w: 10, h: 10, runs: ["x"], groupId: long });
    expect(doc.objects[0]!.groupId).toBe("g".repeat(64));
    const doc2 = obj({ kind: "text", id: "b", x: 0, y: 0, w: 10, h: 10, runs: ["x"], groupId: "  " });
    expect(doc2.objects[0]!.groupId).toBeUndefined();
  });

  test("新形状与双头箭头 kind 全部通过解析", () => {
    for (const shape of ["rect", "diamond", "ellipse", "line", "arrow", "double-arrow", "triangle", "trapezoid", "pentagon", "hexagon", "star"]) {
      const doc = obj({ kind: "shape", id: "s", shape, x: 0, y: 0, w: 10, h: 10 });
      expect((doc.objects[0] as ShapeEl).shape).toBe(shape);
    }
  });

  test("线类 curve：夹取 [-1,1]、非法值丢弃；未知 shape 回退 rect", () => {
    const doc = obj({ kind: "shape", id: "s", shape: "arrow", x: 0, y: 0, w: 10, h: 10, curve: 5 });
    expect((doc.objects[0] as ShapeEl).curve).toBe(1);
    const doc2 = obj({ kind: "shape", id: "s", shape: "hexagon", x: 0, y: 0, w: 10, h: 10, curve: 0.5 });
    expect((doc2.objects[0] as ShapeEl).curve).toBe(0.5); // 解析层透传；渲染层自行忽略
    const doc3 = obj({ kind: "shape", id: "s", shape: "blob", x: 0, y: 0, w: 10, h: 10 });
    expect((doc3.objects[0] as ShapeEl).shape).toBe("rect");
  });

  test("旧 curve-arrow 载入迁移为 arrow + curve（缺省弧度 0.3 保留）", () => {
    const doc = obj({ kind: "shape", id: "s", shape: "curve-arrow", x: 0, y: 0, w: 10, h: 10 });
    const s = doc.objects[0] as ShapeEl;
    expect(s.shape).toBe("arrow");
    expect(s.curve).toBe(0.3);
  });
});

describe("route/label（线类正交与线上标签）", () => {
  const lineDoc = (o: Record<string, unknown>) =>
    parseDoc({ version: DOC_VERSION, meta: { name: "x" }, objects: [{ kind: "shape", id: "s", shape: "arrow", x: 0, y: 0, w: 100, h: 50, ...o }] })!;

  test("线类 route:orth 保留；非法值与线类之外丢弃", () => {
    expect((lineDoc({ route: "orth" }).objects[0] as ShapeEl).route).toBe("orth");
    expect((lineDoc({ route: "grid" }).objects[0] as ShapeEl).route).toBeUndefined();
    const rect = parseDoc({ version: DOC_VERSION, meta: { name: "x" }, objects: [{ kind: "shape", id: "r", shape: "rect", x: 0, y: 0, w: 10, h: 10, route: "orth", label: "x" }] })!;
    const r = rect.objects[0] as ShapeEl;
    expect(r.route).toBeUndefined();
    expect(r.label).toBeUndefined();
  });

  test("label 保留并截断 80；空串丢弃", () => {
    expect((lineDoc({ label: "调用" }).objects[0] as ShapeEl).label).toBe("调用");
    expect((lineDoc({ label: "x".repeat(100) }).objects[0] as ShapeEl).label).toBe("x".repeat(80));
    expect((lineDoc({ label: "  " }).objects[0] as ShapeEl).label).toBeUndefined();
  });

  test("route/label 序列化往返不丢", () => {
    const doc = lineDoc({ route: "orth", label: "依赖" });
    const round = parseDoc(JSON.parse(serializeDoc(doc)))!;
    const el = round.objects[0] as ShapeEl;
    expect(el.route).toBe("orth");
    expect(el.label).toBe("依赖");
  });
});

describe("文档类型（meta.kind 遗留兼容）", () => {
  test("新档不写 kind；docKindOf 恒 board", () => {
    const d = blankDoc();
    expect(d.meta.kind).toBeUndefined();
    expect(docKindOf(d)).toBe("board");
    expect(parseDoc(JSON.parse(serializeDoc(d)))!.meta.kind).toBeUndefined();
  });
  test("旧 ui 档（kind:\"ui\"）解析保留标记——只读兼容，迁移提示用", () => {
    const parsed = parseDoc({ version: 3, meta: { name: "旧 UI", kind: "ui" }, objects: [{ kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 375, h: 812, fill: "#ffffff" }] })!;
    expect(parsed.meta.kind).toBe("ui");
    expect(docKindOf(parsed)).toBe("ui");
  });
  test("旧 deck 档 kind 丢弃（幻灯片概念已移除，打开即画布）", () => {
    const parsed = parseDoc({ version: 2, meta: { name: "x", pagePreset: "16:9", kind: "deck" }, objects: [], frames: [] })!;
    expect(parsed.meta.kind).toBeUndefined();
  });
  test("parseDoc 丢弃非法 kind", () => {
    const doc = parseDoc({ version: 3, meta: { name: "x", kind: "ppt" }, objects: [] })!;
    expect(doc.meta.kind).toBeUndefined();
  });
});

describe("边框样式（strokeStyle）", () => {
  test("parseDoc 保留白名单内的 strokeStyle，非法值丢弃", () => {
    const base = { kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10 };
    const doc = parseDoc({ version: DOC_VERSION, meta: { name: "x" }, objects: [
      { ...base, strokeStyle: "dashed" },
      { ...base, id: "s2", strokeStyle: "wavy" },
    ] })!;
    expect((doc.objects[0] as { strokeStyle?: string }).strokeStyle).toBe("dashed");
    expect((doc.objects[1] as { strokeStyle?: string }).strokeStyle).toBeUndefined();
  });
});

describe("线/箭头方向（dir）与背景明暗判定", () => {
  const shapeDoc = (dir: unknown) => parseDoc({
    version: DOC_VERSION,
    objects: [{ kind: "shape", id: "a", shape: "arrow", x: 0, y: 0, w: 100, h: 50, dir }],
  })!;
  test("合法方向 1/2/3 原样保留；0 与非整数归一后不落键", () => {
    for (const dir of [1, 2, 3]) expect((shapeDoc(dir).objects[0] as { dir?: number }).dir).toBe(dir);
    for (const dir of [0, "1", 9, -1, null, undefined, NaN])
      expect("dir" in (shapeDoc(dir).objects[0] as object)).toBe(false);
  });
  test("序列化往返保留 dir=2", () => {
    const doc = shapeDoc(2);
    const again = parseDoc(JSON.parse(serializeDoc(doc)))!;
    expect((again.objects[0] as { dir?: number }).dir).toBe(2);
  });
  test("isDarkColor：深色判暗（含 8 位带透明度串），浅色/非色串不判暗", () => {
    expect(isDarkColor("#111318")).toBe(true);
    expect(isDarkColor("#000")).toBe(true);
    expect(isDarkColor("linear-gradient(135deg,#11131880,#f5f5f7)")).toBe(true); // 首色深色（8 位带 alpha）
    expect(isDarkColor("#0a84ff55")).toBe(false); // #0a84ff 亮度 0.451，阈值之上按浅色
    expect(isDarkColor("#ffffff")).toBe(false);
    expect(isDarkColor("#f5f5f7")).toBe(false);
    expect(isDarkColor("#fff0")).toBe(false); // 带透明度的浅色简写：按 RGB 判
    expect(isDarkColor(undefined)).toBe(false);
    expect(isDarkColor("none")).toBe(false);
  });
});
