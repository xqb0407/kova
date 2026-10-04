/**
 * CanvasDoc v2 模型测试：v1→v2 迁移、容错解析（含 draw）、tidyLayout 幂等、
 * 页框几何换算往返、resizeFrames、序列化往返。
 */
import { describe, expect, test } from "bun:test";
import {
  blankDoc,
  blankFrame,
  CANVAS_ROOT,
  DEFAULT_TABLE_ROWS,
  DOC_VERSION,
  docKindOf,
  DRAW_MAX_POINTS,
  drawFromPoints,
  isDarkColor,
  drawNaturalBox,
  nextFramePos,
  parseDoc,
  resizeFrames,
  serializeDoc,
  slideFrames,
  TIDY_GAP,
  TIDY_PAD,
  tidyLayout,
  titleFrame,
  type ChartEl,
  type DrawEl,
  type El,
  type ShapeEl,
  type TableEl,
} from "../src/doc";
import { boxOf } from "../src/geometry";

const v1Doc = {
  version: 1,
  meta: { name: "旧文档", pagePreset: "16:9" },
  slides: [
    { id: "a", w: 1280, h: 720, background: "#ffffff", elements: [{ kind: "text", id: "t1", x: 10, y: 20, w: 100, h: 40, runs: ["你好"] }] },
    { id: "b", w: 1280, h: 720, background: "#111318", elements: [] },
  ],
};

describe("v1 → v2 迁移", () => {
  test("slides 转 frames：等距网格落位、objects 置空", () => {
    const doc = parseDoc(v1Doc);
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(DOC_VERSION);
    expect(doc!.objects).toEqual([]);
    expect(doc!.frames.map((f) => f.id)).toEqual(["a", "b"]);
    expect(doc!.frames[0].x).toBe(TIDY_PAD);
    expect(doc!.frames[0].y).toBe(TIDY_PAD);
    // n=2 → cols=ceil(sqrt(2/1.6))=2：横向并排
    expect(doc!.frames[1].x).toBe(TIDY_PAD + 1280 + TIDY_GAP);
    expect(doc!.frames[1].y).toBe(TIDY_PAD);
    // v1 slide 元素原样进 frame.elements
    expect(doc!.frames[0].elements[0]?.id).toBe("t1");
  });

  test("迁移是幂等的：v2 文档再过一遍 parseDoc 不变", () => {
    const migrated = parseDoc(v1Doc)!;
    const again = parseDoc(JSON.parse(serializeDoc(migrated)))!;
    expect(serializeDoc(again)).toBe(serializeDoc(migrated));
  });

  test("v1 元素坏数据容错：坏元素丢弃、页不丢", () => {
    const doc = parseDoc({
      slides: [{ id: "s", elements: [{ kind: "bogus" }, { kind: "image", id: "i", src: "" }] }],
    });
    expect(doc!.frames).toHaveLength(1);
    expect(doc!.frames[0].elements).toHaveLength(0);
  });
});

describe("页切换动画（transition）", () => {
  const frameDoc = (tr: unknown) => ({
    frames: [{ id: "s", w: 1280, h: 720, background: "#ffffff", elements: [], transition: tr }],
  });
  test("合法值保留：none/fade/zoom 原样解析", () => {
    for (const tr of ["none", "fade", "zoom"]) {
      expect(parseDoc(frameDoc(tr))!.frames[0]!.transition).toBe(tr);
    }
  });
  test("slide 与非法值归一为缺省（不落键，序列化无 transition）", () => {
    for (const tr of ["slide", "bogus", 42, null, undefined]) {
      const f = parseDoc(frameDoc(tr))!.frames[0]!;
      expect("transition" in f).toBe(false);
    }
  });
  test("序列化往返保持：fade 文档过一遍 parseDoc(serializeDoc) 不变", () => {
    const doc = parseDoc(frameDoc("fade"))!;
    const again = parseDoc(JSON.parse(serializeDoc(doc)))!;
    expect(again.frames[0]!.transition).toBe("fade");
  });
});

