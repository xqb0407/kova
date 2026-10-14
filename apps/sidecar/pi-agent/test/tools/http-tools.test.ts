import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildWebTools,
  fetchHeadline,
  normalizeResults,
  parseSearchResults,
} from "../../src/tools/http-tools";
import { resetMirrorConfigForTest, setMirrorConfigForTest } from "../../src/tools/mirror-config";
import { getTransport, setTransport } from "../../src/storage/hostdb/transport";

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

  test("deepcode 代理的 link 字段归一为 url（url 优先）", () => {
    const items = [
      { title: "A", link: "https://a.dev", snippet: "s" },
      { title: "B", url: "https://b.dev", link: "https://wrong.dev" },
    ];
    const results = normalizeResults(items);
    expect(results[0].url).toBe("https://a.dev");
    expect(results[1].url).toBe("https://b.dev");
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

/**
 * WebFetch 的加速改写走的是「改 URL → hostHttpCall」这条路，所以这里注入一个
 * 假传输，直接看发出去的是什么 URL、以及回给模型的文本有没有说明改了。
 */
describe("WebFetch 访问加速（镜像改写）", () => {
  const sent: Record<string, unknown>[] = [];
  let previousTransport: ReturnType<typeof getTransport> = null;

  beforeEach(() => {
    sent.length = 0;
    previousTransport = getTransport();
    setTransport(async (_kind, params) => {
      const inner = (params as { params: Record<string, unknown> }).params;
      sent.push(inner);
      return {
        output: "hello",
        status: 200,
        statusText: "OK",
        ok: true,
        url: String(inner.url),
        contentType: "text/plain",
        headers: {},
        totalBytes: 5,
        truncated: false,
        encoding: "utf-8",
      };
    });
  });

  afterEach(() => {
    setTransport(previousTransport);
    resetMirrorConfigForTest();
  });

  const fetchUrl = (url: string, headers?: Record<string, string>) =>
    buildWebTools("/tmp")[0]!.execute("t1", { url, headers }, undefined) as Promise<{
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
    }>;

  test("命中规则时改走镜像，并在结果里说明（否则模型会以为读的是源站）", async () => {
    setMirrorConfigForTest({ enabled: true, githubPrefix: "https://ghfast.top" });
    const res = await fetchUrl("https://raw.githubusercontent.com/o/r/main/a.ts");
    expect(sent[0]!.url).toBe(
      "https://ghfast.top/https://raw.githubusercontent.com/o/r/main/a.ts",
    );
    const text = res.content[0]!.text;
    expect(text).toContain("[access acceleration]");
    expect(text).toContain("do not prepend a mirror yourself");
    expect(res.details.accel).toEqual({
      from: "https://raw.githubusercontent.com/o/r/main/a.ts",
      to: "https://ghfast.top/https://raw.githubusercontent.com/o/r/main/a.ts",
    });
  });

  test("开关关闭 / 未命中主机时不改写，也不加注记", async () => {
    setMirrorConfigForTest({ enabled: false });
    await fetchUrl("https://raw.githubusercontent.com/o/r/main/a.ts");
    expect(sent[0]!.url).toBe("https://raw.githubusercontent.com/o/r/main/a.ts");

    setMirrorConfigForTest({ enabled: true });
    const res = await fetchUrl("https://example.com/a.ts");
    expect(sent.at(-1)!.url).toBe("https://example.com/a.ts");
    expect(res.content[0]!.text).not.toContain("[access acceleration]");
    expect(res.details.accel).toBeUndefined();
  });

  test("带凭据的请求不改写（token 不发给第三方加速站）", async () => {
    setMirrorConfigForTest({ enabled: true, githubPrefix: "https://ghfast.top" });
    await fetchUrl("https://raw.githubusercontent.com/o/r/main/a.ts", {
      Authorization: "Bearer secret",
    });
    expect(sent[0]!.url).toBe("https://raw.githubusercontent.com/o/r/main/a.ts");
  });
});
