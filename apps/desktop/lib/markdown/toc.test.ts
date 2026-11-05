import { describe, expect, it } from "bun:test";
import {
  buildTocEntries,
  headingSlug,
  tocEqual,
  type TocEntry,
} from "./toc";

describe("headingSlug", () => {
  it("保留中英文与数字，标点折叠成连字符", () => {
    expect(headingSlug("部署 手册 v2.0")).toBe("部署-手册-v2-0");
    expect(headingSlug("Café & Bar")).toBe("cafe-bar");
  });

  it("首尾连字符清掉；空串返回空", () => {
    expect(headingSlug("  -- Hello!! -- ")).toBe("hello");
    expect(headingSlug("!!!")).toBe("");
  });
});

describe("buildTocEntries", () => {
  it("同名标题生成稳定后缀，级别夹到 1..6", () => {
    const entries = buildTocEntries([
      { text: "Intro", level: 1 },
      { text: "Intro", level: 9 },
      { text: "Intro", level: 0 },
    ]);
    expect(entries.map((e) => e.id)).toEqual([
      "md-intro",
      "md-intro-2",
      "md-intro-3",
    ]);
    expect(entries.map((e) => e.level)).toEqual([1, 6, 1]);
  });

  it("空标题跳过，空白折叠，标签截断到 80", () => {
    const entries = buildTocEntries([
      { text: "   ", level: 2 },
      { text: "  A   B  ", level: 2 },
      { text: "x".repeat(200), level: 2 },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.label).toBe("A B");
    expect(entries[1]!.label).toHaveLength(80);
  });

  it("中文标题也能生成锚点", () => {
    expect(buildTocEntries([{ text: "部署手册", level: 2 }])[0]!.id).toBe(
      "md-部署手册",
    );
  });
});

describe("tocEqual", () => {
  const base: TocEntry[] = [{ id: "md-a", label: "A", level: 1 }];

  it("内容相同视为相等（避免 MutationObserver 重扫触发重渲染）", () => {
    expect(tocEqual(base, [{ ...base[0]! }])).toBe(true);
  });

  it("id/label/level/长度任一变化都不等", () => {
    expect(tocEqual(base, [{ ...base[0]!, id: "md-b" }])).toBe(false);
    expect(tocEqual(base, [{ ...base[0]!, label: "B" }])).toBe(false);
    expect(tocEqual(base, [{ ...base[0]!, level: 2 }])).toBe(false);
    expect(tocEqual(base, [])).toBe(false);
  });
});
