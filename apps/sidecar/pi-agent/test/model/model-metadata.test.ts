import { describe, expect, test } from "bun:test";
import { parseFetchedModelList } from "../../src/model/model-metadata";

describe("parseFetchedModelList", () => {
  test("抽出 id 与常见 context/max 元数据别名", () => {
    const parsed = parseFetchedModelList({
      data: [
        { id: "m1", context_length: 1_000_000, max_completion_tokens: 8_192 },
        { id: "m2", max_model_len: "131072", max_output_tokens: "16384" },
        { id: "m3", context_window: 200_000 },
        { id: "m4" },
      ],
    });
    expect(parsed.models).toEqual(["m1", "m2", "m3", "m4"]);
    expect(parsed.details).toEqual([
      { id: "m1", contextLength: 1_000_000, maxTokens: 8_192 },
      { id: "m2", contextLength: 131_072, maxTokens: 16_384 },
      { id: "m3", contextLength: 200_000 },
    ]);
  });

  test("数字字符串支持 k/M 后缀", () => {
    const parsed = parseFetchedModelList({
      data: [{ id: "m", context_length: "128k", max_output_tokens: "1M" }],
    });
    expect(parsed.details).toEqual([
      { id: "m", contextLength: 128_000, maxTokens: 1_000_000 },
    ]);
  });

  test("裸数组、字符串条目、去重与非法值", () => {
    const parsed = parseFetchedModelList([
      "m1",
      { id: "m1", context_length: 999_999 },
      { id: " m2 ", context_length: 0, max_tokens: -1 },
      { id: "m3", context_length: "not-a-number" },
      null,
    ]);
    expect(parsed.models).toEqual(["m1", "m2", "m3"]);
    // 重复 id 只保留第一次；0/负数/非数字不产生 details
    expect(parsed.details).toEqual([]);
  });

  test("空/畸形载荷返回空列表", () => {
    expect(parseFetchedModelList(undefined)).toEqual({ models: [], details: [] });
    expect(parseFetchedModelList({})).toEqual({ models: [], details: [] });
    expect(parseFetchedModelList({ data: "nope" })).toEqual({
      models: [],
      details: [],
    });
  });
});
