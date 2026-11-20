/**
 * 联网工具（WebFetch / WebSearch）：schema 留本侧，实际网络执行下沉 Rust 宿主
 * （tool_exec.rs handle_http）——sidecar 是裸 Node 子进程，不在 旧桌面壳 运行时里，
 * 统一由 Rust 发出网络请求（与 bash/read/write/edit 的下沉模式一致）。
 * 结果装配逻辑移植自 harness-x create-http-tools.ts：超时/截断/文本检测在 Rust，
 * 搜索响应解析是纯字符串计算留在本侧。
 */
import { lit, map, num, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SandboxPlan } from "pi-sandbox";
import { hostHttpCall, type HostHttpData } from "../storage/hostdb";
import { activeMirrorPolicy } from "./mirror-config";
import { mirrorUrl, type MirrorMatch } from "./url-mirror";
import { getWebSearchConfig } from "./websearch/config";
import {
  normalizeResults,
  parseSearchResults,
  type WebSearchResult,
} from "./websearch/providers";
import { runWebSearch } from "./websearch/run";

// 结果解析是纯函数，测试与前端共用；保持从本模块导出（旧引用面）
export { normalizeResults, parseSearchResults, type WebSearchResult };

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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

/**
 * 加速注记：改写后必须告诉模型——结果里的 final url 是镜像地址。不说清楚，
 * 模型会以为自己读的是源站，或者下次自己动手拼一个镜像地址（叠两层）。
 */
function accelNote(requested: string, match: MirrorMatch | undefined): string {
  if (!match) return "";
  return (
    `\n[access acceleration] ${requested} was fetched through the mirror ${match.url}. ` +
    "Keep passing the original URL — the app rewrites it automatically; do not prepend a mirror yourself."
  );
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

const FetchParams = obj({
  url: str({ description: "Absolute URL to request (http/https)" }),
  method: opt(
    union(HTTP_METHODS.map((m) => lit(m)), { description: "HTTP method (default GET)" }),
  ),
  headers: opt(map(str(), { description: "Optional request headers" })),
  body: opt(
    union([str(), map(unknown())], {
      description:
        "Request body. Strings are sent as-is; objects are JSON-stringified (Content-Type defaults to application/json).",
    }),
  ),
  timeoutMs: opt(
    num({ description: "Per-request timeout in ms (default 30000, max 120000)" }),
  ),
  maxResponseBytes: opt(
    num({ description: "Response body cap returned to you (default 2097152, max 10485760; oversized bodies are truncated)" }),
  ),
});

type SandboxProvider = () => Promise<SandboxPlan | null> | SandboxPlan | null;

function buildWebFetchTool(cwd: string, getSandbox?: SandboxProvider): AgentTool {
  return {
    name: "WebFetch",
    replay: "safe",
    label: "Web Fetch",
    description:
      "Make an HTTP request through the app's network layer and return the response. " +
      "Textual responses (text/*, json, xml…) are returned as-is; images come back inline; " +
      "other binary responses are summarized only. Body is truncated to maxResponseBytes. " +
      "Non-2xx responses are returned, not thrown.\n" +
      "Known slow hosts (GitHub raw files, release assets, source archives) may be routed " +
      "through a mirror automatically — always pass the original URL, never a mirror URL.\n" +
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
      const requested = p.url.trim();
      // 访问加速：命中规则就把请求改走镜像（带凭据的链接不改，见 url-mirror.ts）
      const policy = activeMirrorPolicy();
      const accel = policy ? mirrorUrl(requested, policy, p.headers) : { url: requested };
      const data = await hostHttpCall(
        cwd,
        {
          url: accel.url,
          method: p.method ?? "GET",
          headers: p.headers,
          body: p.body,
          timeoutMs: p.timeoutMs,
          maxResponseBytes: p.maxResponseBytes,
        },
        signal ?? undefined,
        (await getSandbox?.()) ?? undefined,
      );
      const details: Record<string, unknown> = {
        status: data.status,
        contentType: data.contentType,
        totalBytes: data.totalBytes,
        truncated: data.truncated,
      };
      if (data.sandbox) details.sandbox = data.sandbox;
      if (accel.match) details.accel = { from: requested, to: accel.match.url };
      const headline =
        `${(p.method ?? "GET").toUpperCase()} ${requested} -> ${fetchHeadline(data)}` +
        accelNote(requested, accel.match);

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

function buildWebSearchTool(cwd: string, getSandbox?: SandboxProvider): AgentTool {
  return {
    name: "WebSearch",
    replay: "safe",
    label: "Web Search",
    description:
      "Search the web for up-to-date information: current events, recent releases, " +
      "facts or docs beyond your training cutoff. Returns numbered results with " +
      "title, URL and snippet. Use specific keywords, not full sentences.",
    parameters: obj({
      query: str({ description: "Search keywords" }),
    }),
    execute: async (_id, raw, signal) => {
      const query = (raw as { query: string }).query?.trim();
      if (!query) throw new Error("query is required");
      // 第二道闸：总开关刚关闭、活动会话工具表还没重建时，本轮仍可能带着
      // 旧 schema；execute 实时读配置，关闭后一律拒绝（与 imagegen 同款）
      if (!getWebSearchConfig().enabled) {
        return textResult(
          "WebSearch API error: web search is disabled in settings",
          { query, error: true },
        );
      }
      // 配置在设置页（单一服务）；单次超时/失败处理都在 runWebSearch 内，
      // 这里只负责把结果渲染成既有格式
      const run = await runWebSearch(query, {
        cwd,
        signal: signal ?? undefined,
        sandbox: (await getSandbox?.()) ?? undefined,
      });
      if (!run.ok) {
        return textResult(`WebSearch API error: ${run.error}`, {
          query,
          error: true,
        });
      }
      const rendered = run.results.length
        ? renderSearchResults(query, run.results)
        : (run.text ?? "");
      const truncated = rendered.length > MAX_SEARCH_CHARS;
      const text = truncated
        ? rendered.slice(0, MAX_SEARCH_CHARS) + "\n… (truncated)"
        : rendered;
      return textResult(text, {
        query,
        results: run.results.length ? run.results : undefined,
        provider: run.provider.id,
        truncated,
        ...(run.sandbox ? { sandbox: run.sandbox } : {}),
      });
    },
  };
}

/** 联网工具组：由 buildTools 注册进基础工具集。
 *  关闭网页搜索时 WebSearch 不进工具表（与 browser/imagegen 同款条件注册），
 *  子代理/计划模式/run_code 按名取用时自然拿不到它。 */
export function buildWebTools(
  cwd: string,
  getSandbox?: SandboxProvider,
): AgentTool[] {
  const tools = [buildWebFetchTool(cwd, getSandbox)];
  if (getWebSearchConfig().enabled) {
    tools.push(buildWebSearchTool(cwd, getSandbox));
  }
  return tools;
}
