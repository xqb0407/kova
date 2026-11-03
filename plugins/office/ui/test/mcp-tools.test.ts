/**
 * Office MCP 工具测试：用临时工作区验证发现/读取/图表补丁/整档写入/长轮询。
 * 这些工具是 agent 与面板之间的文件协议，改动会直接影响协作闭环，故保留回归网。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../../mcp/tools";

const workspace = mkdtempSync(path.join(tmpdir(), "office-mcp-"));
const ctx: ToolCtx = { workspace };

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function call(name: string, args: Record<string, unknown>): unknown {
  const tool = TOOL_DEFS.find((t) => t.name === name)!;
  return tool.run(args, ctx);
}
async function callAsync(name: string, args: Record<string, unknown>): Promise<unknown> {
  return await (call(name, args) as Promise<unknown>);
}

const DECK = "季度复盘.deck.canvas.json";

function seedDeck(): void {
  const chart = {
    kind: "chart",
    id: "ch1",
    x: 640,
    y: 160,
    w: 560,
    h: 420,
    chart: "bar",
    labels: ["一月", "二月"],
    series: [
      { name: "销量", data: [12, 19] },
      { name: "退货", data: [2, 3] },
    ],
  };
  writeFileSync(
    path.join(workspace, DECK),
    JSON.stringify(
      {
        version: 2,
        meta: { name: "季度复盘", pagePreset: "16:9", kind: "deck" },
        objects: [],
        frames: [
          { id: "s1", w: 1280, h: 720, type: "slide", name: "第 1 页", elements: [{ kind: "text", id: "t1", x: 80, y: 80, w: 600, h: 80, runs: [{ text: "季度经营复盘" }] }, chart] },
          { id: "s2", w: 1280, h: 720, type: "slide", name: "第 2 页", elements: [] },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("office MCP：发现与读取", () => {
  seedDeck();

  test("list_docs：按后缀识别 deck，带版本与图表数", () => {
    const r = call("list_docs", {}) as { docs: Array<Record<string, unknown>> };
    const hit = r.docs.find((d) => String(d.path).endsWith(DECK));
    expect(hit?.kind).toBe("deck");
    expect(hit?.name).toBe("季度复盘");
    expect(hit?.frames).toBe(2);
    expect(hit?.charts).toBe(1);
    expect(typeof hit?.version).toBe("string");
  });

  test("read_doc 摘要：页框 + 元素 id/文字/图表系列名", () => {
    const r = call("read_doc", { path: DECK }) as {
      kind: string;
      frames: Array<{ id: string; elements: Array<Record<string, unknown>> }>;
    };
    expect(r.kind).toBe("deck");
    expect(r.frames.map((f) => f.id)).toEqual(["s1", "s2"]);
    const els = r.frames[0]!.elements;
    expect(els.find((e) => e.id === "t1")?.text).toBe("季度经营复盘");
    const chart = els.find((e) => e.id === "ch1") as { chart: { chart: string; series: Array<{ name: string }> } };
    expect(chart.chart.chart).toBe("bar");
    expect(chart.chart.series.map((s) => s.name)).toEqual(["销量", "退货"]);
  });

  test("read_doc view:chart：完整 ChartSpec；elementId 只取该元素", () => {
    const charts = call("read_doc", { path: DECK, view: "chart" }) as { charts: Array<Record<string, unknown>> };
    expect(charts.charts).toHaveLength(1);
    expect(charts.charts[0]?.labels).toEqual(["一月", "二月"]);
    const one = call("read_doc", { path: DECK, elementId: "ch1" }) as { element: { id: string } };
    expect(one.element.id).toBe("ch1");
  });

  test("扩展名不对 → 可操作报错", () => {
    expect(() => call("read_doc", { path: "随便.md" })).toThrow(/扩展名约定/);
  });
});

describe("office MCP：图表补丁", () => {
  seedDeck();

  test("patch_chart：更新类目/系列/堆叠变体，落盘可回读", () => {
    const r = call("patch_chart", {
      path: DECK,
      elementId: "ch1",
      labels: ["Q1", "Q2", "Q3"],
      series: [
        { name: "营收", data: [120, 156, 148] },
        { name: "成本", data: [80, 92, 88] },
      ],
      variant: "stacked",
      legend: { show: true, position: "top" },
      size: 14,
    }) as { version: string; chart: { labels: unknown } };
    expect(r.chart.labels).toEqual(["Q1", "Q2", "Q3"]);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    const el = onDisk.frames[0].elements.find((e: { id: string }) => e.id === "ch1");
    expect(el.variant).toBe("stacked");
    expect(el.series[0].data).toEqual([120, 156, 148]);
    expect(el.legend).toEqual({ show: true, position: "top" });
    expect(el.size).toBe(14);
  });

  test("patch_chart 切散点：series.data 自动转 points（与面板同规则）", () => {
    call("patch_chart", {
      path: DECK,
      elementId: "ch1",
      chart: "scatter",
      series: [{ name: "营收", data: [3, 5] }],
    });
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    const el = onDisk.frames[0].elements.find((e: { id: string }) => e.id === "ch1");
    expect(el.chart).toBe("scatter");
    expect(el.series[0].data).toEqual([]);
    expect(el.series[0].points).toEqual([{ x: 1, y: 3 }, { x: 2, y: 5 }]);
  });

  test("不再支持的类型/超限数据 → 拒绝且不改文件", () => {
    const before = readFileSync(path.join(workspace, DECK), "utf8");
    expect(() => call("patch_chart", { path: DECK, elementId: "ch1", chart: "pyramid" })).toThrow(/chart 类型不支持/);
    expect(() =>
      call("patch_chart", {
        path: DECK,
        elementId: "ch1",
        series: Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, data: [1] })),
      }),
    ).toThrow(/最多 10 个/);
    expect(readFileSync(path.join(workspace, DECK), "utf8")).toBe(before);
  });

  test("元素 id 不存在 → 提示先读取", () => {
    expect(() => call("patch_chart", { path: DECK, elementId: "nope", labels: ["x"] })).toThrow(/图表元素不存在/);
  });
});

describe("office MCP：整档写入与长轮询", () => {
  test("write_doc：sheet 需保留 sheets；写后可读摘要", () => {
    const sheet = {
      name: "预算",
      sheetOrder: ["s1"],
      sheets: { s1: { id: "s1", name: "汇总", rowCount: 4, columnCount: 3, cellData: { "0": { "0": { v: "科目" }, "1": { v: "Q2" } }, "1": { "0": { v: "营收" }, "1": { v: 120 } } } } },
    };
    call("write_doc", { path: "预算.sheet.univer.json", doc: sheet });
    const r = call("read_doc", { path: "预算.sheet.univer.json" }) as {
      kind: string;
      sheets: Array<{ id: string; name: string; filledCells: number }>;
    };
    expect(r.kind).toBe("sheet");
    expect(r.sheets[0]?.name).toBe("汇总");
    expect(r.sheets[0]?.filledCells).toBe(4);
    expect(() => call("write_doc", { path: "坏.sheet.univer.json", doc: { name: "x" } })).toThrow(/sheets/);
  });

  test("watch_doc：since 过期 → 立即返回当前摘要；无变更 → 超时", async () => {
    const r = (await callAsync("watch_doc", { path: DECK, since: "stale", timeoutMs: 2000 })) as {
      changed: boolean;
      version: string;
    };
    expect(r.changed).toBe(true);
    expect(typeof r.version).toBe("string");
    const idle = (await callAsync("watch_doc", { path: DECK, since: r.version, timeoutMs: 1200 })) as {
      changed: boolean;
      timedOut?: boolean;
    };
    expect(idle.changed).toBe(false);
    expect(idle.timedOut).toBe(true);
  });

  test("watch_doc：写盘后返回变更（面板 → agent 通道）", async () => {
    const first = call("read_doc", { path: DECK }) as { version: string };
    const pending = callAsync("watch_doc", { path: DECK, since: first.version, timeoutMs: 5000 }) as Promise<{
      changed: boolean;
      version: string;
      frames: unknown[];
    }>;
    await new Promise((r) => setTimeout(r, 500));
    const doc = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    doc.meta.name = "季度复盘 · 修订";
    writeFileSync(path.join(workspace, DECK), JSON.stringify(doc, null, 2), "utf8");
    const r = await pending;
    expect(r.changed).toBe(true);
    expect(r.version).not.toBe(first.version);
    expect(r.frames).toHaveLength(2);
  });
});

/* ---------------- sheet：单元格矩阵 + 局部写入 ---------------- */

