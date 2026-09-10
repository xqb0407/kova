import { describe, expect, test } from "bun:test";
import { globToRegExp } from "./tools";

describe("globToRegExp", () => {
  test("**/ 前缀匹配任意深度（含零层）", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/lib/deep/a.ts")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
  });

  test("* 不跨路径分隔符", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(false);
  });

  test("**.ext 匹配跨层", () => {
    const re = globToRegExp("src**.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src.ts")).toBe(true);
  });

  test("? 匹配单个字符", () => {
    const re = globToRegExp("a?c.ts");
    expect(re.test("abc.ts")).toBe(true);
    expect(re.test("ac.ts")).toBe(false);
    expect(re.test("abbc.ts")).toBe(false);
  });

  test("正则元字符按字面量处理", () => {
    const re = globToRegExp("a(b).ts");
    expect(re.test("a(b).ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  test("大小写不敏感（Windows 友好）", () => {
    expect(globToRegExp("*.TS").test("a.ts")).toBe(true);
  });
});
