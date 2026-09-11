import { describe, expect, test } from "bun:test";
import { fetchHeadline, normalizeResults, parseSearchResults } from "./http-tools";

describe("parseSearchResults", () => {
  test("JSON 数组直接结构化", () => {
    const text = JSON.stringify([
      { title: "A", url: "https://a.dev", snippet: "first" },
      { title: "B", url: "https://b.dev", description: "second" },
    ]);
    const results = parseSearchResults(text);
    expect(results).toHaveLength(2);
    expect(results![0]).toEqual({ title: "A", url: "https://a.dev", snippet: "first", source: undefined });
    // description 归一为 snippet
    expect(results![1].snippet).toBe("second");
  });

  test("markdown 分块解析：标题 + URL + 摘要", () => {
    const text = [
      "## Rust programming language",
      "https://www.rust-lang.org",
      "A language empowering everyone to build reliable software.",
      "",
      "## The Rust Programming Language - Wikipedia",
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "Rust is a multi-paradigm general-purpose programming language.",
    ].join("\n");
    const results = parseSearchResults(text);
    expect(results).toHaveLength(2);
    expect(results![0].title).toBe("Rust programming language");
    expect(results![0].url).toBe("https://www.rust-lang.org");
    expect(results![0].snippet).toContain("empowering");
  });

  test("块数不足或无标题噪声返回 undefined", () => {
    expect(parseSearchResults("just one block, nothing else")).toBeUndefined();
    expect(parseSearchResults("not json at all")).toBeUndefined();
  });
});

describe("normalizeResults", () => {
  test("丢弃无 title 条目并收窄字段类型", () => {
    const items = [
      { title: "ok", url: 123, snippet: null },
      { url: "https://no-title.dev" },
      null,
    ];
    expect(normalizeResults(items)).toEqual([{ title: "ok", url: undefined, snippet: undefined, source: undefined }]);
  });
});

describe("fetchHeadline", () => {
  test("状态行包含 status/contentType/size/截断标记", () => {
    const line = fetchHeadline({
      status: 200,
      statusText: "OK",
      contentType: "application/json",
      totalBytes: 1234,
      truncated: true,
      url: "https://api.example.com/final",
    });
    expect(line).toContain("200 OK");
    expect(line).toContain("application/json");
    expect(line).toContain("1234 bytes");
    expect(line).toContain("(truncated)");
    expect(line).toContain("final url: https://api.example.com/final");
  });
});
