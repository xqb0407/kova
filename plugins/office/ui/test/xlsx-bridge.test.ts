/**
 * xlsx/csv ⇄ 快照转换桥的测试：以"构造快照 → 导出 xlsx → 再导入"的往返
 * 校验值/公式（含缓存结果）/合并/列宽行高/样式的保真；CSV 解析走 RFC4180
 * 引号转义与数值启发式（前导零编号不转数字）。
 */
import { describe, expect, test } from "bun:test";
import {
  exportSnapshotToXlsx,
  importCsvToSnapshot,
  importXlsxToSnapshot,
  parseCsv,
  type ConvSnapshot,
} from "../src/sheet/xlsx-bridge";

const sample: ConvSnapshot = {
  id: "wb-1",
  name: "季度预算",
  sheetOrder: ["s1", "s2"],
  styles: {
    s1: { bl: 1, cl: { rgb: "#FFFFFF" }, bg: { rgb: "#166534" }, ht: 2, vt: 2 },
    s2: { n: { pattern: "#,##0" } },
  },
  sheets: {
    s1: {
      id: "s1",
      name: "汇总",
      rowCount: 6,
      columnCount: 4,
      cellData: {
        "0": {
          "0": { v: "科目", s: "s1" },
          "1": { v: "Q2", s: "s1" },
          "2": { v: "Q3", s: "s1" },
        },
        "1": { "0": { v: "营收" }, "1": { v: 120, s: "s2" }, "2": { v: 156, s: "s2" } },
        "2": { "0": { v: "成本" }, "1": { v: 80, s: "s2" }, "2": { v: 90, s: "s2" } },
        "3": { "0": { v: "毛利" }, "1": { v: 40, f: "=B2-B3" }, "2": { f: "=C2-C3", v: 66 } },
        "4": {
          "0": { v: "带引号,逗号" },
          "1": { v: "日期" },
          "2": { v: 45658, s: { n: { pattern: "yyyy-mm-dd" } } },
        },
      },
      columnData: { "0": { w: 140 } },
      rowData: { "0": { h: 32 } },
      mergeData: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }],
    },
    s2: {
      id: "s2",
      name: "备注",
      rowCount: 3,
      columnCount: 2,
      cellData: { "0": { "0": { v: true }, "1": { v: "布尔与文本" } } },
    },
  },
};

describe("snapshot → xlsx → snapshot 往返", () => {
  test("值 / 公式与缓存结果 / 多 sheet 保真", async () => {
    const bytes = await exportSnapshotToXlsx(sample);
    const back = await importXlsxToSnapshot(bytes.buffer as ArrayBuffer, "季度预算");
    const s1 = back.snapshot.sheets["sheet-1"];
    expect(s1?.name).toBe("汇总");
    const cell = (r: number, c: number) => s1?.cellData[String(r)]?.[String(c)];
    expect(cell(0, 0)?.v).toBe("科目");
    expect(cell(1, 1)?.v).toBe(120);
    // 公式格：公式 + 缓存值都保留
    expect(cell(3, 1)?.f).toBe("=B2-B3");
    expect(cell(3, 1)?.v).toBe(40);
    expect(cell(3, 2)?.f).toBe("=C2-C3");
    // 布尔（第二个 sheet）
    const s2 = back.snapshot.sheets["sheet-2"];
    expect(s2?.cellData["0"]?.["0"]?.v).toBe(true);
    expect(back.snapshot.sheetOrder).toEqual(["sheet-1", "sheet-2"]);
  });

  test("合并 / 列宽行高 / 样式回读", async () => {
    const bytes = await exportSnapshotToXlsx({
      ...sample,
      sheets: {
        ...sample.sheets,
        s1: {
          ...sample.sheets.s1!,
          mergeData: [{ startRow: 4, endRow: 4, startColumn: 0, endColumn: 2 }],
        },
      },
    });
    const back = await importXlsxToSnapshot(bytes.buffer as ArrayBuffer, "x");
    const s1 = back.snapshot.sheets["sheet-1"]!;
    expect(s1.mergeData).toEqual([{ startRow: 4, endRow: 4, startColumn: 0, endColumn: 2 }]);
    // 列宽 140px → 字符宽 → 回 px（允许 ±3 取整误差）
    const w = s1.columnData?.["0"]?.w ?? 0;
    expect(Math.abs(w - 140)).toBeLessThanOrEqual(3);
    // 表头样式：粗体 + 白字 + 底色 + 居中
    const header = s1.cellData["0"]?.["0"];
    expect(typeof header?.s).toBe("string");
    const style = back.snapshot.styles[header?.s as string] as Record<string, { rgb?: string } | unknown>;
    expect(style.bl).toBe(1);
    expect((style.cl as { rgb?: string }).rgb).toBe("#FFFFFF");
    expect((style.bg as { rgb?: string }).rgb).toBe("#166534");
    expect(style.ht).toBe(2);
  });

  test("数字格式（日期列）往返保真", async () => {
    const bytes = await exportSnapshotToXlsx(sample);
    const back = await importXlsxToSnapshot(bytes.buffer as ArrayBuffer, "x");
    const dateCell = back.snapshot.sheets["sheet-1"]?.cellData["4"]?.["2"];
    expect(dateCell?.v).toBe(45658);
    const sid = dateCell?.s as string;
    expect((back.snapshot.styles[sid] as { n?: { pattern?: string } }).n?.pattern).toContain("yyyy");
  });

  test("空簿导入给一页空表（不炸）", async () => {
    const bytes = await exportSnapshotToXlsx({
      id: "wb-e",
      name: "空",
      sheetOrder: ["s"],
      styles: {},
      sheets: { s: { id: "s", name: "Sheet1", rowCount: 5, columnCount: 3, cellData: {} } },
    });
    const back = await importXlsxToSnapshot(bytes.buffer as ArrayBuffer, "空");
    expect(back.snapshot.sheetOrder.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CSV 导入", () => {
  test("RFC4180：引号转义、引号内逗号换行、BOM", () => {
    const rows = parseCsv('\uFEFFa,"b,c","d""e","f\ng"\r\n1,2,3\r\n');
    expect(rows).toEqual([["a", "b,c", 'd"e', "f\ng"], ["1", "2", "3"]]);
  });

  test("数值启发式：纯数字转 number；前导零编号保留为文本", () => {
    const r = importCsvToSnapshot("编号,金额\n007,120.5\n", "编号表");
    const cell = (r2: number, c: number) => r.snapshot.sheets["sheet-1"]?.cellData[String(r2)]?.[String(c)];
    expect(cell(1, 0)?.v).toBe("007");
    expect(cell(1, 1)?.v).toBe(120.5);
  });

  test("导入为合法单 sheet 快照（可直接落盘开板）", () => {
    const r = importCsvToSnapshot("指标,Q2,Q3\n营收,120,156\n", "报表");
    expect(r.snapshot.sheetOrder).toEqual(["sheet-1"]);
    expect(r.snapshot.sheets["sheet-1"]?.rowCount).toBe(20); // 最少 20 行保证可用
  });
});
