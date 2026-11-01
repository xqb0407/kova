import { describe, expect, test } from "bun:test";
import { mergeModelRowUpdate } from "../../src/model/catalog";
import type { ModelRow } from "../../src/storage/hostdb";

const row = (over: Partial<ModelRow> & { modelId: string }): ModelRow => ({
  provider: "p",
  name: null,
  reasoning: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  cost: null,
  promptCache: null,
  enabled: true,
  ...over,
});

describe("mergeModelRowUpdate（单行更新合并进整包替换）", () => {
  test("兄弟行原样保留（attrs 往返无损），被编辑行替换", () => {
    const rows: ModelRow[] = [
      row({ modelId: "a", contextWindow: 128_000, enabled: false }),
      row({ modelId: "b", name: "B", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      row({ modelId: "c" }),
    ];
    const merged = mergeModelRowUpdate(rows, {
      modelId: "b",
      enabled: true,
      name: "B2",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: null,
      input: ["text", "image"],
      cost: null,
      promptCache: null,
    });
    // 兄弟行保留（含 enabled=false 的过滤行与 cost 覆盖）
    expect(merged.map((m) => m.modelId)).toEqual(["a", "c", "b"]);
    expect(merged[0]).toMatchObject({ modelId: "a", enabled: false, contextWindow: 128_000 });
    expect(merged[1]).toMatchObject({ modelId: "c", name: null });
    // 被编辑行是新 item
    expect(merged[2]).toMatchObject({ modelId: "b", name: "B2", reasoning: true, contextWindow: 200_000 });
  });

  test("空行表（首次晋升/目录外新增）只写本行", () => {
    const merged = mergeModelRowUpdate([], { modelId: "x", enabled: true });
    expect(merged).toEqual([{ modelId: "x", enabled: true }]);
  });

  test("同 modelId 只保留编辑后的那一份", () => {
    const rows: ModelRow[] = [row({ modelId: "a", name: "old" })];
    const merged = mergeModelRowUpdate(rows, { modelId: "a", name: "new" });
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("new");
  });
});
