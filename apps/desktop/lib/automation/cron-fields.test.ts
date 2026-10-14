import { describe, expect, it } from "bun:test";
import {
  CRON_FIELD_SEQUENCE,
  DEFAULT_CRON_FIELDS,
  cronFieldSpec,
  expandRange,
  isCronComplete,
  parseCron,
  parseCronField,
  serializeCron,
  serializeCronField,
  switchFieldMode,
  type CronField,
} from "./cron-fields";

const min = cronFieldSpec("minute");
const dow = cronFieldSpec("dow");
const dom = cronFieldSpec("dom");

describe("parseCronField", () => {
  it("四种结构化形态", () => {
    expect(parseCronField("*", min)).toEqual({ mode: "every" });
    expect(parseCronField("*/15", min)).toEqual({ mode: "step", step: 15 });
    expect(parseCronField("1-5", dow)).toEqual({ mode: "range", from: 1, to: 5 });
    expect(parseCronField("9", min)).toEqual({ mode: "list", values: [9] });
    expect(parseCronField("0,15,30,45", min)).toEqual({ mode: "list", values: [0, 15, 30, 45] });
  });

  it("列表排序去重；星期 7 归一为 0", () => {
    expect(parseCronField("45,0,15,0", min)).toEqual({ mode: "list", values: [0, 15, 45] });
    expect(parseCronField("7", dow)).toEqual({ mode: "list", values: [0] });
    expect(parseCronField("0,7", dow)).toEqual({ mode: "list", values: [0] });
  });

  it("认不出/越界的写法落 raw 原样保留", () => {
    expect(parseCronField("1-5/2", min)).toEqual({ mode: "raw", text: "1-5/2" });
    expect(parseCronField("60", min)).toEqual({ mode: "raw", text: "60" });
    expect(parseCronField("5-1", min)).toEqual({ mode: "raw", text: "5-1" });
    expect(parseCronField("*/0", min)).toEqual({ mode: "raw", text: "*/0" });
    expect(parseCronField("0-70", min)).toEqual({ mode: "raw", text: "0-70" });
    expect(parseCronField("JAN", min)).toEqual({ mode: "raw", text: "JAN" });
    expect(parseCronField("", min)).toEqual({ mode: "raw", text: "" });
  });
});

describe("serializeCronField", () => {
  it("结构化形态回写", () => {
    expect(serializeCronField({ mode: "every" })).toBe("*");
    expect(serializeCronField({ mode: "step", step: 5 })).toBe("*/5");
    expect(serializeCronField({ mode: "range", from: 1, to: 5 })).toBe("1-5");
    expect(serializeCronField({ mode: "list", values: [0] })).toBe("0");
    expect(serializeCronField({ mode: "list", values: [0, 30] })).toBe("0,30");
    expect(serializeCronField({ mode: "raw", text: "1-5/2" })).toBe("1-5/2");
  });

  it("空值/非法态回 null", () => {
    expect(serializeCronField({ mode: "list", values: [] })).toBeNull();
    expect(serializeCronField({ mode: "step", step: 0 })).toBeNull();
    expect(serializeCronField({ mode: "raw", text: "  " })).toBeNull();
  });
});

describe("parseCron / serializeCron", () => {
  it("往返保真（含 raw 与归一整形）", () => {
    const exprs = [
      "0 9 * * *",
      "*/10 * * * *",
      "0 10 * * 1,3,5",
      "15 12 1 * *",
      "30 8 * * 1-5",
      "0 9 * * 1-5/2",
      "*/5 9 1,15 * *",
    ];
    for (const expr of exprs) {
      const fields = parseCron(expr);
      expect(fields).not.toBeNull();
      expect(serializeCron(fields!)).toBe(expr);
    }
  });

  it("字段数不是 5 回 null", () => {
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("0 9 * * * *")).toBeNull();
    expect(parseCron("")).toBeNull();
  });

  it("序列化按 minute hour dom month dow 顺序", () => {
    const fields = parseCron("30 8 1 * 1-5")!;
    expect(CRON_FIELD_SEQUENCE).toEqual(["minute", "hour", "dom", "month", "dow"]);
    expect(serializeCron(fields)).toBe("30 8 1 * 1-5");
    expect(serializeCron({ ...fields, month: { mode: "list", values: [] } })).toBeNull();
  });
});

describe("isCronComplete", () => {
  it("结构完整才算完整", () => {
    expect(isCronComplete("0 9 * * 1-5")).toBe(true);
    expect(isCronComplete("0 9 * *")).toBe(false);
  });

  it("5 个认不出的词结构上算完整（语义交给 sidecar）", () => {
    expect(isCronComplete("garbage garbage garbage garbage garbage")).toBe(true);
  });
});

describe("expandRange", () => {
  it("含两端展开，倒序回空", () => {
    expect(expandRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(expandRange(5, 5)).toEqual([5]);
    expect(expandRange(5, 1)).toEqual([]);
  });
});

describe("switchFieldMode", () => {
  it("枚举 → 步进：等差才保值", () => {
    const f: CronField = { mode: "list", values: [0, 15, 30, 45] };
    expect(switchFieldMode(f, "step", min)).toEqual({ mode: "step", step: 15 });
    const uneven: CronField = { mode: "list", values: [0, 10, 35] };
    expect(switchFieldMode(uneven, "step", min)).toEqual({ mode: "step", step: 2 });
  });

  it("范围 → 枚举：展开两端", () => {
    const f: CronField = { mode: "range", from: 1, to: 5 };
    expect(switchFieldMode(f, "list", dow)).toEqual({ mode: "list", values: [1, 2, 3, 4, 5] });
  });

  it("步进 → 枚举：从字段下界起", () => {
    const f: CronField = { mode: "step", step: 12 };
    expect(switchFieldMode(f, "list", cronFieldSpec("hour"))).toEqual({
      mode: "list",
      values: [0, 12],
    });
  });

  it("枚举 → 范围：取极值", () => {
    const f: CronField = { mode: "list", values: [3, 9, 15] };
    expect(switchFieldMode(f, "range", dom)).toEqual({ mode: "range", from: 3, to: 15 });
  });

  it("raw 进出一致；其它模式转 raw 先序列化", () => {
    const raw: CronField = { mode: "raw", text: "1-5/2" };
    expect(switchFieldMode(raw, "raw", min)).toEqual(raw);
    expect(switchFieldMode({ mode: "range", from: 1, to: 5 }, "raw", min)).toEqual({
      mode: "raw",
      text: "1-5",
    });
  });

  it("同模式原样返回（引用不变）", () => {
    const f: CronField = { mode: "every" };
    expect(switchFieldMode(f, "every", min)).toBe(f);
  });
});

describe("DEFAULT_CRON_FIELDS", () => {
  it("默认落每天 09:00", () => {
    expect(serializeCron(DEFAULT_CRON_FIELDS)).toBe("0 9 * * *");
  });
});
