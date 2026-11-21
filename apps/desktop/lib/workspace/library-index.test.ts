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
  lastUsed = 0,
): LibraryIndexEntry => ({
  rel,
  name,
  size: 0,
  modified,
  title,
  tags,
  lastUsed,
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

  it("无关键词：最近使用优先于最近修改，笔记仍在文件前", () => {
    const ranked = rankLibraryEntries(
      [
        entry("notes/old-used.md", "old-used.md", "", [], "2026-01-01", 300),
        entry("notes/new-unused.md", "new-unused.md", "", [], "2026-02-01", 0),
        entry("data/file.csv", "file.csv", "", [], "2026-03-01", 400),
      ],
      "",
    );
    expect(ranked.map((e) => e.rel)).toEqual([
      "notes/old-used.md",
      "notes/new-unused.md",
      "data/file.csv",
    ]);
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

  it("preferPrefix：当前工作空间的条目稳定提前（组内次序不变）", () => {
    const scoped = [
      entry("项目/demo/部署.md", "部署.md", "", [], "2026-01-01"),
      entry("notes/a.md", "a.md", "", [], "2026-03-01"),
      entry("项目/demo/周报.md", "周报.md", "", [], "2026-02-01"),
    ];
    // 无关键词：本来按 mtime 倒序（a → 周报 → 部署），前缀命中两项整体提前
    expect(
      rankLibraryEntries(scoped, "", { preferPrefix: "项目/demo/" }).map(
        (e) => e.rel,
      ),
    ).toEqual(["项目/demo/周报.md", "项目/demo/部署.md", "notes/a.md"]);
    // 有关键词：命中分数不变，只做分区
    expect(
      rankLibraryEntries(scoped, "部署", { preferPrefix: "项目/demo/" }).map(
        (e) => e.rel,
      ),
    ).toEqual(["项目/demo/部署.md"]);
  });
});
