/**
 * 表格快照卫生化测试：agent 把无列冻结的 startColumn 写成 -1 会让 Univer
 * 网格静默渲染成空白——归一器把 freeze 钳回合法域（split 非负、无冻结侧
 * start 归零），合法快照零改动。
 */
import { describe, expect, test } from "bun:test";
import { sanitizeSheetSnapshot } from "../src/sheet/sanitize";

describe("sanitizeSheetSnapshot", () => {
  test("负 startColumn 钳到 0（本例：行冻结保留、列侧归零）", () => {
    const out = sanitizeSheetSnapshot({
      sheets: { s1: { freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 } } },
    });
    expect(out.sheets?.s1?.freeze).toEqual({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 });
  });

  test("无冻结侧 start 强制归零；split 非负", () => {
    const out = sanitizeSheetSnapshot({
      sheets: { s1: { freeze: { xSplit: 2, ySplit: 0, startRow: -3, startColumn: 2 } } },
    });
    expect(out.sheets?.s1?.freeze).toEqual({ xSplit: 2, ySplit: 0, startRow: 0, startColumn: 2 });
  });

  test("正常冻结（行+列）原样保留；缺 freeze 不受影响", () => {
    const legal = {
      sheets: {
        a: { freeze: { xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 } },
        b: { name: "无冻结表" },
      },
    };
    const out = sanitizeSheetSnapshot(legal);
    expect(out).toEqual(legal);
  });

  test("字段缺失按 0 兜底", () => {
    const out = sanitizeSheetSnapshot({ sheets: { s: { freeze: {} } } });
    expect(out.sheets?.s?.freeze).toEqual({ xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 });
  });
});

describe("sanitizeSheetSnapshot sheet id 一致性", () => {
  test("id 与键不符/重复 → 以键为准重写（多 sheet 撞 id 的真实病案）", () => {
    const out = sanitizeSheetSnapshot({
      sheets: {
        s1: { id: "sheet-01", freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 } },
        s2: { id: "sheet-01" },
        s3: { id: "sheet-01" },
      },
    });
    expect(out.sheets?.s1?.id).toBe("s1");
    expect(out.sheets?.s2?.id).toBe("s2");
    expect(out.sheets?.s3?.id).toBe("s3");
    // freeze 卫生化同时生效
    expect(out.sheets?.s1?.freeze?.startColumn).toBe(0);
  });

  test("缺 id 补键名；合法 id 原样保留", () => {
    const out = sanitizeSheetSnapshot({
      sheets: { a: {}, b: { id: "b" } },
    });
    expect(out.sheets?.a?.id).toBe("a");
    expect(out.sheets?.b?.id).toBe("b");
  });
});
