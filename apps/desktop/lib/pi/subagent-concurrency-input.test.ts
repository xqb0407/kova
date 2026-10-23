import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
} from "pi-protocol";
import { normalizeSubagentConcurrencyInput } from "./subagent-concurrency-input";

describe("normalizeSubagentConcurrencyInput", () => {
  test("空串/空白/非数字回退当前值，而不是把空串当 0", () => {
    expect(normalizeSubagentConcurrencyInput("", 8)).toBe(8);
    expect(normalizeSubagentConcurrencyInput("   ", 5)).toBe(5);
    expect(normalizeSubagentConcurrencyInput("abc", 8)).toBe(8);
  });

  test("合法值取整并钳到共享范围", () => {
    expect(normalizeSubagentConcurrencyInput("5.6", 8)).toBe(6);
    expect(normalizeSubagentConcurrencyInput("-3", 8)).toBe(
      SUBAGENT_MAX_CONCURRENCY_MIN,
    );
    expect(normalizeSubagentConcurrencyInput("99", 8)).toBe(
      SUBAGENT_MAX_CONCURRENCY_MAX,
    );
  });
});
