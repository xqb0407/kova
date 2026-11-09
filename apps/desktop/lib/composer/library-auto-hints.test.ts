import { describe, expect, it } from "bun:test";
import {
  autoHintText,
  buildLibraryHintsBlock,
  hintTerms,
  rankHintEntries,
} from "./library-auto-hints";
import type { LibraryIndexEntry } from "@/lib/workspace/library-index";

const entry = (
  rel: string,
  name: string,
  title = "",
  tags: string[] = [],
  modified = "2026-01-01T00:00:00.000Z",
): LibraryIndexEntry => ({ rel, name, size: 0, modified, title, tags });

const entries = [
  entry("项目/demo/部署.md", "部署.md", "部署手册", ["ops"]),
  entry("项目/demo/迁移.md", "迁移.md", "数据库迁移", ["db"]),
  entry("项目/demo/周报.md", "周报.md", "周报", ["weekly"]),
];

describe("autoHintText", () => {
  it("剥掉芯片和隐藏块，只留纯文本", () => {
    expect(
      autoHintText(
        "看下 :library[手册]{name=library:a.md:%2Fl%2Fa.md} 的部署\n\n[[library-refs:x]]\n路径\n[[/library-refs:x]]",
      ),
    ).toBe("看下 的部署");
  });

  it("命令/提及开头不触发；太短不触发", () => {
    expect(autoHintText("/compact")).toBe("");
    expect(autoHintText("@agent 你好")).toBe("");
    expect(autoHintText("好")).toBe("");
  });
});

describe("hintTerms", () => {
  it("中文取 bigram 并过滤功能词", () => {
    const terms = hintTerms("上次那个部署笔记怎么迁移");
    expect(terms).toContain("部署");
    expect(terms).toContain("迁移");
    expect(terms).not.toContain("上次");
    expect(terms).not.toContain("那个");
    expect(terms).not.toContain("笔记");
  });

  it("英文按词切分，忽略短词与停用词", () => {
    const terms = hintTerms("please check the deployment notes");
    expect(terms).toContain("check");
    expect(terms).toContain("deployment");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("notes");
  });
});

describe("rankHintEntries", () => {
  it("标题/标签/文件名命中按权重排序", () => {
    const hits = rankHintEntries(entries, "部署 迁移");
    expect(hits[0]?.rel).toBe("项目/demo/部署.md");
    expect(hits.map((hit) => hit.rel)).toContain("项目/demo/迁移.md");
  });

  it("已引用的条目排除，低分条目不凑数", () => {
    const hits = rankHintEntries(
      entries,
      "部署",
      new Set(["项目/demo/部署.md"]),
    );
    expect(hits).toHaveLength(0);
  });

  it("limit 生效", () => {
    const hits = rankHintEntries(entries, "周报", new Set(), 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rel).toBe("项目/demo/周报.md");
  });
});

describe("buildLibraryHintsBlock", () => {
  it("带随机边界，列出标题与路径", () => {
    const block = buildLibraryHintsBlock([entries[0]!], "abc123");
    expect(block.startsWith("[[library-hints:abc123]]")).toBe(true);
    expect(block).toContain("部署手册");
    expect(block).toContain("path: 项目/demo/部署.md");
    expect(block.endsWith("[[/library-hints:abc123]]")).toBe(true);
  });

  it("空列表返回空串", () => {
    expect(buildLibraryHintsBlock([], "x")).toBe("");
  });
});
