/**
 * 联网工具（WebFetch / WebSearch）：schema 留本侧，实际网络执行下沉 Rust 宿主
 * （tool_exec.rs handle_http）——sidecar 是裸 Node 子进程，不在 Tauri 运行时里，
 * 统一由 Rust 发出网络请求（与 bash/read/write/edit 的下沉模式一致）。
 * 结果装配逻辑移植自 harness-x create-http-tools.ts：超时/截断/文本检测在 Rust，
 * 搜索响应解析是纯字符串计算留在本侧。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostHttpCall, type HostHttpData } from "./hostdb";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** WebSearch 后端（deepcode 公共代理：POST { query } → { result } 或纯文本） */
export const WEB_SEARCH_API_URL = "https://deepcode.vegamo.cn/api/plugin/web-search";

/** 搜索结果回给模型的字符上限（与 harness-x 对齐） */
const MAX_SEARCH_CHARS = 30_000;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** 响应状态摘要行（模型与 UI 共用；二进制/截断在各自分支补充） */
export function fetchHeadline(
  data: Pick<HostHttpData, "status" | "statusText" | "contentType" | "totalBytes" | "truncated" | "url">,
): string {
  const meta = [
    `${data.status}${data.statusText ? ` ${data.statusText}` : ""}`,
    data.contentType,
    `${data.totalBytes} bytes`,
    data.truncated ? "(truncated)" : null,
  ].join(" · ");
  return `${meta}\nfinal url: ${data.url}`;
}

export interface WebSearchResult {
  title: string;
  url?: string;
  snippet?: string;
  source?: string;
}

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
    if (!title || title.length > 300) continue;
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
      // deepcode 代理的 result JSON 数组用 link 字段（不是 url），两者都认
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

function renderSearchResults(query: string, results: WebSearchResult[]): string {
  const blocks = results.map((r) => {
    const lines = [`- ${r.title}`];
    if (r.url) lines.push(`  ${r.url}`);
    if (r.snippet) lines.push(`  ${r.snippet}`);
    if (r.source) lines.push(`  (source: ${r.source})`);
    return lines.join("\n");
  });
  return `Web search results for "${query}":\n\n${blocks.join("\n\n")}`;
}

const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute URL to request (http/https)" }),
  method: Type.Optional(
    Type.Union(HTTP_METHODS.map((m) => Type.Literal(m)), { description: "HTTP method (default GET)" }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional request headers" })),
  body: Type.Optional(
    Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
      description:
        "Request body. Strings are sent as-is; objects are JSON-stringified (Content-Type defaults to application/json).",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Per-request timeout in ms (default 30000, max 120000)" }),
  ),
  maxResponseBytes: Type.Optional(
    Type.Number({ description: "Response body cap returned to you (default 2097152, max 10485760; oversized bodies are truncated)" }),
  ),
});

function buildWebFetchTool(cwd: string): AgentTool {
  return {
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Make an HTTP request through the app's network layer and return the response. " +
      "Textual responses (text/*, json, xml…) are returned as-is; images come back inline; " +
      "other binary responses are summarized only. Body is truncated to maxResponseBytes. " +
      "Non-2xx responses are returned, not thrown.\n" +
      "Use for: REST APIs, docs/pages, small assets. Not for streaming or large downloads.",
    parameters: FetchParams,
    execute: async (_id, raw, signal) => {
      const p = raw as {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | Record<string, unknown>;
        timeoutMs?: number;
        maxResponseBytes?: number;
      };
      if (!p.url?.trim()) throw new Error("url is required");
      const data = await hostHttpCall(
        cwd,
        {
          url: p.url.trim(),
          method: p.method ?? "GET",
          headers: p.headers,
          body: p.body,
          timeoutMs: p.timeoutMs,
          maxResponseBytes: p.maxResponseBytes,
        },
        signal ?? undefined,
      );
      const details = {
        status: data.status,
        contentType: data.contentType,
        totalBytes: data.totalBytes,
        truncated: data.truncated,
      };
      const headline = `${(p.method ?? "GET").toUpperCase()} ${p.url.trim()} -> ${fetchHeadline(data)}`;

      if (data.encoding === "base64") {
        if (data.contentType.startsWith("image/")) {
          return {
            content: [
              { type: "text" as const, text: headline },
              { type: "image" as const, data: data.output, mimeType: data.contentType },
            ],
            details,
          };
        }
        return textResult(
          `${headline}\nBinary response (${data.contentType}, ${data.totalBytes} bytes) — body omitted. ` +
            "Use bash + curl to download it to the workspace if needed.",
          details,
        );
      }
      return textResult(`${headline}\n\n${data.output}`, details);
    },
  };
}

function buildWebSearchTool(cwd: string): AgentTool {
  return {
    name: "WebSearch",
    label: "Web Search",
    description:
      "Search the web for up-to-date information: current events, recent releases, " +
      "facts or docs beyond your training cutoff. Returns numbered results with " +
      "title, URL and snippet. Use specific keywords, not full sentences.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords" }),
    }),
    execute: async (_id, raw, signal) => {
      const query = (raw as { query: string }).query?.trim();
      if (!query) throw new Error("query is required");
      const data = await hostHttpCall(
        cwd,
        {
          url: WEB_SEARCH_API_URL,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { query },
        },
        signal ?? undefined,
      );
      if (!data.ok) {
        return textResult(
          `WebSearch API error ${data.status}${data.output ? `: ${data.output.slice(0, 200)}` : ""}`,
          { query, error: true },
        );
      }
      // 兼容三种返回形态：{ result } / { results: [...] } / 纯文本
      let resultText = data.output;
      let results: WebSearchResult[] | undefined;
      if (data.contentType.includes("application/json")) {
        try {
          const json = JSON.parse(data.output) as { result?: unknown; results?: unknown };
          if (Array.isArray(json.results) && json.results.length > 0) {
            results = normalizeResults(json.results);
          }
          if (typeof json.result === "string") resultText = json.result;
        } catch {
          // 非法 JSON：当纯文本处理
        }
      }
      const truncated = resultText.length > MAX_SEARCH_CHARS;
      const trimmed = truncated
        ? resultText.slice(0, MAX_SEARCH_CHARS) + "\n… (truncated)"
        : resultText;
      if (!results || results.length === 0) results = parseSearchResults(trimmed);
      const text = results?.length ? renderSearchResults(query, results) : trimmed;
      return textResult(text, { query, results, truncated });
    },
  };
}

/** 联网工具组：由 buildTools 注册进基础工具集 */
export function buildWebTools(cwd: string): AgentTool[] {
  return [buildWebFetchTool(cwd), buildWebSearchTool(cwd)];
}
