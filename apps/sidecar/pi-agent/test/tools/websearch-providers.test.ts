import { describe, expect, test } from "bun:test";
import type { HostHttpData } from "../../src/storage/hostdb";
import {
  defaultCustomProvider,
  makePresetProvider,
} from "../../src/tools/websearch/config";
import {
  buildSearchRequest,
  parseSearchResponse,
  pickPath,
} from "../../src/tools/websearch/providers";

const httpData = (
  output: string,
  contentType = "application/json",
  extra: Partial<HostHttpData> = {},
): HostHttpData => ({
  output,
  status: 200,
  statusText: "OK",
  ok: true,
  url: "https://api.example.com",
  contentType,
  headers: {},
  totalBytes: output.length,
  truncated: false,
  encoding: "utf-8",
  ...extra,
});

describe("预置请求构造", () => {
  test("DeepSeek：Bearer + query/count/need_content；缺 key 抛错", () => {
    const provider = makePresetProvider("deepseek");
    const req = buildSearchRequest(provider, "bun runtime", {
      maxResults: 5,
      apiKey: "sk-test",
    });
    expect(req.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.body).toEqual({ query: "bun runtime", count: 5, need_content: false });
    expect(() =>
      buildSearchRequest(provider, "q", { maxResults: 5 }),
    ).toThrow(/API key/);
  });

  test("Tavily / Exa：Bearer + max_results / numResults", () => {
    const tavily = buildSearchRequest(makePresetProvider("tavily"), "q", {
      maxResults: 4,
      apiKey: "tvly-x",
    });
    expect(tavily.url).toBe("https://api.tavily.com/search");
    expect(tavily.body).toMatchObject({ query: "q", max_results: 4 });
    expect(tavily.headers.Authorization).toBe("Bearer tvly-x");

    const exa = buildSearchRequest(makePresetProvider("exa"), "q", {
      maxResults: 3,
      apiKey: "exa-x",
    });
    expect(exa.url).toBe("https://api.exa.ai/search");
    expect(exa.body).toMatchObject({
      query: "q",
      numResults: 3,
      contents: { text: false, highlights: true },
    });
  });

  test("Brave：GET 参数 + X-Subscription-Token", () => {
    const req = buildSearchRequest(makePresetProvider("brave"), "bun runtime", {
      maxResults: 6,
      apiKey: "brv-x",
    });
    expect(req.method).toBe("GET");
    expect(req.url).toContain("https://api.search.brave.com/res/v1/web/search?");
    expect(req.url).toContain("q=bun+runtime");
    expect(req.url).toContain("count=6");
    expect(req.url).toContain("extra_snippets=true");
    expect(req.headers["X-Subscription-Token"]).toBe("brv-x");
  });

  test("SearXNG：实例根补 /search + format=json；缺实例地址抛错", () => {
    const provider = {
      ...makePresetProvider("searxng"),
      baseUrl: "https://searx.example.com/",
    };
    const req = buildSearchRequest(provider, "bun", { maxResults: 5 });
    expect(req.url).toContain("https://searx.example.com/search?");
    expect(req.url).toContain("format=json");
    expect(req.url).toContain("q=bun");
    expect(req.headers.Authorization).toBeUndefined();
    expect(() =>
      buildSearchRequest(makePresetProvider("searxng"), "q", { maxResults: 5 }),
    ).toThrow(/instance URL/);
  });

  test("自定义 GET：URL/Header 占位符替换与编码", () => {
    const provider = {
      ...defaultCustomProvider(),
      baseUrl: "https://api.example.com/s?q={{query}}&key={{apiKey}}&n={{count}}",
      method: "GET" as const,
      headers: { Authorization: "Bearer {{apiKey}}" },
    };
    const req = buildSearchRequest(provider, "bun runtime", {
      maxResults: 5,
      apiKey: "sk-test",
    });
    expect(req.url).toContain("q=bun%20runtime");
    expect(req.url).toContain("key=sk-test");
    expect(req.url).toContain("n=5");
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.body).toBeUndefined();
  });

  test("自定义 POST：JSON 转义后必须是合法 JSON；非法模板抛错", () => {
    const provider = {
      ...defaultCustomProvider(),
      baseUrl: "https://api.example.com/search",
      bodyTemplate: '{"q":"{{query}}","n":{{count}},"k":"{{apiKey}}"}',
    };
    const req = buildSearchRequest(provider, 'bun "runtime"', {
      maxResults: 5,
      apiKey: "sk-test",
    });
    expect(req.body).toEqual({ q: 'bun "runtime"', n: 5, k: "sk-test" });

    expect(() =>
      buildSearchRequest(
        { ...provider, bodyTemplate: '{"q": {{query}} }' },
        "q",
        { maxResults: 5 },
      ),
    ).toThrow(/not valid JSON/);
  });

  test("自定义 POST：URL 里的占位符同样替换", () => {
    const provider = {
      ...defaultCustomProvider(),
      baseUrl: "https://api.example.com/search?key={{apiKey}}",
      bodyTemplate: '{"q":"{{query}}"}',
    };
    const req = buildSearchRequest(provider, "bun", {
      maxResults: 5,
      apiKey: "sk-test",
    });
    expect(req.url).toBe("https://api.example.com/search?key=sk-test");
    expect(req.body).toEqual({ q: "bun" });
  });
});

