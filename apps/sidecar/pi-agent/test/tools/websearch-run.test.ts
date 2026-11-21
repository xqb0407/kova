import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HostHttpData } from "../../src/storage/hostdb";
import { getTransport, setTransport } from "../../src/storage/hostdb/transport";
import {
  makePresetProvider,
  resetWebSearchConfigForTest,
  type WebSearchConfig,
} from "../../src/tools/websearch/config";
import { runWebSearch } from "../../src/tools/websearch/run";

const configWith = (
  kind: "searxng" | "deepseek" = "searxng",
  overrides: Partial<WebSearchConfig> = {},
): WebSearchConfig => ({
  enabled: true,
  provider: {
    ...makePresetProvider(kind),
    baseUrl: `https://${kind}.example/search`,
  },
  requestTimeoutMs: 1_000,
  maxResults: 5,
  ...overrides,
});

const ok = (results: unknown[]): HostHttpData => ({
  output: JSON.stringify({ results }),
  status: 200,
  statusText: "OK",
  ok: true,
  url: "https://provider.example",
  contentType: "application/json",
  headers: {},
  totalBytes: 0,
  truncated: false,
  encoding: "utf-8",
});

const fail = (status = 500): HostHttpData => ({
  output: "boom",
  status,
  statusText: "ERR",
  ok: false,
  url: "https://provider.example",
  contentType: "text/plain",
  headers: {},
  totalBytes: 0,
  truncated: false,
  encoding: "utf-8",
});

type Responder = (inner: Record<string, unknown>) =>
  | HostHttpData
  | Promise<HostHttpData>;

describe("网页搜索单服务执行", () => {
  let sent: Record<string, unknown>[] = [];
  let responders: Responder[] = [];
  let previous: ReturnType<typeof getTransport> = null;

  beforeEach(() => {
    sent = [];
    responders = [];
    previous = getTransport();
    setTransport(async (kind, params) => {
      // 只拦 HTTP 执行；credential_get 等其它 host 查询按"无值"返回
      if (kind !== "tool") return null;
      const inner = (params as { params: Record<string, unknown> }).params;
      sent.push(inner);
      const next = responders.shift();
      if (!next) throw new Error("unexpected host http call");
      return next(inner);
    });
  });

  afterEach(() => {
    setTransport(previous);
    resetWebSearchConfigForTest();
  });

  test("成功：请求发到配置端点，结果收窄并限条数", async () => {
    responders = [
      () =>
        ok([
          { title: "A", url: "https://a.dev", snippet: "a" },
          { title: "B", url: "https://b.dev", snippet: "b" },
        ]),
    ];
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("searxng", { maxResults: 1 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.id).toBe("searxng");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe("A");
    // searxng 在端点后追加 q/format/pageno 查询参数
    expect(sent[0]?.url).toBe(
      "https://searxng.example/search?q=q&format=json&pageno=1",
    );
    expect(sent[0]?.timeoutMs).toBe(1_000);
  });

  test("HTTP 失败：明确返回 provider + 状态，不抛异常", async () => {
    responders = [() => fail(401)];
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("searxng"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("searxng");
    expect(result.error).toContain("HTTP 401");
  });

  test("空结果：返回 no search results", async () => {
    responders = [() => ok([])];
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("searxng"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no search results");
  });

  test("宿主超时/异常：收敛为 provider + 错误文本", async () => {
    responders = [
      () => {
        throw new Error("request timed out after 1000ms: https://x");
      },
    ];
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("searxng"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("searxng");
    expect(result.error).toContain("timed out");
  });

  test("错误文本脱敏：自定义 GET 放在 query 里的 key 不回显", async () => {
    const provider = {
      ...makePresetProvider("custom"),
      baseUrl: "https://api.example.com/s?key={{apiKey}}",
      method: "GET" as const,
    };
    responders = [
      () => {
        throw new Error(
          "request failed: https://api.example.com/s?key=supersecret&q=q",
        );
      },
    ];
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: {
        enabled: true,
        provider,
        requestTimeoutMs: 1_000,
        maxResults: 5,
      },
      apiKeyOverride: "supersecret",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("supersecret");
    expect(result.error).toContain("***");
  });

  test("测试覆盖 key 直接进请求头，不读凭据表", async () => {
    responders = [() => ok([{ title: "D", url: "https://d.dev" }])];
    await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("deepseek"),
      apiKeyOverride: "sk-override",
    });
    expect(
      (sent[0]?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer sk-override");
  });

  test("自定义 header 里的 {{ apiKey }}（带空格）也能取到已保存 key", async () => {
    const provider = {
      ...makePresetProvider("custom"),
      baseUrl: "https://api.example.com/search",
      headers: { Authorization: "Bearer {{ apiKey }}" },
      bodyTemplate: '{"q":"{{query}}"}',
    };
    setTransport(async (kind, params) => {
      if (kind === "credential_get") return { apiKey: "stored-key" };
      if (kind !== "tool") return null;
      const inner = (params as { params: Record<string, unknown> }).params;
      sent.push(inner);
      return ok([{ title: "C", url: "https://c.dev" }]);
    });
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: {
        enabled: true,
        provider,
        requestTimeoutMs: 1_000,
        maxResults: 5,
      },
    });
    expect(result.ok).toBe(true);
    expect(
      (sent[0]?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer stored-key");
  });

  test("allowStoredKey=false：不读凭据表，缺 key 直接失败", async () => {
    const calls: string[] = [];
    setTransport(async (kind) => {
      calls.push(kind);
      if (kind === "credential_get") return { apiKey: "stored" };
      return null;
    });
    const result = await runWebSearch("q", {
      cwd: "/tmp",
      config: configWith("deepseek"),
      allowStoredKey: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("API key");
    expect(calls).not.toContain("credential_get");
    expect(sent).toEqual([]);
  });

  test("调用方 abort：开始前直接拒绝，不再发请求", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWebSearch("q", {
        cwd: "/tmp",
        config: configWith("searxng"),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(sent).toEqual([]);
  });

  test("轮中 abort：原样抛出，不包装成搜索失败", async () => {
    const controller = new AbortController();
    responders = [
      () => {
        controller.abort();
        throw new Error("request failed: aborted");
      },
    ];
    await expect(
      runWebSearch("q", {
        cwd: "/tmp",
        config: configWith("searxng"),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
