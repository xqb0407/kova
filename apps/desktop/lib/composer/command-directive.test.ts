import { describe, expect, test } from "bun:test";
import {
  buildCommandDirective,
  expandCommandDirectives,
  parseCommandDirectiveId,
} from "./command-directive";

describe("buildCommandDirective / parseCommandDirectiveId", () => {
  test("序列化 → 解析回环", () => {
    const chip = buildCommandDirective("init");
    expect(chip).toContain(":command[/init]");
    expect(chip).toContain("name=command:init");
    expect(parseCommandDirectiveId("command:init")).toBe("init");
  });

  test("非法字符剔除；空名返回空串", () => {
    expect(buildCommandDirective("in it")).toBe(buildCommandDirective("init"));
    expect(buildCommandDirective("a]b")).toBe(buildCommandDirective("ab"));
    expect(buildCommandDirective("")).toBe("");
  });

  test("id 不合法返回 null", () => {
    expect(parseCommandDirectiveId("command:1bad")).toBeNull();
    expect(parseCommandDirectiveId("command:")).toBeNull();
    expect(parseCommandDirectiveId("skill:init")).toBeNull();
  });
});

describe("expandCommandDirectives（发送展开）", () => {
  test("芯片 → /name；参数文本保留", () => {
    const chip = buildCommandDirective("init");
    expect(expandCommandDirectives(`${chip} 补充要求`)).toBe("/init 补充要求");
  });

  test("纯文本快路径：无芯片时逐字不变", () => {
    const text = "普通问题 /etc/hosts";
    expect(expandCommandDirectives(text)).toBe(text);
  });

  test("未命中的指令原样保留（不吞用户输入）", () => {
    const text = ":skill[pdf-export]{name=skill:pdf-export} 用一下";
    expect(expandCommandDirectives(text)).toBe(text);
  });

  test("命令芯片与其它芯片混排：只展开命令", () => {
    const chip = buildCommandDirective("review");
    const mixed = `先 :code[a.ts]{name=code:x} 然后 ${chip} 完成`;
    const out = expandCommandDirectives(mixed);
    expect(out).toContain(":code[a.ts]{name=code:x}");
    expect(out).toContain("/review");
    expect(out).not.toContain(":command[");
  });
});
