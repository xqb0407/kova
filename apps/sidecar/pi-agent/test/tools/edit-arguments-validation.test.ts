import { describe, expect, test } from "bun:test";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { buildTools } from "../../src/tools/tools";

/**
 * edit 参数兜底 × loop 校验的信任边界。
 *
 * pi-schema 的 obj() 默认 additionalProperties: false：prepareEditArguments
 * 归一成功后如果残留旧形态键（old_string/new_string），会在 loop 校验层被
 * 未知键拒绝——兜底白做。这里逐形态钉住「兜底输出必须能过校验」。
 * 注意：electron 直呼宿主的测试不走 loop 校验，只有这里能守住该边界。
 */
const editTool = buildTools("/tmp", "t-edit-validation").find((tool) => tool.name === "edit")!;

function validatedPrepared(input: Record<string, unknown>): Record<string, unknown> {
  const prepared = editTool.prepareArguments!(structuredClone(input)) as ToolCall["arguments"];
  return validateToolArguments(editTool, {
    type: "toolCall",
    id: "t",
    name: "edit",
    arguments: prepared,
  }) as Record<string, unknown>;
}

describe("edit 参数兜底 × loop 校验", () => {
  test("旧形态 old_string/new_string：归一后过校验且不再带旧键", () => {
    const out = validatedPrepared({ file_path: "a.txt", old_string: "x", new_string: "y" });
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
    expect(out.old_string).toBeUndefined();
    expect(out.new_string).toBeUndefined();
  });

  test("旧形态 + replace_all：replace_all 保留", () => {
    const out = validatedPrepared({
      file_path: "a.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(out.replace_all).toBe(true);
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("edits 吐成 JSON 字符串：还原后过校验", () => {
    const out = validatedPrepared({
      file_path: "a.txt",
      edits: JSON.stringify([{ oldText: "x", newText: "y" }]),
    });
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("edits 单对象没包数组：包装后过校验", () => {
    const out = validatedPrepared({ file_path: "a.txt", edits: { oldText: "x", newText: "y" } });
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("成员级 old_string/new_string 别名：归一后过校验", () => {
    const out = validatedPrepared({ file_path: "a.txt", edits: [{ old_string: "x", new_string: "y" }] });
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("规范形态直通：原样过校验", () => {
    const out = validatedPrepared({ file_path: "a.txt", edits: [{ oldText: "x", newText: "y" }] });
    expect(out.edits).toEqual([{ oldText: "x", newText: "y" }]);
  });

  test("全部落空：保持原样，校验显式拒绝（不给静默空 edits）", () => {
    expect(() =>
      validateToolArguments(editTool, {
        id: "t",
        name: "edit",
        type: "toolCall",
        arguments: editTool.prepareArguments!({ file_path: "a.txt" }) as ToolCall["arguments"],
      }),
    ).toThrow(/Validation failed for tool "edit"/);
  });
});
