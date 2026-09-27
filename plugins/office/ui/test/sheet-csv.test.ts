/**
 * 表格快照 → CSV 的纯函数测试：稀疏矩阵补位与边界截断、CSV 转义、
 * 公式格导空（导出时点拿不到计算结果）、BOM。
 */
import { describe, expect, test } from "bun:test";
import { matrixOf, workbookToCsv, type CellMatrix } from "../src/sheet/csv";

describe("matrixOf 稀疏矩阵", () => {
  test("空洞补位、右/下截断到有内容边界", () => {
    const m: CellMatrix = {
      "0": { "0": { v: "A1" }, "2": { v: "C1" } },
      "2": { "0": { v: "A3" } },
    };
    expect(matrixOf(m)).toEqual([
      ["A1", "", "C1"],
      ["", "", ""],
      ["A3", "", ""],
    ]);
  });

  test("空/缺失 cellData 给空矩阵", () => {
    expect(matrixOf(undefined)).toEqual([]);
    expect(matrixOf({})).toEqual([]);
  });
});

describe("workbookToCsv", () => {
  test("默认取 sheetOrder 首个 sheet", () => {
    const wb = {
      sheetOrder: ["b", "a"],
      sheets: {
        a: { name: "A", cellData: { "0": { "0": { v: 1 } } } },
        b: { name: "B", cellData: { "0": { "0": { v: 2 } } } },
      },
    };
    expect(workbookToCsv(wb)).toContain("2");
  });

  test("逗号/引号/换行转义；公式格导空；值优先", () => {
    const wb = {
      sheetOrder: ["s"],
      sheets: {
        s: {
          cellData: {
            "0": {
              "0": { v: '含"引号"' },
              "1": { v: "含,逗号" },
              "2": { v: "含\n换行" },
              "3": { f: "=SUM(A1:A9)", v: null },
              "4": { f: "=A1+B1", v: 42 },
            },
          },
        },
      },
    };
    const csv = workbookToCsv(wb);
    // 公式格：无 v 导空；有 v 用 v（导出时点面板已算好的值照常导出）
    expect(csv.replace(/^\uFEFF/, "").split("\r\n")[0]).toBe('"含""引号""","含,逗号","含\n换行",,42');
  });

  test("BOM 开头（Excel UTF-8 识别）且行间 CRLF", () => {
    const wb = {
      sheetOrder: ["s"],
      sheets: { s: { cellData: { "0": { "0": { v: "甲" } }, "1": { "0": { v: "乙" } } } } },
    };
    const csv = workbookToCsv(wb);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("甲\r\n乙");
  });
});
