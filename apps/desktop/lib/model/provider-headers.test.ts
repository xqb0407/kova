import { describe, expect, test } from "bun:test";
import { headerRecordToRows, headerRowsToRecord } from "./provider-headers";

describe("headerRowsToRecord", () => {
  test("跳过空名行，名与值都 trim", () => {
    expect(
      headerRowsToRecord([
        { name: " X-Api-Version ", value: " 2026-01 " },
        { name: "   ", value: "忽略" },
        { name: "", value: "" },
      ]),
    ).toEqual({ "X-Api-Version": "2026-01" });
  });

  test("同名以最后一行为准", () => {
    expect(
      headerRowsToRecord([
        { name: "X-Org", value: "old" },
        { name: "X-Org", value: "new" },
      ]),
    ).toEqual({ "X-Org": "new" });
  });

  test("空数组 → 空对象", () => {
    expect(headerRowsToRecord([])).toEqual({});
  });

  test("保留空值行（= 发送空值头，不是删除）", () => {
    expect(headerRowsToRecord([{ name: "X-Flag", value: "" }])).toEqual({
      "X-Flag": "",
    });
  });
});

describe("headerRecordToRows", () => {
  test("undefined / 空对象 → 空数组", () => {
    expect(headerRecordToRows(undefined)).toEqual([]);
    expect(headerRecordToRows(null)).toEqual([]);
    expect(headerRecordToRows({})).toEqual([]);
  });

  test("对象 → 行；往返不进位", () => {
    const record = { "X-Org": "team-a", "X-Flag": "" };
    expect(headerRowsToRecord(headerRecordToRows(record))).toEqual(record);
  });
});
