import { describe, expect, it } from "vitest";
import { highlightCode, type Tok } from "./code-highlight";

const colored = (toks: Tok[] | null, c: string) =>
  toks?.filter((t) => t.c === c).map((t) => t.v) ?? [];

describe("highlightCode", () => {
  it("ts：注释/字符串/关键字/函数名各归各位", () => {
    const toks = highlightCode(
      'const x = greet("hi"); // say hi',
      "typescript",
    );
    expect(toks).not.toBeNull();
    expect(colored(toks, "keyword")).toContain("const");
    expect(colored(toks, "string")).toContain('"hi"');
    expect(colored(toks, "title")).toContain("greet");
    expect(colored(toks, "comment")).toContain("// say hi");
  });

  it("token 拼回去与原文逐字相等（组号不错位、不吞字符）", () => {
    const src = `# bash\nfor f in *.ts; do\n  echo "$f" # loop\n  grep -r 'x\\\\' .\ndone\nNUM=42`;
    const toks = highlightCode(src, "sh");
    expect(toks).not.toBeNull();
    expect(toks!.map((t) => t.v).join("")).toBe(src);
  });

  it("json：键是 meta、字符串值是 string", () => {
    const toks = highlightCode('{"a": "b", "n": 1, "ok": true}', "json");
    expect(colored(toks, "meta")).toEqual(['"a"', '"n"', '"ok"']);
    expect(colored(toks, "string")).toContain('"b"');
    expect(colored(toks, "number")).toContain("1");
    expect(colored(toks, "keyword")).toContain("true");
  });

  it("未闭合字符串不炸、未闭合块注释按串吃", () => {
    const toks = highlightCode('let s = "unterminated\nlet t = /* open', "ts");
    expect(toks).not.toBeNull();
    expect(toks!.map((t) => t.v).join("")).toBe(
      'let s = "unterminated\nlet t = /* open',
    );
  });

  it("未知语言与超限块回退 null", () => {
    expect(highlightCode("hello", "klingon")).toBeNull();
    expect(highlightCode("hello", undefined)).toBeNull();
    expect(highlightCode("x".repeat(40_000), "ts")).toBeNull();
  });

  it("diff：+/-/@@ 行着色", () => {
    const toks = highlightCode("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new", "diff");
    expect(colored(toks, "string").some((v) => v.startsWith("+"))).toBe(true);
    expect(colored(toks, "keyword").some((v) => v.startsWith("-"))).toBe(true);
    expect(colored(toks, "meta")).toContain("@@ -1 +1 @@");
  });

  it("python 三引号串整块归 string", () => {
    const toks = highlightCode('def f():\n    return """\nmulti\nline\n"""', "python");
    const strings = colored(toks, "string");
    expect(strings.some((v) => v.includes("multi\nline"))).toBe(true);
  });
});
