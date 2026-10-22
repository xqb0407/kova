import { describe, expect, it } from "bun:test";
import {
  rankLibraryEntries,
  type LibraryIndexEntry,
} from "./library-index";

const entry = (
  rel: string,
  name: string,
  title = "",
  tags: string[] = [],
  modified = "2026-01-01T00:00:00.000Z",
): LibraryIndexEntry => ({
  rel,
  name,
  size: 0,
  modified,
  title,
  tags,
});

describe("rankLibraryEntries", () => {
  const entries = [
    entry("notes/a.md", "a.md", "Alpha 计划", ["api"]),
    entry("notes/b.md", "b.md", "Beta", ["api-design"]),
    entry("data/c.csv", "c.csv", "", ["api"]),
  ];

  it("标签命中出现在结果里（主进程 scan 只按文件名，不能先过滤）", () => {
    // 三条都是标签命中（同分），保持输入顺序
    expect(rankLibraryEntries(entries, "api").map((e) => e.rel)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "data/c.csv",
    ]);
    // 带 # 的查询也按标签匹配
    expect(rankLibraryEntries(entries, "#api").map((e) => e.rel)).toContain(
      "notes/a.md",
    );
  });

  it("标题优先于标签，标签优先于文件名", () => {
    const ranked = rankLibraryEntries(
      [
        entry("notes/name-api.md", "name-api.md"),
        entry("notes/tag.md", "tag.md", "", ["api"]),
        entry("notes/title.md", "title.md", "API 设计"),
      ],
      "api",
    );
    expect(ranked.map((e) => e.rel)).toEqual([
      "notes/title.md",
      "notes/tag.md",
      "notes/name-api.md",
    ]);
  });

  it("空 query：笔记在前，其余在后", () => {
    expect(rankLibraryEntries(entries, "").map((e) => e.rel)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "data/c.csv",
    ]);
  });

  it("无命中返回空数组", () => {
    expect(rankLibraryEntries(entries, "不存在的词")).toEqual([]);
  });
});
