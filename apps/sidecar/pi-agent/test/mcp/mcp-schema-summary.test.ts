import { describe, expect, test } from "bun:test";
import {
  needsRawSchema,
  summarizeInputSchema,
} from "../../src/mcp/mcp-schema-summary";
import { truncateUtf8 } from "../../src/utils/text";

describe("summarizeInputSchema", () => {
  test("必填与可选字段", () => {
    const schema = {
      type: "object",
      properties: { text: { type: "string" }, limit: { type: "number" } },
      required: ["text"],
    };
    expect(summarizeInputSchema(schema)).toBe("text: string, limit?: number");
  });

  test("枚举与字面量", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        kind: { const: "x" },
        emptyEnum: { type: "string", enum: [] },
      },
    };
    expect(summarizeInputSchema(schema)).toBe(
      'mode?: "fast"|"slow", kind?: "x", emptyEnum?: string',
    );
  });

  test("数组元素类型", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        matrix: { type: "array", items: { type: "array", items: { type: "number" } } },
      },
    };
    expect(summarizeInputSchema(schema)).toBe("tags?: string[], matrix?: number[][]");
  });

  test("嵌套对象只展开到 maxDepth，深层给省略标记", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            name: { type: "string" },
            inner: { type: "object", properties: { deep: { type: "string" } } },
          },
          required: ["name"],
        },
      },
    };
    expect(summarizeInputSchema(schema)).toBe("config?: { name: string, inner?: {...} }");
  });

  test("缺失/空/非对象 schema 的兜底", () => {
    expect(summarizeInputSchema(undefined)).toBe("(no parameters)");
    expect(summarizeInputSchema({ type: "object", properties: {} })).toBe("(no parameters)");
    expect(summarizeInputSchema({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(summarizeInputSchema({ type: "string" })).toBe("string");
    // 空对象但允许任意键：不能误报"无参数"
    expect(summarizeInputSchema({ type: "object", additionalProperties: true })).toBe(
      "+additional: unknown",
    );
  });

  test("additionalProperties 与参数数量上限", () => {
    expect(
      summarizeInputSchema({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true,
      }),
    ).toBe("a?: string, +additional: unknown");
  });
});

describe("needsRawSchema", () => {
  const simple = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  };

  test("简单 schema 不需要原文", () => {
    const summary = summarizeInputSchema(simple);
    expect(needsRawSchema(simple, summary)).toBe(false);
  });

  test("$ref / 组合子 / 深层嵌套需要原文", () => {
    const ref = { type: "object", properties: { x: { $ref: "#/$defs/X" } } };
    expect(needsRawSchema(ref, summarizeInputSchema(ref))).toBe(true);
    const union = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(needsRawSchema(union, summarizeInputSchema(union))).toBe(true);
    const deep = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } },
      },
    };
    expect(needsRawSchema(deep, summarizeInputSchema(deep))).toBe(true);
  });

  test("超深数组嵌套不爆栈，输出省略标记", () => {
    let inner: unknown = { type: "string" };
    for (let i = 0; i < 200; i += 1) inner = { type: "array", items: inner };
    const schema = { type: "object", properties: { deep: inner } };
    const summary = summarizeInputSchema(schema);
    expect(summary).toContain("[...]");
    expect(needsRawSchema(schema, summary)).toBe(true);
  });

  test("超深 oneOf 链不爆栈", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i += 1) schema = { oneOf: [schema, { type: "number" }] };
    expect(typeof summarizeInputSchema(schema)).toBe("string");
    expect(needsRawSchema(schema, summarizeInputSchema(schema))).toBe(true);
  });
});

describe("truncateUtf8", () => {
  test("按字节切且不产生半个字符", () => {
    expect(truncateUtf8("中文abc", 4)).toBe("中");
    expect(truncateUtf8("中文abc", 6)).toBe("中文");
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});
