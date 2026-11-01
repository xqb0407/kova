/**
 * 图表数据表纯逻辑测试：粘贴解析（TSV/CSV）、数值容错、按类型写入与扩行扩列。
 * 这些行为决定「从 Excel 粘贴」是否可用，回归价值高。
 */
import { describe, expect, test } from "bun:test";
import type { ChartPoint, ChartTask } from "../src/doc";
import { chartDataModeOf, isBlockPaste, parseClipGrid, parseNumCell, pasteCategory, pastePoints, pasteTasks } from "../src/editor/chart-data";

describe("parseClipGrid", () => {
  test("Excel 粘贴：Tab 分列、换行分行，只去尾随空行", () => {
    expect(parseClipGrid("A\t1\t2\nB\t3\t4\n\n")).toEqual([
      ["A", "1", "2"],
      ["B", "3", "4"],
    ]);
  });

  test("CSV：逗号分列；\r\n 归一；保留中间空行", () => {
    expect(parseClipGrid("a,1,2\r\nb,3,4")).toEqual([
      ["a", "1", "2"],
      ["b", "3", "4"],
    ]);
    expect(parseClipGrid("a,1\n\nb,2\n")).toEqual([["a", "1"], [""], ["b", "2"]]);
  });

  test("千分位数字不按逗号拆：1,234 / 12,345.6 / ￥1,234 / 40%", () => {
    expect(parseClipGrid("1,234")).toEqual([["1,234"]]);
    expect(parseClipGrid("12,345.6")).toEqual([["12,345.6"]]);
    expect(parseClipGrid("￥1,234")).toEqual([["￥1,234"]]);
    expect(parseClipGrid("A,1,234,40%")).toEqual([["A", "1,234", "40%"]]);
  });

  test("单值不算块粘贴", () => {
    expect(isBlockPaste(parseClipGrid("12"))).toBe(false);
    expect(isBlockPaste(parseClipGrid("1,234"))).toBe(false);
    expect(isBlockPaste(parseClipGrid("1\t2"))).toBe(true);
    expect(isBlockPaste(parseClipGrid("1\n2"))).toBe(true);
  });
});

describe("parseNumCell", () => {
  test("千分位/货币/空格容错", () => {
    expect(parseNumCell("1,234")).toBe(1234);
    expect(parseNumCell("￥1,200")).toBe(1200);
    expect(parseNumCell(" 42 ")).toBe(42);
  });
  test("百分比按需转小数", () => {
    expect(parseNumCell("12%")).toBe(12);
    expect(parseNumCell("40%", true)).toBeCloseTo(0.4, 5);
  });
  test("空/非数字返回 null", () => {
    expect(parseNumCell("")).toBeNull();
    expect(parseNumCell("abc")).toBeNull();
  });
});

describe("pasteCategory", () => {
  test("从第 2 列起粘贴 2×2：扩出第 2 个系列并把列映射到系列", () => {
    const out = pasteCategory(["一", "二"], ["A"], [[1, 2]], [["10", "20"], ["30", "40"]], { r: 0, c: 1 });
    expect(out.labels).toEqual(["一", "二"]);
    expect(out.names).toEqual(["A", "系列 2"]);
    expect(out.data[0]).toEqual([10, 30]);
    expect(out.data[1]).toEqual([20, 40]);
  });

  test("首列写类目名并自动扩行；空单元格原值保留", () => {
    const out = pasteCategory(["一"], ["A"], [[1]], [["二月", "5"], ["三月", ""]], { r: 1, c: 0 });
    expect(out.labels).toEqual(["一", "二月", "三月"]);
    expect(out.data[0]).toEqual([1, 5, 0]);
  });

  test("千分位数值可粘贴", () => {
    const out = pasteCategory(["一"], ["A"], [[0]], [["1,234"]], { r: 0, c: 1 });
    expect(out.data[0]?.[0]).toBe(1234);
  });
});

describe("pastePoints", () => {
  test("整块写 x/y；行不足自动补点", () => {
    const pts: ChartPoint[] = [{ x: 1, y: 2 }];
    const out = pastePoints(pts, [["3", "4"], ["5", "6"]], { r: 0, c: 0 });
    expect(out).toEqual([
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
  });

  test("从 y 列起粘贴只改 y；气泡尺寸列", () => {
    const pts: ChartPoint[] = [{ x: 1, y: 2 }];
    const out = pastePoints(pts, [["9", "20"]], { r: 0, c: 1 });
    expect(out[0]).toEqual({ x: 1, y: 9, size: 20 });
  });

  test("非数字单元格保持原值", () => {
    const out = pastePoints([{ x: 1, y: 2 }], [["", "7"]], { r: 0, c: 0 });
    expect(out[0]).toEqual({ x: 1, y: 7 });
  });
});

describe("pasteTasks", () => {
  test("四列：名称/开始/结束/进度（百分比转小数）", () => {
    const tasks: ChartTask[] = [{ name: "需求", start: 1, end: 3 }];
    const out = pasteTasks(tasks, [["设计", "3", "6", "40%"]], { r: 1, c: 0 });
    expect(out[1]).toEqual({ name: "设计", start: 3, end: 6, progress: 0.4 });
    expect(out[0]).toEqual({ name: "需求", start: 1, end: 3 });
  });

  test("进度超出 0..1 被夹取", () => {
    const out = pasteTasks([], [["A", "1", "5", "2"]], { r: 0, c: 0 });
    expect(out[0]?.progress).toBe(1);
  });
});

test("chartDataModeOf 按类型分流", () => {
    expect(chartDataModeOf("scatter")).toBe("points");
    expect(chartDataModeOf("bubble")).toBe("points");
    expect(chartDataModeOf("gantt")).toBe("tasks");
    expect(chartDataModeOf("bar")).toBe("category");
    expect(chartDataModeOf(undefined)).toBe("category");
});
