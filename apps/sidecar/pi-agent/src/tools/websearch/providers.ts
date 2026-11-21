/**
 * 搜索 provider 的请求构造与响应解析（纯函数，便于单测）。
 *
 * 端点/鉴权按各家官方文档预置；provider.baseUrl 非空时覆盖。
 * 结果统一收窄成 WebSearchResult（title/url/snippet/source），模型可见文本由
 * http-tools.ts 的 renderSearchResults 渲染，保持既有格式（前端引用面板依赖）。
 */
import type { HostHttpData } from "../../storage/hostdb";
import type { WebSearchProvider } from "./config";
import { WEBSEARCH_PRESETS } from "./config";

export type WebSearchResult = {
  title: string;
  url?: string;
  snippet?: string;
  source?: string;
};

/** 一次 provider 尝试要发出去的请求 */
export type WebSearchRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /** 本地截断上限（服务端不透传条数时用） */
  maxResults: number;
};

/** 解析结果：结构化条目优先 */
export type ParsedSearch = {
  results?: WebSearchResult[];
};

const MAX_SNIPPET_CHARS = 800;
const MAX_TITLE_CHARS = 300;

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** 第一个非空字符串：上游偶尔给 summary:"" 但 snippet 有值，不能让空串挡住回退 */
const firstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

/**
 * 把非结构化的搜索结果文本解析成条目：JSON 数组，或
 * markdown 分块（标题行 + URL 行 + 摘要行，块间空行分隔）。解析失败返回 undefined。
 */
export function parseSearchResults(text: string): WebSearchResult[] | undefined {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const results = normalizeResults(parsed);
      if (results.length > 0) return results;
    }
  } catch {
    // 不是 JSON：落到 markdown 分块解析
  }

  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  if (blocks.length < 2) return undefined;

  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const title = lines[0].replace(/^#+\s*/, "").replace(/^\d+[.)]\s*/, "");
    if (!title || title.length > MAX_TITLE_CHARS) continue;
    let url: string | undefined;
    let snippet: string | undefined;
    for (let i = 1; i < lines.length; i++) {
      const urlMatch = lines[i].match(/https?:\/\/[^\s)>]+/);
      if (urlMatch && !url) url = urlMatch[0];
      else if (!snippet) snippet = lines[i];
    }
    results.push({ title, url, snippet: snippet?.slice(0, 500) });
  }
  return results.length >= 2 ? results : undefined;
}

/** 结构化 results 数组（API 直接返回对象列表时）→ 字段收窄 */
export function normalizeResults(items: unknown[]): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.title !== "string") continue;
    results.push({
      title: r.title,
      // 部分上游用 link 字段（不是 url），两者都认
      url:
        typeof r.url === "string"
          ? r.url
          : typeof r.link === "string"
            ? r.link
            : undefined,
      snippet:
        typeof r.snippet === "string"
          ? r.snippet
          : typeof r.description === "string"
            ? r.description
            : undefined,
      source: typeof r.source === "string" ? r.source : undefined,
    });
  }
  return results;
}

/** 点路径取值（"web.results" / "data.items" / 数组数字下标）；空路径返回原值 */
export function pickPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1);

const substitute = (
  template: string,
  values: Record<string, string>,
): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) =>
    values[key] ?? "",
  );

/** 预置默认端点（custom 为空） */
function presetBaseUrl(provider: WebSearchProvider): string {
  if (provider.baseUrl) return provider.baseUrl;
  if (provider.kind === "custom") return "";
  return WEBSEARCH_PRESETS[provider.kind].baseUrl;
}

function requireKey(provider: WebSearchProvider, apiKey: string | undefined): string {
  const key = (apiKey ?? "").trim();
  if (!key) {
    throw new Error(
      `${provider.label || provider.kind}: API key is not configured (Settings → Web Search)`,
    );
  }
  return key;
}

function effectiveMax(globalMax: number): number {
  return Math.min(20, Math.max(1, Math.trunc(globalMax) || 1));
}

/** SearXNG 的 JSON 端点：base 可能已是 /search，也可能只是实例根 */
function searxSearchUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return /\/search$/i.test(trimmed) ? trimmed : `${trimmed}/search`;
}

/**
 * 构造一次搜索请求。缺 key / 缺端点 / 自定义模板非法都抛错（runner 记为该家失败）。
 * apiKey 只用于本次请求，不落配置。
 */
