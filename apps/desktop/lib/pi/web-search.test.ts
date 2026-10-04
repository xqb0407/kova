import { describe, expect, test } from "bun:test";
import { parseWebSearchResults } from "@/lib/pi/web-search";

describe("parseWebSearchResults", () => {
  test("解析 sidecar renderSearchResults 的固定格式", () => {
    const text = [
      'Web search results for "鹈鹕 跑步":',
      "",
      "- 鹈鹕为什么会跑步",
      "  https://example.com/pelican",
      "  一种解释是它们用脚散热。",
      "  (source: 自然杂志)",
      "",
      "- 跑步的鹈鹕 - 维基百科",
      "  https://wiki.example.org/pelican-run",
      "  鹈鹕属鸟类行为条目。",
    ].join("\n");
    const items = parseWebSearchResults(text);
    expect(items).toHaveLength(2);
    expect(items?.[0]).toEqual({
      title: "鹈鹕为什么会跑步",
      url: "https://example.com/pelican",
      snippet: "一种解释是它们用脚散热。",
    });
    expect(items?.[1]?.url).toBe("https://wiki.example.org/pelican-run");
  });

  test("无 header（纯文本兜底）返回 null", () => {
    expect(parseWebSearchResults("some raw search dump\n\nmore text")).toBeNull();
  });

  test("只有标题没有 url/摘要也能成条目", () => {
    const text =
      'Web search results for "q":\n\n- 标题一\n\n- 标题二\n  https://b.com';
    const items = parseWebSearchResults(text);
    expect(items).toHaveLength(2);
    expect(items?.[0]).toEqual({ title: "标题一", url: undefined, snippet: undefined });
    expect(items?.[1]?.url).toBe("https://b.com");
  });
});