describe("v2 解析", () => {
  test("frames + objects 各自入位；无坐标缺省落 0", () => {
    const doc = parseDoc({
      version: 2,
      meta: { name: "x", pagePreset: "4:3" },
      objects: [{ kind: "shape", id: "o1", shape: "rect", x: 500, y: 500, w: 50, h: 50, fill: "#0a84ff" }],
      frames: [{ id: "f1", w: 1024, h: 768, background: "#fff", elements: [{ kind: "text", runs: "纯文本" }] }],
    })!;
    expect(doc.objects[0]!.x).toBe(500);
    expect(doc.meta.pagePreset).toBe("4:3");
    expect(doc.frames[0]!.x).toBe(0);
    expect(doc.frames[0]!.y).toBe(0);
    expect(doc.frames[0]!.elements[0]!.kind).toBe("text");
  });

  test("非文档 JSON → null", () => {
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc("string")).toBeNull();
    expect(parseDoc({})).toBeNull();
    expect(parseDoc({ slides: "no" })).toBeNull();
  });

  test("draw 解析：点集清洗、少于 2 点丢弃、粗细夹取、点数封顶", () => {
    const doc = parseDoc({
      frames: [],
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

  test("slideFrames 只认 type:slide（当前唯一框型，防御未来扩展）", () => {
    const doc = blankDoc("16:9", "t");
    expect(slideFrames(doc)).toEqual([]);
    const f = blankFrame("16:9", { x: 0, y: 0 });
    doc.frames = [f, { ...f, id: "f-other", type: "frame" as never }];
    expect(slideFrames(doc).map((s) => s.id)).toEqual([f.id]);
  });
});

describe("布局纯函数", () => {
  test("tidyLayout 幂等 + 网格形状", () => {
    const doc = blankDoc("16:9", "t");
    doc.frames = Array.from({ length: 5 }, (_, i) => blankFrame("16:9", { x: i * 37, y: i * -91 }));
    const once = tidyLayout(doc);
    const twice = tidyLayout(once);
    expect(twice.frames.map((f) => `${f.x},${f.y}`)).toEqual(once.frames.map((f) => `${f.x},${f.y}`));
    // n=5 → cols=ceil(sqrt(5/1.6))=2：每行 2 个
    expect(once.frames[1]!.x).toBe(TIDY_PAD + 1280 + TIDY_GAP);
    expect(once.frames[1]!.y).toBe(TIDY_PAD);
    expect(once.frames[2]!.x).toBe(TIDY_PAD);
    expect(once.frames[2]!.y).toBe(TIDY_PAD + 720 + TIDY_GAP);
  });

  test("nextFramePos：空档落起点；有档落最右侧一列顶端", () => {
    expect(nextFramePos([])).toEqual({ x: TIDY_PAD, y: TIDY_PAD });
    const frames = [blankFrame("16:9", { x: 100, y: 200 }), blankFrame("16:9", { x: 50, y: 30 })];
    expect(nextFramePos(frames)).toEqual({ x: 100 + 1280 + TIDY_GAP, y: 30 });
  });

  test("画布↔页框局部坐标往返（stage 命中/框选换算的最小模型）", () => {
    const frame = titleFrame("16:9", "标题", "副题", { x: 1000, y: 500 });
    const el = frame.elements[0]!;
    const canvasBox = { x: frame.x + el.x, y: frame.y + el.y, w: el.w, h: el.h };
    const local = { x: canvasBox.x - frame.x, y: canvasBox.y - frame.y, w: canvasBox.w, h: canvasBox.h };
    const b = boxOf(el);
    expect(local.x).toBeCloseTo(b.x, 6);
    expect(local.y).toBeCloseTo(b.y, 6); // 浮点：500+230.4-500 与 230.4 非精确相等
    expect([local.w, local.h]).toEqual([b.w, b.h]);
  });
});

describe("resizeFrames 换页尺寸", () => {
  test("页框与内容同比缩放；objects 与页框位置不动", () => {
    // 不经 tidyLayout（它会归位 x/y），直接摆一个偏移页框
    const doc = blankDoc("16:9", "t");
    doc.objects.push({ kind: "shape", id: "o", shape: "rect", x: 3000, y: 3000, w: 100, h: 50 });
    const frame = blankFrame("16:9", { x: 777, y: 888 });
    frame.elements = [{ kind: "text", id: "t", x: 640, y: 360, w: 640, h: 200, runs: [{ text: "x" }] }];
    doc.frames = [frame];
    const next = resizeFrames(doc, "4:3");
    expect(next.meta.pagePreset).toBe("4:3");
    const f = next.frames[0]!;
    expect([f.x, f.y]).toEqual([777, 888]); // 位置不动
    expect([f.w, f.h]).toEqual([1024, 768]);
    const el = f.elements[0]!;
    // fx=1024/1280=.8，fy=768/720=1.0667：(640,360,640,200) → (512,384,512,213)，右下缘 1280→1024 贴齐新框宽
    expect([el.x, el.y, el.w, el.h]).toEqual([512, 384, 512, 213]);
    expect(next.objects).toEqual(doc.objects);
  });
});

describe("构造与序列化", () => {
  test("blankDoc 是合法 v2：空白板（objects/frames 皆空）；序列化往返一致", () => {
    const doc = blankDoc("16:9", "演示");
    expect(doc.version).toBe(2);
    expect(doc.objects).toEqual([]);
    expect(doc.frames).toEqual([]);
    const round = parseDoc(JSON.parse(serializeDoc(doc)))!;
    expect(serializeDoc(round)).toBe(serializeDoc(doc));
    expect(round.objects).toEqual([]);
    expect(round.frames).toEqual([]);
  });

  test("titleFrame 元素非空、frame 字段齐全", () => {
    const f = titleFrame("16:9", "T", "S", { x: 10, y: 20 });
    expect(f.type).toBe("slide");
    expect([f.x, f.y]).toEqual([10, 20]);
    expect(f.elements.length).toBeGreaterThanOrEqual(2);
  });

  test("CANVAS_ROOT 哨兵不与生成 id 冲突（uid 前缀均为小写字母+数字）", () => {
    expect(blankFrame("16:9", { x: 0, y: 0 }).id.startsWith(CANVAS_ROOT)).toBe(false);
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
    const round = parseDoc(JSON.parse(serializeDoc({ version: 2, meta: { name: "t", pagePreset: "16:9" }, objects: [resized], frames: [] })))!;
    expect(round.objects[0]!.kind).toBe("draw"); // 拉伸态可序列化往返
  });
});

describe("table/chart/groupId/新形状解析", () => {
  const obj = (o: Record<string, unknown>) =>
    parseDoc({ version: 2, meta: { name: "x", pagePreset: "16:9" }, objects: [o], frames: [] })!;

  test("table：行清洗（截断 500）、colWidths 过滤非正数、header=false 落键、size 夹取", () => {
    const doc = obj({
      kind: "table", id: "t1", x: 0, y: 0, w: 300, h: 120,
      rows: [["列 A", "列 B"], ["x".repeat(600), 42], "junk"],
      colWidths: [2, -1, 0, 3], size: 999, fill: "#f00f00", header: false,
    });
    const t = doc.objects[0] as TableEl;
    expect(t.rows).toEqual([["列 A", "列 B"], ["x".repeat(500), ""]]); // str() 只收 string，数字格置空
    expect(t.colWidths).toEqual([2, 3]);
    expect(t.size).toBe(96);
    expect(t.header).toBe(false);
    expect(t.fill).toBe("#f00f00");
  });

  test("table：空 rows 回退默认；header 缺省不落键；非色值丢弃", () => {
    const t = obj({ kind: "table", id: "t1", x: 0, y: 0, w: 300, h: 120, rows: [], fill: "red" }).objects[0] as TableEl;
    expect(t.rows).toEqual(DEFAULT_TABLE_ROWS);
    expect("header" in t).toBe(false);
    expect("fill" in t).toBe(false);
  });

  test("chart：labels 去空、series 收 finite 数（空 data 丢弃）、kind 校验、colors 过滤、size 夹取", () => {
    const c = obj({
      kind: "chart", id: "c1", x: 0, y: 0, w: 400, h: 300,
      labels: ["一月", "", "三月"],
      series: [{ name: "A", data: [1, "x", 3] }, { name: "B", data: [] }, "junk"],
      chart: "donut", colors: ["#0a84ff", "nope"], showLegend: true, size: 2,
    }).objects[0] as ChartEl;
    expect(c.labels).toEqual(["一月", "三月"]);
    expect(c.series).toEqual([{ name: "A", data: [1, 3] }]);
    expect("chart" in c).toBe(false);
    expect(c.colors).toEqual(["#0a84ff"]);
    expect(c.showLegend).toBe(true);
    expect(c.size).toBe(6);
  });

  test("chart：labels 或 series 全空 → 元素丢弃", () => {
    const emptyLabels = { kind: "chart", id: "c", x: 0, y: 0, w: 10, h: 10, labels: [], series: [{ name: "A", data: [1] }] };
    const emptySeries = { kind: "chart", id: "c", x: 0, y: 0, w: 10, h: 10, labels: ["一"], series: [] };
    expect(obj(emptyLabels).objects).toHaveLength(0);
    expect(obj(emptySeries).objects).toHaveLength(0);
  });

  test("groupId：合法保留并截断 64；空白丢弃", () => {
    const s1 = obj({ kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10, groupId: "g".repeat(80) }).objects[0] as El;
    expect(s1.groupId).toBe("g".repeat(64));
    const s2 = obj({ kind: "shape", id: "s2", shape: "rect", x: 0, y: 0, w: 10, h: 10, groupId: "   " }).objects[0] as El;
    expect("groupId" in s2).toBe(false);
  });

  test("新形状与双头箭头 kind 全部通过解析", () => {
    for (const shape of ["triangle", "trapezoid", "pentagon", "hexagon", "star", "double-arrow"]) {
      const s = obj({ kind: "shape", id: "s", shape, x: 0, y: 0, w: 10, h: 10, fill: "#0a84ff" }).objects[0] as ShapeEl;
      expect(s.shape).toBe(shape);
    }
  });

  test("线类 curve：夹取 [-1,1]、非法值丢弃；未知 shape 回退 rect", () => {
    const s1 = obj({ kind: "shape", id: "s", shape: "arrow", x: 0, y: 0, w: 10, h: 10, curve: 7 }).objects[0] as ShapeEl;
    expect(s1.curve).toBe(1);
    const s2 = obj({ kind: "shape", id: "s", shape: "arrow", x: 0, y: 0, w: 10, h: 10, curve: "x" }).objects[0] as ShapeEl;
    expect(s2.curve).toBeUndefined();
    const s3 = obj({ kind: "shape", id: "s", shape: "spiral", x: 0, y: 0, w: 10, h: 10 }).objects[0] as ShapeEl;
    expect(s3.shape).toBe("rect");
  });

  test("旧 curve-arrow 载入迁移为 arrow + curve（缺省弧度 0.3 保留）", () => {
    const m1 = obj({ kind: "shape", id: "s", shape: "curve-arrow", x: 0, y: 0, w: 10, h: 10 }).objects[0] as ShapeEl;
    expect(m1.shape).toBe("arrow");
    expect(m1.curve).toBe(0.3);
    const m2 = obj({ kind: "shape", id: "s", shape: "curve-arrow", x: 0, y: 0, w: 10, h: 10, curve: -0.5 }).objects[0] as ShapeEl;
    expect(m2.shape).toBe("arrow");
    expect(m2.curve).toBe(-0.5);
  });
});

describe("文档类型（meta.kind）", () => {
  test("blankDoc 入档类型；parseDoc 往返保留", () => {
    const d = blankDoc("16:9", "白板示例", "board");
    expect(d.meta.kind).toBe("board");
    expect(parseDoc(JSON.parse(serializeDoc(d)))!.meta.kind).toBe("board");
    expect(blankDoc("16:9", "演示", "deck").meta.kind).toBe("deck");
  });
  test("旧 ui 档（kind:\"ui\"）仍可解析往返与识别——只读兼容，新档已拆到 ui-design 面板", () => {
    const d = blankDoc("16:9", "UI 设计", "ui");
    d.objects.push({ kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 375, h: 812, fill: "#ffffff" } as (typeof d.objects)[number]);
    expect(d.meta.kind).toBe("ui");
    expect(parseDoc(JSON.parse(serializeDoc(d)))!.meta.kind).toBe("ui");
    expect(docKindOf(d)).toBe("ui");
  });
  test("docKindOf：kind 优先；老档按内容亲和回退（纯页框→deck）", () => {
    const withKind = { ...blankDoc(), meta: { name: "x", pagePreset: "16:9" as const, kind: "deck" as const } };
    expect(docKindOf(withKind)).toBe("deck");
    // 老档没有 kind（blankDoc 现在默认写 board，这里显式去掉模拟迁移前文件）
    const legacyMeta = { name: "x", pagePreset: "16:9" as const };
    const legacyDeck = { ...blankDoc(), meta: legacyMeta, frames: [blankFrame("16:9")] };
    expect(docKindOf(legacyDeck)).toBe("deck");
    const legacyBoard = { ...blankDoc(), meta: legacyMeta, objects: [{ kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10 } as const] };
    expect(docKindOf(legacyBoard)).toBe("board");
    const mixed = { ...blankDoc(), meta: legacyMeta, objects: legacyBoard.objects, frames: [blankFrame("16:9")] };
    expect(docKindOf(mixed)).toBe("board");
  });
  test("parseDoc 丢弃非法 kind", () => {
    const doc = parseDoc({ version: 2, meta: { name: "x", pagePreset: "16:9", kind: "ppt" }, objects: [], frames: [] })!;
    expect(doc.meta.kind).toBeUndefined();
  });
});

describe("边框样式（strokeStyle）", () => {
  test("parseDoc 保留白名单内的 strokeStyle，非法值丢弃", () => {
    const base = { kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10 };
    const doc = parseDoc({ version: 2, meta: { name: "x", pagePreset: "16:9" }, objects: [
      { ...base, strokeStyle: "dashed" },
      { ...base, id: "s2", strokeStyle: "wavy" },
    ], frames: [] })!;
    expect((doc.objects[0] as { strokeStyle?: string }).strokeStyle).toBe("dashed");
    expect((doc.objects[1] as { strokeStyle?: string }).strokeStyle).toBeUndefined();
  });
});

describe("线/箭头方向（dir）与背景明暗判定", () => {
  const shapeDoc = (dir: unknown) => parseDoc({
    version: 2,
    objects: [{ kind: "shape", id: "a", shape: "arrow", x: 0, y: 0, w: 100, h: 50, dir }],
    frames: [],
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
  test("isDarkColor：深色页判暗（含 8 位带透明度串），浅色/非色串不判暗", () => {
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