describe("office MCP：sheet 单元格矩阵与局部写入", () => {
  const SHEET = "收支.sheet.univer.json";
  writeFileSync(
    path.join(workspace, SHEET),
    JSON.stringify({
      name: "预算",
      sheetOrder: ["sh1", "sh2"],
      styles: { s1: { bl: 1 } },
      sheets: {
        sh1: {
          id: "sh1",
          name: "汇总",
          rowCount: 3,
          columnCount: 2,
          cellData: {
            "0": { "0": { v: "科目" }, "1": { v: "数量" } },
            "1": { "0": { v: "苹果", s: "s1" }, "1": { v: 5 } },
            "2": { "1": { f: "=SUM(B2:B2)", v: 5 } },
          },
        },
        sh2: { id: "sh2", name: "草稿", rowCount: 10, columnCount: 5, cellData: {} },
      },
    }),
    "utf8",
  );

  test("read_doc view:cells：矩阵带 v/f/s，缺省 used-range", () => {
    const r = call("read_doc", { path: SHEET, view: "cells" }) as {
      sheet: { id: string; name: string };
      range: { from: string; to: string };
      rows: Array<Array<Record<string, unknown> | null>>;
    };
    expect(r.sheet.id).toBe("sh1");
    expect(r.range).toEqual({ from: "A1", to: "B3" });
    expect(r.rows[0]?.map((c) => c?.v)).toEqual(["科目", "数量"]);
    expect(r.rows[1]?.[0]).toMatchObject({ v: "苹果", s: "s1" });
    expect(r.rows[2]?.[1]).toMatchObject({ f: "=SUM(B2:B2)", v: 5 });
    expect(r.rows[0]?.length).toBe(2);
  });

  test("read_doc view:cells：指定 sheet 名称与 range；空表返回空矩阵", () => {
    const r = call("read_doc", { path: SHEET, view: "cells", sheet: "草稿", range: "B2:C3" }) as {
      sheet: { id: string };
      rows: unknown[];
    };
    expect(r.sheet.id).toBe("sh2");
    expect(r.rows).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(() => call("read_doc", { path: SHEET, view: "cells", sheet: "不存在" })).toThrow(/sheet 不存在/);
    expect(() => call("read_doc", { path: SHEET, view: "cells", range: "A0" })).toThrow(/range 不合法/);
  });

  test("patch_sheet：写值/公式，自动扩行列，保留样式引用", () => {
    const r = call("patch_sheet", {
      path: SHEET,
      setCells: {
        C1: "备注",
        B3: { f: "SUM(B2:B2)" }, // 缺 = 自动补
        A6: "新行项目", // 越过 rowCount=3 → 扩表
        E2: 9, // 越过 columnCount=2 → 扩列
      },
    }) as { applied: number; rowCount: number; columnCount: number };
    expect(r.applied).toBe(4);
    expect(r.rowCount).toBeGreaterThanOrEqual(6);
    expect(r.columnCount).toBeGreaterThanOrEqual(5);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, SHEET), "utf8"));
    const sh = onDisk.sheets.sh1;
    expect(sh.rowCount).toBe(r.rowCount);
    expect(sh.cellData["0"]?.["2"]).toEqual({ v: "备注" });
    expect(sh.cellData["2"]?.["1"]).toEqual({ f: "=SUM(B2:B2)" }); // 旧缓存值作废
    expect(sh.cellData["1"]?.["0"]).toEqual({ v: "苹果", s: "s1" }); // 既有格不动
    expect(onDisk.styles.s1).toBeDefined();
  });

  test("patch_sheet：null 清空内容保留样式；显式 v 覆盖缓存", () => {
    call("patch_sheet", { path: SHEET, setCells: { B3: { f: "=SUM(B2:B2)", v: 99 }, A2: null } });
    const onDisk = JSON.parse(readFileSync(path.join(workspace, SHEET), "utf8"));
    expect(onDisk.sheets.sh1.cellData["2"]?.["1"]).toEqual({ f: "=SUM(B2:B2)", v: 99 });
    expect(onDisk.sheets.sh1.cellData["1"]?.["0"]).toEqual({ s: "s1" });
  });

  test("patch_sheet：非法地址/越量/对象缺 f → 拒绝且不改文件", () => {
    const before = readFileSync(path.join(workspace, SHEET), "utf8");
    expect(() => call("patch_sheet", { path: SHEET, setCells: { "A0": 1 } })).toThrow(/地址不合法/);
    expect(() => call("patch_sheet", { path: SHEET, setCells: { "A1:B2": 1 } })).toThrow(/地址不合法/);
    expect(() => call("patch_sheet", { path: SHEET, setCells: { C9: { v: 1 } } })).toThrow(/需有 f 字段/);
    expect(() =>
      call("patch_sheet", { path: SHEET, setCells: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`A${i + 1}`, i])) }),
    ).toThrow(/一次最多 5000/);
    expect(readFileSync(path.join(workspace, SHEET), "utf8")).toBe(before);
  });
});

