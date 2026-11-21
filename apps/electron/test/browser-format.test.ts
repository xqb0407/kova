import { describe, expect, test } from "bun:test";
import {
  EVALUATED_VALUE_MAX_CHARS,
  boundedJsonText,
  formatEvaluatedValue,
} from "../main/browser-format";

describe("boundedJsonText", () => {
  test("小对象输出紧凑 JSON，未截断", () => {
    const { text, truncated } = boundedJsonText({ a: 1, b: [true, "x"] }, 1000);
    expect(truncated).toBe(false);
    expect(JSON.parse(text)).toEqual({ a: 1, b: [true, "x"] });
  });

  test("预算到顶立即停，输出不超过 maxChars", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `value-${i}`);
    const { text, truncated } = boundedJsonText(big, 1000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  test("循环引用与 getter 异常都不抛", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    Object.defineProperty(obj, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    const { text } = boundedJsonText(obj, 1000);
    expect(text).toContain('"[Circular]"');
    expect(text).toContain('"[Thrown]"');
  });

  test("超长字符串在值内先截到 2000 字符", () => {
    const { text } = boundedJsonText({ s: "x".repeat(50_000) }, 10_000);
    expect(text.length).toBeLessThan(3_000);
  });

  test("共享引用正常展开，只有真正的环标 Circular", () => {
    const shared = { x: 1 };
    const { text } = boundedJsonText({ a: shared, b: shared }, 1_000);
    expect(JSON.parse(text)).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  test("revoke 的 Proxy 不抛错，降级为 Unserializable", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    let text = "";
    try {
      text = boundedJsonText(revocable.proxy, 1_000).text;
    } catch {
      text = "THREW";
    }
    expect(text).not.toBe("THREW");
    expect(text).toContain("Unserializable");
  });
});

describe("formatEvaluatedValue", () => {
  test("字符串先截断再拼标记，不再整包保留", () => {
    const out = formatEvaluatedValue("a".repeat(EVALUATED_VALUE_MAX_CHARS + 10));
    expect(out.length).toBeLessThan(EVALUATED_VALUE_MAX_CHARS + 20);
    expect(out.endsWith("…[截断]")).toBe(true);
  });

  test("undefined / 基本值保持可读", () => {
    expect(formatEvaluatedValue(undefined)).toBe("undefined");
    expect(formatEvaluatedValue(42)).toBe("42");
    expect(formatEvaluatedValue(null)).toBe("null");
  });

  test("超长数组只保留前 200 项并标注省略数", () => {
    const out = formatEvaluatedValue({ rows: Array.from({ length: 5000 }, (_, i) => `row-${i}`) });
    expect(out).toContain("…+4800");
    expect(out.length).toBeLessThanOrEqual(EVALUATED_VALUE_MAX_CHARS + 8);
  });

  test("大对象在预算内截断", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`key${i}`, "x".repeat(500)]),
    );
    const out = formatEvaluatedValue(wide);
    expect(out.length).toBeLessThanOrEqual(EVALUATED_VALUE_MAX_CHARS + 8);
    expect(out.endsWith("…[截断]")).toBe(true);
  });

  test("function 不输出完整源码，也不超过预算", () => {
    const huge = new Function("return " + JSON.stringify("x".repeat(100_000)));
    const out = formatEvaluatedValue(huge);
    expect(out).toBe('"[Function]"');
    expect(out.length).toBeLessThan(EVALUATED_VALUE_MAX_CHARS);
  });

  test("revoke 的 Proxy 不抛错", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    let out = "";
    try {
      out = formatEvaluatedValue(revocable.proxy);
    } catch {
      out = "THREW";
    }
    expect(out).not.toBe("THREW");
    expect(out).toContain("Unserializable");
  });
});
