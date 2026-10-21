import { describe, expect, test } from "bun:test";

import { splitFrontmatter } from "./markdown-frontmatter";

describe("splitFrontmatter", () => {
  test("技能文件典型形态：引号标量 + 内联数组 + 中文值", () => {
    const src = [
      "---",
      "name: anxin-ppt",
      'zh_name: "安信企业汇报 PPT"',
      'en_name: "Anxin Corporate Deck"',
      'emoji: "🟦"',
      "category: slides",
      'tags: ["deck", "enterprise", "blue-white"]',
      "---",
      " markdown 的语法能不能加上这种的解析。",
    ].join("\n");
    const fm = splitFrontmatter(src);
    expect(fm).not.toBeNull();
    expect(fm?.entries).toEqual([
      ["name", "anxin-ppt"],
      ["zh_name", "安信企业汇报 PPT"],
      ["en_name", "Anxin Corporate Deck"],
      ["emoji", "🟦"],
      ["category", "slides"],
      ["tags", ["deck", "enterprise", "blue-white"]],
    ]);
    expect(fm?.body).toBe(" markdown 的语法能不能加上这种的解析。");
  });

  test("键序保留、值内冒号不截断", () => {
    const fm = splitFrontmatter(
      '---\ndescription: 使用时: 先看说明\n---\n正文',
    );
    expect(fm?.entries).toEqual([["description", "使用时: 先看说明"]]);
    expect(fm?.body).toBe("正文");
  });

  test("普通标量缩进续行按折行语义并入（技能 description 多行写法）", () => {
    const src = [
      "---",
      "name: employee-weekly-report",
      "description: 基于 Jira worklog 生成符合公司规范的员工周报 Word",
      "  文档。当用户说「写/生成周报」、或在本周结束时要求出周报时使用。",
      "  按规范总结 → 确认后输出 docx。",
      "---",
      "正文",
    ].join("\n");
    const fm = splitFrontmatter(src);
    expect(fm?.entries).toEqual([
      ["name", "employee-weekly-report"],
      [
        "description",
        "基于 Jira worklog 生成符合公司规范的员工周报 Word 文档。当用户说「写/生成周报」、或在本周结束时要求出周报时使用。按规范总结 → 确认后输出 docx。",
      ],
    ]);
    expect(fm?.body).toBe("正文");
  });

  test("英文续行补空格，CJK 相邻不补空格", () => {
    const fm = splitFrontmatter("---\ndesc: hello\n  world\n中文: 第一行\n  第二行\n---\nB");
    expect(fm?.entries).toEqual([
      ["desc", "hello world"],
      ["中文", "第一行第二行"],
    ]);
  });

  test("续行在下一条顶格键前停止", () => {
    const fm = splitFrontmatter("---\ndescription: a\n  b\nnext: 1\n---\nB");
    expect(fm?.entries).toEqual([
      ["description", "a b"],
      ["next", "1"],
    ]);
  });

  test("CRLF 下的标量续行", () => {
    const fm = splitFrontmatter("---\r\ndescription: 第一行\r\n  第二行\r\n---\r\n正文");
    expect(fm?.entries).toEqual([["description", "第一行第二行"]]);
    expect(fm?.body).toBe("正文");
  });

  test("块列表（- item 缩进/顶格两种写法）", () => {
    const indented = splitFrontmatter("---\ntags:\n  - deck\n  - enterprise\n---\nB");
    expect(indented?.entries).toEqual([["tags", ["deck", "enterprise"]]]);
    const flush = splitFrontmatter("---\ntags:\n- deck\n- enterprise\n---\nB");
    expect(flush?.entries).toEqual([["tags", ["deck", "enterprise"]]]);
  });

  test("块标量 | 收集缩进行", () => {
    const fm = splitFrontmatter("---\nnotes: |\n  第一行\n  第二行\nnext: 1\n---\nB");
    expect(fm?.entries).toEqual([
      ["notes", "第一行\n第二行"],
      ["next", "1"],
    ]);
  });

  test("块内注释与空行跳过", () => {
    const fm = splitFrontmatter("---\n# 注释\n\nname: a\n\n---\nB");
    expect(fm?.entries).toEqual([["name", "a"]]);
  });

  test("CRLF 换行", () => {
    const fm = splitFrontmatter("---\r\nname: a\r\n---\r\n正文");
    expect(fm?.entries).toEqual([["name", "a"]]);
    expect(fm?.body).toBe("正文");
  });

  test("BOM 前缀", () => {
    const fm = splitFrontmatter("\uFEFF---\nname: a\n---\nB");
    expect(fm?.entries).toEqual([["name", "a"]]);
  });

  test("无 frontmatter：普通文档原样返回 null", () => {
    expect(splitFrontmatter("# 标题\n\n正文")).toBeNull();
    expect(splitFrontmatter("")).toBeNull();
  });

  test("开头 `---` 是水平线 + setext 写法的普通文档不误判", () => {
    const src = "---\n\n# 真标题\n\n普通段落 **加粗**。\n\n---\n\n后续";
    expect(splitFrontmatter(src)).toBeNull();
  });

  test("空 frontmatter 块不误判", () => {
    expect(splitFrontmatter("---\n---\n正文")).toBeNull();
  });

  test("出现无法解析的行整体放弃（按无 frontmatter 渲染）", () => {
    expect(splitFrontmatter("---\nname: a\n*强调* 不是键\n---\nB")).toBeNull();
  });

  test("重复 key 保留首次位置、取最后值", () => {
    const fm = splitFrontmatter("---\nname: a\nname: b\n---\nB");
    expect(fm?.entries).toEqual([["name", "b"]]);
  });

  test("空值渲染为空标量", () => {
    const fm = splitFrontmatter("---\nname:\nother: 1\n---\nB");
    expect(fm?.entries).toEqual([
      ["name", ""],
      ["other", "1"],
    ]);
  });

  test("闭合 --- 后的正文（含分隔线）原样保留", () => {
    const src = "---\nname: a\n---\n# 正文\n\n---\n\n段落";
    const fm = splitFrontmatter(src);
    expect(fm?.body).toBe("# 正文\n\n---\n\n段落");
  });
});