/* ---------------- doc：结构化摘要 + 段落补丁 ---------------- */

describe("office MCP：doc 摘要与段落补丁", () => {
  const DOC = "纪要.doc.univer.json";
  writeFileSync(
    path.join(workspace, DOC),
    JSON.stringify({
      title: "会议纪要",
      documentStyle: {},
      body: {
        // 段落：["标题","", "一、进展","搜索改版联调完成。","", "二、风险","测试不稳定。"]
        dataStream: "标题\r\r一、进展\r搜索改版联调完成。\r\r二、风险\r测试不稳定。\r\n",
        paragraphs: [
          { startIndex: 0, paragraphStyle: { namedStyleType: 2 } },
          { startIndex: 3 },
          { startIndex: 4, paragraphStyle: { namedStyleType: 4 } },
          { startIndex: 9 },
          { startIndex: 19 },
          { startIndex: 20, paragraphStyle: { namedStyleType: 4 } },
          { startIndex: 25 },
        ],
        sectionBreaks: [{ startIndex: 32 }],
        textRuns: [{ st: 4, ed: 8, ts: { bl: 1 } }], // 加粗「一、进展」
      },
    }),
    "utf8",
  );

  test("read_doc 摘要：标题/字数/段落列表（含样式标记）", () => {
    const r = call("read_doc", { path: DOC }) as {
      kind: string;
      name: string;
      chars: number;
      paragraphs: number;
      list: Array<{ i: number; text: string; style?: Record<string, unknown> }>;
    };
    expect(r.kind).toBe("doc");
    expect(r.name).toBe("会议纪要");
    expect(r.paragraphs).toBe(7);
    expect(r.chars).toBe(25);
    expect(r.list[2]).toMatchObject({ i: 2, text: "一、进展" });
    expect(r.list[0]?.style).toEqual({ namedStyleType: 2 });
  });

  test("patch_doc append/replace/delete：偏移按机械规则重算", () => {
    const r = call("patch_doc", {
      path: DOC,
      ops: [
        { op: "replace", paragraph: 6, text: "测试环境不稳定，已挂 issue。" },
        { op: "append", text: "三、下一步" },
        { op: "append", text: "排期确认后同步。" },
      ],
    }) as { paragraphs: number; version: string };
    expect(r.paragraphs).toBe(9);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DOC), "utf8"));
    const body = onDisk.body;
    expect(body.dataStream.endsWith("\r\n")).toBe(true);
    expect(body.dataStream.split("\r").length - 1).toBe(body.paragraphs.length);
    expect(body.sectionBreaks[0].startIndex).toBe(body.dataStream.length - 1);
    expect(body.paragraphs[0].startIndex).toBe(0);
    expect(body.paragraphs[6].text).toBeUndefined(); // 段落只有 startIndex/样式
    // 逐段校验 startIndex 累加规则
    const lens = body.dataStream.slice(0, -2).split("\r").map((t: string) => t.length);
    let acc = 0;
    body.paragraphs.forEach((p: { startIndex: number }, i: number) => {
      expect(p.startIndex).toBe(acc);
      acc += lens[i] + 1;
    });
    expect(body.paragraphs[6].paragraphStyle).toBeUndefined(); // replace 保留原样式（该段本无样式）
    expect(body.paragraphs[5].paragraphStyle).toEqual({ namedStyleType: 4 }); // 未触及段落样式原样
    // 未被改段落的行内样式 remap 保留（「一、进展」st=4,ed=8）
    expect(body.textRuns).toContainEqual({ st: 4, ed: 8, ts: { bl: 1 } });
  });

  test("patch_doc replace 丢弃该段行内样式；delete 重排偏移", () => {
    call("patch_doc", {
      path: DOC,
      ops: [
        { op: "replace", paragraph: 2, text: "一、进展（改）" },
        { op: "delete", paragraph: 1 },
      ],
    });
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DOC), "utf8"));
    expect(onDisk.body.textRuns).not.toContainEqual({ st: 4, ed: 8, ts: { bl: 1 } });
    const lens = onDisk.body.dataStream.slice(0, -2).split("\r").map((t: string) => t.length);
    expect(onDisk.body.paragraphs).toHaveLength(lens.length);
    let acc = 0;
    onDisk.body.paragraphs.forEach((p: { startIndex: number }, i: number) => {
      expect(p.startIndex).toBe(acc);
      acc += lens[i] + 1;
    });
  });

  test("patch_doc：越界/空 ops → 拒绝且不改文件", () => {
    const before = readFileSync(path.join(workspace, DOC), "utf8");
    expect(() => call("patch_doc", { path: DOC, ops: [{ op: "replace", paragraph: 99, text: "x" }] })).toThrow(/越界/);
    expect(() => call("patch_doc", { path: DOC, ops: [] })).toThrow(/非空数组/);
    expect(() => call("patch_doc", { path: DOC, ops: [{ op: "append" }] })).toThrow(/需有 text/);
    expect(readFileSync(path.join(workspace, DOC), "utf8")).toBe(before);
  });
});