describe("响应解析", () => {
  test("DeepSeek：summary 优先作为摘要，site_name 作为来源", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("deepseek"),
      httpData(
        JSON.stringify({
          results: [
            {
              title: "A",
              url: "https://a.dev",
              snippet: "short",
              summary: "long summary",
              site_name: "a.dev",
            },
          ],
        }),
      ),
    );
    expect(parsed?.results?.[0]).toEqual({
      title: "A",
      url: "https://a.dev",
      snippet: "long summary",
      source: "a.dev",
    });
  });

  test("DeepSeek：summary 为空串时回退 snippet（空串不能挡住回退）", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("deepseek"),
      httpData(
        JSON.stringify({
          results: [
            {
              title: "A",
              url: "https://a.dev",
              summary: "",
              snippet: "short",
            },
          ],
        }),
      ),
    );
    expect(parsed?.results?.[0]?.snippet).toBe("short");
  });

  test("Tavily：content 作为摘要", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("tavily"),
      httpData(
        JSON.stringify({
          results: [
            { title: "T", url: "https://t.dev", content: "tavily content", score: 0.9 },
          ],
        }),
      ),
    );
    expect(parsed?.results?.[0]?.snippet).toBe("tavily content");
  });

  test("Brave：description + extra_snippets 合并", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("brave"),
      httpData(
        JSON.stringify({
          web: {
            results: [
              {
                title: "B",
                url: "https://b.dev",
                description: "desc",
                extra_snippets: ["one", "two", "three"],
              },
            ],
          },
        }),
      ),
    );
    expect(parsed?.results?.[0]?.snippet).toBe("desc · one · two");
  });

  test("Exa：highlights 优先，其次 summary/text", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("exa"),
      httpData(
        JSON.stringify({
          results: [
            {
              title: "E",
              url: "https://e.dev",
              summary: "summary",
              text: "full text",
              highlights: ["highlight one", "highlight two"],
            },
          ],
        }),
      ),
    );
    expect(parsed?.results?.[0]?.snippet).toBe("highlight one");
  });

  test("SearXNG：content 作为摘要", () => {
    const parsed = parseSearchResponse(
      makePresetProvider("searxng"),
      httpData(
        JSON.stringify({
          results: [{ title: "S", url: "https://s.dev", content: "searx content" }],
        }),
      ),
    );
    expect(parsed?.results?.[0]?.snippet).toBe("searx content");
  });

  test("自定义：点路径取数组与字段（含数组下标）", () => {
    const provider = {
      ...defaultCustomProvider(),
      resultsPath: "data.0.items",
      titlePath: "name",
      urlPath: "link",
      snippetPath: "desc",
      sourcePath: "site",
    };
    const parsed = parseSearchResponse(
      provider,
      httpData(
        JSON.stringify({
          data: [
            {
              items: [
                {
                  name: "C",
                  link: "https://c.dev",
                  desc: "custom desc",
                  site: "c.dev",
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(parsed?.results?.[0]).toEqual({
      title: "C",
      url: "https://c.dev",
      snippet: "custom desc",
      source: "c.dev",
    });
    expect(pickPath({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
  });

  test("custom：results 数组归一（link 字段也认）、空数组判空", () => {
    const provider = {
      ...defaultCustomProvider(),
      baseUrl: "https://api.example.com/search",
    };
    const results = parseSearchResponse(
      provider,
      httpData(
        JSON.stringify({
          results: [{ title: "D", link: "https://d.dev", snippet: "s" }],
        }),
      ),
    );
    expect(results?.results?.[0]?.url).toBe("https://d.dev");

    // 空 results = 没搜到，不能把 JSON 外壳当结果返回
    expect(
      parseSearchResponse(provider, httpData(JSON.stringify({ results: [] }))),
    ).toBeUndefined();
  });

  test("非 2xx / 非 JSON 响应返回 undefined（runner 切下一家）", () => {
    expect(
      parseSearchResponse(
        makePresetProvider("tavily"),
        httpData("{}", "application/json", { ok: false, status: 500 }),
      ),
    ).toBeUndefined();
    expect(
      parseSearchResponse(makePresetProvider("brave"), httpData("<html>", "text/html")),
    ).toBeUndefined();
  });
});