export function buildSearchRequest(
  provider: WebSearchProvider,
  query: string,
  options: { maxResults: number; apiKey?: string },
): WebSearchRequest {
  const maxResults = effectiveMax(options.maxResults);
  switch (provider.kind) {
    case "deepseek": {
      const apiKey = requireKey(provider, options.apiKey);
      return {
        url: presetBaseUrl(provider),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: { query, count: maxResults, need_content: false },
        maxResults,
      };
    }
    case "tavily": {
      const apiKey = requireKey(provider, options.apiKey);
      return {
        url: presetBaseUrl(provider),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          query,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        },
        maxResults,
      };
    }
    case "brave": {
      const apiKey = requireKey(provider, options.apiKey);
      const url = new URL(presetBaseUrl(provider));
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      url.searchParams.set("extra_snippets", "true");
      return {
        url: url.toString(),
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        maxResults,
      };
    }
    case "exa": {
      const apiKey = requireKey(provider, options.apiKey);
      return {
        url: presetBaseUrl(provider),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          query,
          numResults: maxResults,
          type: "auto",
          contents: { text: false, highlights: true },
        },
        maxResults,
      };
    }
    case "searxng": {
      const base = presetBaseUrl(provider);
      if (!base) {
        throw new Error(
          `${provider.label || "SearXNG"}: instance URL is not configured`,
        );
      }
      const url = new URL(searxSearchUrl(base));
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", "1");
      const key = (options.apiKey ?? "").trim();
      return {
        url: url.toString(),
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        maxResults,
      };
    }
    case "custom": {
      const apiKey = (options.apiKey ?? "").trim();
      if (!provider.baseUrl) {
        throw new Error(
          `${provider.label || "Custom"}: request URL is not configured`,
        );
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(provider.headers)) {
        headers[name] = substitute(value, { apiKey });
      }
      const urlValues = {
        query: encodeURIComponent(query),
        count: String(maxResults),
        apiKey: encodeURIComponent(apiKey),
      };
      if (provider.method === "GET") {
        const hasQuery = /\{\{\s*query\s*\}\}/.test(provider.baseUrl);
        let url = substitute(provider.baseUrl, urlValues);
        if (!hasQuery) {
          url += `${url.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
        }
        return { url, method: "GET", headers, maxResults };
      }
      let body: unknown;
      const template = provider.bodyTemplate.trim();
      if (template) {
        const filled = substitute(template, {
          query: jsonEscape(query),
          count: String(maxResults),
          apiKey: jsonEscape(apiKey),
        });
        try {
          body = JSON.parse(filled);
        } catch {
          throw new Error(
            `${provider.label || "Custom"}: request body template is not valid JSON`,
          );
        }
      }
      return {
        // POST 的 URL 同样支持占位符（query/count/apiKey 放 query string 的接口）
        url: substitute(provider.baseUrl, urlValues),
        method: "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
        maxResults,
      };
    }
  }
}

/** 单条结果的公共收窄（字段名来自各家响应） */
function toResult(
  title: unknown,
  url: unknown,
  snippet: unknown,
  source?: unknown,
): WebSearchResult | null {
  const name = clip(title, MAX_TITLE_CHARS);
  if (!name) return null;
  return {
    title: name,
    url: str(url) || undefined,
    snippet: clip(snippet, MAX_SNIPPET_CHARS) || undefined,
    source: clip(source, 200) || undefined,
  };
}

function mapItems(items: unknown): WebSearchResult[] {
  if (!Array.isArray(items)) return [];
  const out: WebSearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const result = toResult(
      r.title,
      firstText(r.url, r.link),
      firstText(r.snippet, r.content, r.description, r.summary),
      firstText(r.source, r.site_name),
    );
    if (result) out.push(result);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 解析一次 provider 响应。返回 undefined = 这一家不可用（HTTP 非 2xx / 空结果 /
 * 无法识别），调用方记为该次搜索失败。
 */
export function parseSearchResponse(
  provider: WebSearchProvider,
  data: HostHttpData,
): ParsedSearch | undefined {
  if (!data.ok) return undefined;
  const text = data.output ?? "";

  switch (provider.kind) {
    case "deepseek": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const items = pickPath(json, "results");
      if (!Array.isArray(items)) return undefined;
      const results: WebSearchResult[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const result = toResult(
          r.title,
          r.url,
          firstText(r.summary, r.snippet, r.content),
          r.site_name,
        );
        if (result) results.push(result);
      }
      return results.length > 0 ? { results } : undefined;
    }
    case "tavily": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const results = mapItems(pickPath(json, "results"));
      return results.length > 0 ? { results } : undefined;
    }
    case "brave": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const items = pickPath(json, "web.results");
      if (!Array.isArray(items)) return undefined;
      const results: WebSearchResult[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const extras = Array.isArray(r.extra_snippets)
          ? r.extra_snippets.filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
          : [];
        const snippet = [str(r.description), ...extras.slice(0, 2)]
          .filter(Boolean)
          .join(" · ");
        const result = toResult(r.title, r.url, snippet);
        if (result) results.push(result);
        if (results.length >= 20) break;
      }
      return results.length > 0 ? { results } : undefined;
    }
    case "exa": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const items = pickPath(json, "results");
      if (!Array.isArray(items)) return undefined;
      const results: WebSearchResult[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const highlights = Array.isArray(r.highlights)
          ? r.highlights.filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
          : [];
        const snippet = firstText(highlights[0], r.summary, r.text);
        const result = toResult(r.title, r.url, snippet);
        if (result) results.push(result);
        if (results.length >= 20) break;
      }
      return results.length > 0 ? { results } : undefined;
    }
    case "searxng": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const results = mapItems(pickPath(json, "results"));
      return results.length > 0 ? { results } : undefined;
    }
    case "custom": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // 非 JSON：用通用 markdown/JSON 解析兜底
        const fallback = parseSearchResults(text);
        return fallback?.length ? { results: fallback } : undefined;
      }
      const container = pickPath(json, provider.resultsPath);
      const items = Array.isArray(container)
        ? container
        : Array.isArray(json)
          ? json
          : undefined;
      if (!items) {
        const fallback = parseSearchResults(text);
        return fallback?.length ? { results: fallback } : undefined;
      }
      const results: WebSearchResult[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const title = firstText(
          pickPath(item, provider.titlePath),
          pickPath(item, "title"),
          pickPath(item, "name"),
        );
        const url = firstText(
          pickPath(item, provider.urlPath),
          pickPath(item, "url"),
          pickPath(item, "link"),
        );
        const snippet = firstText(
          pickPath(item, provider.snippetPath),
          pickPath(item, "snippet"),
          pickPath(item, "content"),
          pickPath(item, "description"),
          pickPath(item, "summary"),
        );
        const source = firstText(
          provider.sourcePath ? pickPath(item, provider.sourcePath) : undefined,
          pickPath(item, "source"),
        );
        const result = toResult(title, url, snippet, source);
        if (result) results.push(result);
        if (results.length >= 20) break;
      }
      return results.length > 0 ? { results } : undefined;
    }
  }
}