/* ---------------- deck：元素/页级补丁 + create_doc ---------------- */

describe("office MCP：deck 元素与页级补丁", () => {
  seedDeck();

  test("patch_deck element：几何/文字/对齐/行距落盘", () => {
    const r = call("patch_deck", {
      path: DECK,
      op: "element",
      elementId: "t1",
      patch: { x: 100, y: 120, w: 700, h: 90, align: "center", lineHeight: 1.5, runs: [{ text: "新标题", bold: true, size: 44 }] },
    }) as { containerId: string; element: Record<string, unknown> };
    expect(r.containerId).toBe("s1");
    expect(r.element.lineHeight).toBe(1.5);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    const el = onDisk.frames[0].elements.find((e: { id: string }) => e.id === "t1");
    expect(el).toMatchObject({ x: 100, y: 120, w: 700, h: 90, align: "center", lineHeight: 1.5 });
    expect(el.runs[0]).toMatchObject({ text: "新标题", bold: true, size: 44 });
  });

  test("patch_deck element：z 调层序；非法补丁拒绝且不改文件", () => {
    call("patch_deck", { path: DECK, op: "element", elementId: "t1", patch: { opacity: 0.8 }, z: "front" });
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    expect(onDisk.frames[0].elements.map((e: { id: string }) => e.id)).toEqual(["ch1", "t1"]);
    const good = readFileSync(path.join(workspace, DECK), "utf8"); // 合法补丁后的基线
    expect(() => call("patch_deck", { path: DECK, op: "element", elementId: "t1", patch: { w: "宽" } })).toThrow(/需为数字/);
    expect(() => call("patch_deck", { path: DECK, op: "element", elementId: "t1", patch: { runs: [{ size: 44 }] } })).toThrow(/不合法/);
    expect(() => call("patch_deck", { path: DECK, op: "element", elementId: "t1", patch: { align: "两端" } })).toThrow(/align/);
    expect(() => call("patch_deck", { path: DECK, op: "element", elementId: "nope", patch: { x: 1 } })).toThrow(/元素不存在/);
    expect(readFileSync(path.join(workspace, DECK), "utf8")).toBe(good);
  });

  test("patch_deck add_page：版式页与空白页；非法版式拒绝", () => {
    const r = call("patch_deck", { path: DECK, op: "add_page", layoutId: "cover", index: 0 }) as {
      frames: number;
      index: number;
      frameId: string;
    };
    expect(r.frames).toBe(3);
    expect(r.index).toBe(1); // 插到第 1 页之后
    const blank = call("patch_deck", { path: DECK, op: "add_page" }) as { frames: number };
    expect(blank.frames).toBe(4);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    expect(onDisk.frames[1].elements.length).toBeGreaterThan(3);
    expect(() => call("patch_deck", { path: DECK, op: "add_page", layoutId: "nope" })).toThrow(/版式或主题不存在/);
  });

  test("patch_deck set_page / move_page / remove_page", () => {
    call("patch_deck", { path: DECK, op: "set_page", index: 1, patch: { background: "#0b1220", transition: "fade", name: "数据页" } });
    let onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    expect(onDisk.frames[1]).toMatchObject({ background: "#0b1220", transition: "fade", name: "数据页" });
    expect(() => call("patch_deck", { path: DECK, op: "set_page", index: 0, patch: { transition: "溶解" } })).toThrow(/transition/);
    const moved = call("patch_deck", { path: DECK, op: "move_page", from: 1, to: 0 }) as { order: string[] };
    expect(moved.order).toHaveLength(4);
    const removed = call("patch_deck", { path: DECK, op: "remove_page", index: 3 }) as { frames: number };
    expect(removed.frames).toBe(3);
    onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    expect(onDisk.frames).toHaveLength(3);
    expect(() => call("patch_deck", { path: DECK, op: "remove_page", index: 9 })).toThrow(/越界/);
    expect(() => call("patch_deck", { path: DECK, op: "不行" })).toThrow(/op 只支持/);
  });
});

describe("office MCP：create_doc 建档", () => {
  test("三类建档返回摘要，落盘可 read；重复建档拒绝", () => {
    const deck = call("create_doc", { kind: "deck", name: "路演 Demo" }) as { path: string; kind: string; frames: unknown[] };
    expect(deck.path).toBe("路演-Demo.deck.canvas.json");
    expect(deck.frames).toHaveLength(1);
    const sheet = call("create_doc", { kind: "sheet", name: "预算表" }) as { path: string; kind: string; sheets: unknown[] };
    expect(sheet.sheets).toHaveLength(1);
    const doc = call("create_doc", { kind: "doc", name: "公告" }) as { path: string; kind: string; name: string };
    expect(doc.name).toBe("公告");
    expect(() => call("create_doc", { kind: "deck", name: "路演 Demo" })).toThrow(/已存在/);
    expect(() => call("create_doc", { kind: "slide", name: "x" })).toThrow(/kind 只能是/);
    expect(() => call("create_doc", { kind: "deck", name: "../逃逸" })).toThrow(/路径分隔符/);
    const listed = call("list_docs", {}) as { docs: Array<{ path: string }> };
    expect(listed.docs.some((d) => d.path === "路演-Demo.deck.canvas.json")).toBe(true);
  });
});
