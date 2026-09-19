import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TraceRunRecord, TraceSpan } from "./trace";
import {
  buildOtlpSpans,
  exportTraceRun,
  flushOtlp,
  resetOtlpForTest,
  setFetchImplForTest,
} from "./otlp-exporter";
import { applyObservabilityConfig, resetObservabilityConfigForTest } from "./observability";
import { initLocalStorage, resetStorageForTest } from "./hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-otlp-"));

beforeAll(() => {
  // applyObservabilityConfig 会落 kv（SQLite 本地模式）：钉到临时目录
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  resetOtlpForTest();
  resetObservabilityConfigForTest();
  resetStorageForTest();
  setFetchImplForTest(null);
});

/** 构造一个两轮 run：turn1 = llm + tool + 两次重试（error 收尾），turn2 = llm */
const testRecord = (): TraceRunRecord => {
  const turn = (children: TraceSpan[]): TraceSpan => ({
    kind: "turn",
    startMs: 1000,
    endMs: 2000,
    status: "ok",
    attrs: { index: 1 },
    children,
  });
  return {
    runId: "a".repeat(32),
    sessionId: "sess-1",
    source: "ui",
    startMs: 900,
    endMs: 5000,
    status: "error",
    model: "langfuse-gpt/gpt-4o",
    usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    spans: [
      turn([
        {
          kind: "llm_call",
          startMs: 1100,
          endMs: 1200,
          status: "error",
          attrs: {
            model: "langfuse-gpt/gpt-4o",
            provider: "langfuse-gpt",
            stopReason: "error",
            errorMessage: "429: rate limited",
            inputTokens: 100,
            outputTokens: 50,
            cacheRead: 10,
            cacheWrite: 5,
          },
          detail: { request: "[system] sys\n\n[user] hi", response: "hello" },
        },
        {
          kind: "tool_call",
          name: "bash",
          startMs: 1300,
          endMs: 1400,
          status: "ok",
          attrs: { args: '{"cmd":"ls"}' },
        },
        {
          kind: "retry",
          name: "PROVIDER_RATE_LIMITED",
          startMs: 1500,
          endMs: 1600,
          status: "ok",
          attrs: { attempt: 1, delayMs: 2000, message: "429" },
        },
      ]),
    ],
  };
};

describe("buildOtlpSpans", () => {
  const spans = buildOtlpSpans(testRecord(), true);
  const byName = (needle: string) => spans.filter((s) => s.name.includes(needle));

  test("根 span：traceId 稳定 32hex、service 属性带 sessionId/source、run 级 usage", () => {
    const root = spans[0]!;
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.every((s) => s.traceId === root.traceId)).toBe(true);
    const keys = new Set((root.attributes ?? []).map((a) => a.key));
    expect(keys.has("pi.session_id")).toBe(true);
    expect(keys.has("gen_ai.usage.input_tokens")).toBe(true);
    expect(root.parentSpanId).toBeUndefined();
  });

  test("llm_call：gen_ai.* 映射（system/model/usage/finish_reasons/error）", () => {
    // llm span 的唯一标志是 gen_ai.system 属性（根 span 也带 model 名，不能按 name 挑）
    const llm = spans.find((s) => (s.attributes ?? []).some((a) => a.key === "gen_ai.system"))!;
    expect(llm).toBeDefined();
    const map = new Map((llm.attributes ?? []).map((a) => [a.key, a.value]));
    expect(map.get("gen_ai.system")?.stringValue).toBe("langfuse-gpt");
    expect(map.get("gen_ai.request.model")?.stringValue).toBe("gpt-4o");
    expect(map.get("gen_ai.usage.input_tokens")?.doubleValue).toBe(100);
    expect(map.get("gen_ai.usage.cache_read.input_tokens")?.doubleValue).toBe(10);
    expect(map.get("gen_ai.response.finish_reasons")?.stringValue).toBe("error");
    expect(map.get("error.type")?.stringValue).toContain("rate limited");
    expect(llm.kind).toBe(3); // CLIENT
    expect(llm.status.code).toBe(2); // ERROR
    expect(llm.startTimeUnixNano).toBe((1100n * 1_000_000n).toString());
  });

  test("tool_call：gen_ai.tool.name 有、redactContent=true 时参数不上传", () => {
    const tool = byName("bash")[0]!;
    const map = new Map((tool.attributes ?? []).map((a) => [a.key, a.value]));
    expect(map.get("gen_ai.tool.name")?.stringValue).toBe("bash");
    expect(map.has("gen_ai.tool.call.arguments")).toBe(false);
  });

  test("redactContent=false 时工具参数随行，llm 带 input.value/output.value", () => {
    const spans = buildOtlpSpans(testRecord(), false);
    const tool = spans.find((s) => s.name === "bash")!;
    const toolMap = new Map((tool.attributes ?? []).map((a) => [a.key, a.value]));
    expect(toolMap.get("gen_ai.tool.call.arguments")?.stringValue).toContain("ls");

    const llm = spans.find((s) =>
      (s.attributes ?? []).some((a) => a.key === "gen_ai.system"),
    )!;
    const map = new Map((llm.attributes ?? []).map((a) => [a.key, a.value]));
    expect(map.get("input.value")?.stringValue).toContain("[user] hi");
    expect(map.get("output.value")?.stringValue).toBe("hello");
  });

  test("redactContent=true（默认）时正文不上传", () => {
    const spans = buildOtlpSpans(testRecord(), true);
    const llm = spans.find((s) =>
      (s.attributes ?? []).some((a) => a.key === "gen_ai.system"),
    )!;
    const keys = new Set((llm.attributes ?? []).map((a) => a.key));
    expect(keys.has("input.value")).toBe(false);
    expect(keys.has("output.value")).toBe(false);
  });

  test("retry：attempt/delayMs/code，parentSpanId 指向 turn", () => {
    const retry = byName("PROVIDER_RATE_LIMITED")[0]!;
    const map = new Map((retry.attributes ?? []).map((a) => [a.key, a.value]));
    expect(map.get("pi.retry.attempt")?.doubleValue).toBe(1);
    expect(map.get("pi.retry.delayMs")?.doubleValue).toBe(2000);
    expect(retry.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("exportTraceRun / flushOtlp", () => {
  test("disabled 时零网络请求", async () => {
    await applyObservabilityConfig({ enabled: false, endpoint: "https://x/otel" });
    let calls = 0;
    setFetchImplForTest(() => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    exportTraceRun(testRecord());
    await flushOtlp();
    expect(calls).toBe(0);
  });

  test("enabled：POST endpoint、带鉴权头、body 是 OTLP resourceSpans；失败静默丢弃", async () => {
    await applyObservabilityConfig({
      enabled: true,
      endpoint: "https://example.com/api/public/otel/v1/traces",
      headers: { Authorization: "Basic pk:sk" },
    });
    let calls: { url: string; init: RequestInit | undefined }[] = [];    setFetchImplForTest((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    exportTraceRun(testRecord());
    exportTraceRun(testRecord());
    await flushOtlp();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.com/api/public/otel/v1/traces");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Authorization")).toBe("Basic pk:sk");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      resourceSpans: { resource: unknown; scopeSpans: { spans: unknown[] }[] }[];
    };
    expect(body.resourceSpans).toHaveLength(1);
    // 两条 run（各 1 root + 1 turn + 3 子 span）合并进一个 scopeSpans
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(10);

    // 失败不抛出（节流日志）
    setFetchImplForTest(() => Promise.reject(new Error("network down")));
    exportTraceRun(testRecord());
    await expect(flushOtlp()).resolves.toBeUndefined();
  });
});
