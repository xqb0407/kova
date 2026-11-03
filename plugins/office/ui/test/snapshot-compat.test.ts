/**
 * 快照兼容门禁（Univer 升级迁移层的可执行部分）：
 *
 * 三类文档的「载入前容错层」必须对**未知/新增字段**保持原样——这样 Univer 小版本
 * 升级（新增插件资源、worksheet 新字段）时旧代码不会写坏新档；反过来，新代码读旧档
 * 也由缺省值兜底。任何一次升级如果打破了这些断言，就说明需要写显式迁移器。
 *
 * 覆盖：sheet 的 filter / conditionalFormatting 资源、merge/freeze/rowData/columnData、
 * 未知顶层字段；doc 的 customBlocks/tables/settings；deck 的 v2 可选字段往返。
 */
import { describe, expect, test } from "bun:test";
import { dropEmptyResources, sanitizeSheetSnapshot } from "../src/sheet/sanitize";
import { normalizeDocSnapshot, type NormalizableDoc } from "../src/doc/normalize";
import { parseDoc, serializeDoc } from "../src/doc";

describe("sheet 快照兼容门禁", () => {
  const make = () => ({
    id: "wb-1",
    name: "兼容门禁",
    appVersion: "1.0.4",
    locale: "zhCN",
    styles: { s1: { bl: 1 } },
    sheetOrder: ["sh1"],
    sheets: {
      sh1: {
        id: "sh1",
        name: "数据",
        rowCount: 100,
        columnCount: 20,
        cellData: {
          "0": { "0": { v: "科目", s: "s1" }, "1": { v: "数量" } },
          "1": { "1": { f: "=SUM(B1:B1)", v: 3 } },
        },
        mergeData: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }],
        freeze: { xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 },
        rowData: { "0": { h: 30 } },
        columnData: { "0": { w: 120 } },
        futureSheetField: { keep: true },
      },
    },
    resources: [
      {
        name: "SHEET_FILTER_PLUGIN",
        data: JSON.stringify({ sh1: { range: { startRow: 0, startColumn: 0, endRow: 9, endColumn: 2 }, filters: [] } }),
      },
      {
        name: "SHEET_CONDITIONAL_FORMATTING_PLUGIN",
        data: JSON.stringify({ sh1: [{ ranges: [], rule: { type: "highlightCell" } }] }),
      },
      { name: "SHEET_USER_PROTECTION_PLUGIN", data: "{}" }, // 保护/鉴权：必须剥离
      { name: "SHEET_AuthzIoMockService", data: "{}" },
      { name: "SHEET_FILTER_PLUGIN_EMPTY", data: "{}" }, // 空壳：剥离
    ],
    futureTopField: { keep: true },
  });

  test("载入容错层保留 filter/CF 资源、merge/freeze/行列尺寸与未知字段", () => {
    const snapshot = make();
    const out = dropEmptyResources(sanitizeSheetSnapshot(snapshot));
    const res = (out.resources ?? []) as { name: string; data: string }[];
    const names = res.map((r) => r.name).sort();
    expect(names).toEqual(["SHEET_CONDITIONAL_FORMATTING_PLUGIN", "SHEET_FILTER_PLUGIN"]);
    const filter = res.find((r) => r.name === "SHEET_FILTER_PLUGIN")!;
    expect(JSON.parse(filter.data).sh1.range.endRow).toBe(9);
    const sheet = out.sheets!.sh1 as Record<string, unknown>;
    expect(sheet.mergeData).toEqual([{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }]);
    expect(sheet.freeze).toEqual({ xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 });
    expect(sheet.rowData).toEqual({ "0": { h: 30 } });
    expect(sheet.columnData).toEqual({ "0": { w: 120 } });
    expect(sheet.futureSheetField).toEqual({ keep: true });
    expect(out.futureTopField).toEqual({ keep: true });
    expect(out.appVersion).toBe("1.0.4"); // 升级判定依据必须保留
  });

  test("免费/子表缺 freeze 等字段时不被注入脏值", () => {
    const snapshot = make();
    snapshot.sheets.sh1.freeze = { xSplit: -1, ySplit: 0, startRow: -1, startColumn: -1 } as never;
    const out = sanitizeSheetSnapshot(snapshot);
    expect((out.sheets!.sh1 as Record<string, unknown>).freeze).toEqual({ xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 });
  });
});

describe("doc 快照兼容门禁", () => {
  test("normalize 保留高级块/设置/未知字段，只补机械结构", () => {
    const snapshot = {
      id: "doc-1",
      title: "兼容门禁",
      documentStyle: {},
      settings: { keep: true },
      futureTopField: "x",
      body: {
        dataStream: "第一段\r第二段", // 缺结尾 \r\n → 归一
        paragraphs: [{ startIndex: 0 }, { startIndex: 4 }],
        textRuns: [{ st: 0, ed: 3, ts: { bl: 1 } }],
        customBlocks: [{ blockId: "b1", blockType: 1 }],
        tables: [{ tableId: "t1" }],
        futureBodyField: { keep: true },
      },
    };
    const out = normalizeDocSnapshot(snapshot as unknown as NormalizableDoc) as typeof snapshot;
    expect(out.body.dataStream.endsWith("\r\n")).toBe(true);
    expect(out.body.sectionBreaks.length).toBeGreaterThan(0);
    expect((out.body as Record<string, unknown>).customBlocks).toEqual([{ blockId: "b1", blockType: 1 }]);
    expect((out.body as Record<string, unknown>).tables).toEqual([{ tableId: "t1" }]);
    expect((out.body as Record<string, unknown>).futureBodyField).toEqual({ keep: true });
    expect(out.settings).toEqual({ keep: true });
    expect(out.futureTopField).toBe("x");
    // 已合法快照零改动（幂等）
    expect((normalizeDocSnapshot(JSON.parse(JSON.stringify(out)) as unknown as NormalizableDoc) as typeof snapshot).body.dataStream).toBe(out.body.dataStream);
  });
});

describe("deck v2 快照往返门禁", () => {
  test("pageNumber/footer/notes/lineHeight 等可选字段 parse→serialize→parse 不丢", () => {
    const doc = {
      version: 2,
      meta: { name: "往返", pagePreset: "16:9", kind: "deck", pageNumber: true, footer: "内部分享" },
      objects: [],
      frames: [
        {
          id: "f1",
          type: "slide",
          x: 0,
          y: 0,
          w: 1280,
          h: 720,
          background: "linear-gradient(135deg,#0a84ff55,#5ac8fa22)",
          notes: "开场先讲结论",
          elements: [
            { kind: "text", id: "t1", x: 0, y: 0, w: 100, h: 40, runs: [{ text: "标题", bold: true, color: "#111827", font: "PingFang SC" }], align: "center", vAlign: "middle", lineHeight: 1.8 },
            { kind: "shape", id: "s1", shape: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#f5f5f7", stroke: "none", strokeWidth: 1, radius: 12, futureShapeField: 1 },
          ],
        },
      ],
    };
    const back = parseDoc(JSON.parse(serializeDoc(doc as never)))!;
    expect(back.meta.pageNumber).toBe(true);
    expect(back.meta.footer).toBe("内部分享");
    expect(back.frames[0]!.notes).toBe("开场先讲结论");
    const text = back.frames[0]!.elements.find((e) => e.kind === "text") as Extract<typeof back.frames[number]["elements"][number], { kind: "text" }>;
    expect(text.lineHeight).toBe(1.8);
    expect(text.runs[0]!.font).toBe("PingFang SC");
    // 未知字段由解析器丢弃（面板语义），不算迁移债；这里只锚定已知可选字段不丢
  });
});
