/**
 * JSON 修复层单测：逐类坏写法（实测 AI 最常犯）→ 可解析；合法 JSON 零改动。
 */
import { describe, expect, test } from "bun:test";
import { fixJsonText } from "../src/jsonfix";

const GOOD = '{"a":1,"b":[1,2],"c":{"d":"x"}}';
const p = (r: { text: string }): unknown => JSON.parse(r.text);

describe("合法 JSON 不动", () => {
  test("fast path：逐字节不变、无修复项", () => {
    const r = fixJsonText(GOOD);
    expect(r.text).toBe(GOOD);
    expect(r.fixes).toEqual([]);
    expect(r.changed).toBe(false);
  });
});

describe("外层污染", () => {
  test("BOM 头", () => {
    const r = fixJsonText("\uFEFF" + GOOD);
    expect(r.changed).toBe(true);
    expect(p(r)).toEqual(JSON.parse(GOOD));
    expect(r.fixes.join()).toContain("BOM");
  });
  test("```json 围栏（含语言标注与换行）", () => {
    const r = fixJsonText("```json\n" + GOOD + "\n```\n");
    expect(p(r)).toEqual(JSON.parse(GOOD));
    expect(r.fixes.join()).toContain("围栏");
  });
  test("前后夹带说明文字", () => {
    const r = fixJsonText("好的，这是设计稿：\n" + GOOD + "\n希望满意！");
    expect(p(r)).toEqual(JSON.parse(GOOD));
    expect(r.fixes.join()).toContain("多余文字");
  });
});

describe("结构内修复", () => {
  test("行注释与块注释", () => {
    const r = fixJsonText('{\n // 版本\n "a": 1, /* 中间 */ "b": [1, 2]\n}');
    expect(p(r)).toEqual({ a: 1, b: [1, 2] });
    expect(r.fixes.join()).toContain("行注释");
    expect(r.fixes.join()).toContain("块注释");
  });
  test("尾逗号（对象/数组/嵌套）", () => {
    const r = fixJsonText('{"a":1,"b":[1,2,],"c":{"d":"x",},}');
    expect(p(r)).toEqual({ a: 1, b: [1, 2], c: { d: "x" } });
    expect(r.fixes.join()).toContain("尾逗号");
  });
  test("单引号字符串（内含双引号与转义单引号）", () => {
    const r = fixJsonText(`{'a':'it\\'s "ok"'}`);
    expect(p(r)).toEqual({ a: `it's "ok"` });
    expect(r.fixes.join()).toContain("单引号");
  });
  test("裸键名（常见 JS 字面量写法）", () => {
    const r = fixJsonText('{ a: 1, "b": 2, c_d: { e: [3] } }');
    expect(p(r)).toEqual({ a: 1, b: 2, c_d: { e: [3] } });
    expect(r.fixes.join()).toContain("裸键名");
  });
  test("中文智能引号作键与值", () => {
    const r = fixJsonText('{“名称”:“首页”,“w”:375}');
    expect(p(r)).toEqual({ 名称: "首页", w: 375 });
    expect(r.fixes.join()).toContain("中文引号");
  });
  test("字符串里未转义的换行/制表符", () => {
    const r = fixJsonText('{"t":"第一行\n第二行\t结束"}');
    expect(p(r)).toEqual({ t: "第一行\n第二行\t结束" });
    expect(r.fixes.join()).toContain("换行");
  });
  test("undefined / NaN → null", () => {
    const r = fixJsonText('{"a":undefined,"b":NaN}');
    expect(p(r)).toEqual({ a: null, b: null });
  });
  test("合法但含中文引号的字符串值不被改写语义", () => {
    const r = fixJsonText('{"t":"他说“好”"}');
    expect(p(r)).toEqual({ t: "他说“好”" });
  });
});

describe("截断补全", () => {
  test("结构中途截断：补闭合", () => {
    const r = fixJsonText('{"a":1,"b":[1,2');
    expect(p(r)).toEqual({ a: 1, b: [1, 2] });
    expect(r.fixes.join()).toContain("截断");
  });
  test("悬挂的半截键被剪掉后补闭合", () => {
    const r = fixJsonText('{"a":1,"n');
    expect(p(r)).toEqual({ a: 1 });
  });
  test("数组元素中途截断：弃尾保全完整元素", () => {
    const r = fixJsonText('{"list":[{"id":"a"},{"id":"b"},{"id":"c","na');
    expect(p(r)).toEqual({ list: [{ id: "a" }, { id: "b" }] });
    expect(r.fixes.join()).toContain("截断");
  });
});

describe("综合：一段真实风格的坏 JSON", () => {
  test("注释 + 尾逗号 + 裸键 + 智能引号混合也能救回", () => {
    const bad = `这是一份设计稿：
\`\`\`json
{
  // 页面
  version: 1,
  meta: { “name”: “健身 App”, kind: 'uidesign' },
  pages: [{
    id: "p1", name: "首页",
    nodes: [
      { id: "f1", type: "frame", name: "首页", x: 0, y: 0, w: 375, h: 812, },
    ],
  }],
}
\`\`\`
`;
    const r = fixJsonText(bad);
    const o = p(r) as Record<string, any>;
    expect(o.version).toBe(1);
    expect(o.meta.name).toBe("健身 App");
    expect(o.meta.kind).toBe("uidesign");
    expect(o.pages[0].nodes[0].id).toBe("f1");
    expect(r.fixes.length).toBeGreaterThanOrEqual(4);
  });
});
