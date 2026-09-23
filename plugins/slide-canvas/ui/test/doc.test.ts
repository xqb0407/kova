/**
 * CanvasDoc v2 模型测试：v1→v2 迁移、容错解析（含 draw）、tidyLayout 幂等、
 * 页框几何换算往返、resizeFrames、序列化往返。
 */
import { describe, expect, test } from "bun:test";
import {
  blankDoc,
  blankFrame,
  CANVAS_ROOT,
  DOC_VERSION,
  DRAW_MAX_POINTS,
  drawFromPoints,
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
  type DrawEl,
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
    expect(slideFrames(doc)).toEqual(doc.frames);
    doc.frames.push({ ...doc.frames[0]!, id: "f-other", type: "frame" as never });
    expect(slideFrames(doc).map((f) => f.id)).toEqual([doc.frames[0]!.id]);
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
    Object.assign(doc.frames[0]!, {
      x: 777,
      y: 888,
      elements: [{ kind: "text", id: "t", x: 640, y: 360, w: 640, h: 200, runs: [{ text: "x" }] }],
    });
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
  test("blankDoc 是合法 v2：一个 80,80 页框、空 objects；序列化往返一致", () => {
    const doc = blankDoc("16:9", "演示");
    expect(doc.version).toBe(2);
    expect(doc.objects).toEqual([]);
    expect(doc.frames).toHaveLength(1);
    expect([doc.frames[0]!.x, doc.frames[0]!.y]).toEqual([TIDY_PAD, TIDY_PAD]);
    const round = parseDoc(JSON.parse(serializeDoc(doc)))!;
    expect(serializeDoc(round)).toBe(serializeDoc(doc));
    expect(round.objects).toEqual([]);
  });

  test("titleFrame 元素非空、frame 字段齐全", () => {
    const f = titleFrame("16:9", "T", "S", { x: 10, y: 20 });
    expect(f.type).toBe("slide");
    expect([f.x, f.y]).toEqual([10, 20]);
    expect(f.elements.length).toBeGreaterThanOrEqual(2);
  });

  test("CANVAS_ROOT 哨兵不与生成 id 冲突（uid 前缀均为小写字母+数字）", () => {
    const doc = blankDoc("16:9", "t");
    expect(doc.frames[0]!.id.startsWith(CANVAS_ROOT)).toBe(false);
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
