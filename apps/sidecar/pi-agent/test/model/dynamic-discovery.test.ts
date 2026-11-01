import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeDiscoveryCache,
  discoveryFingerprint,
  discoveryNeedsFetch,
  fetchDiscoveredModels,
  loadAutoModels,
  parseDiscoveredModels,
  saveDiscoveryCache,
  type DiscoveryCache,
} from "../../src/model/dynamic-discovery";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { parseFetchedModelList } from "../../src/model/model-metadata";

describe("parseDiscoveredModels", () => {
  test("三种枚举信封：裸数组 / {data} / {models}", () => {
    const rows = [
      { id: "m1", context_length: 128_000, max_output_tokens: 8_192 },
      { id: "m2", display_name: "Model Two" },
    ];
    for (const payload of [rows, { data: rows }, { models: rows }]) {
      const parsed = parseDiscoveredModels(payload);
      expect(parsed.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(parsed[0].contextWindow).toBe(128_000);
      expect(parsed[0].maxTokens).toBe(8_192);
      expect(parsed[1].name).toBe("Model Two");
    }
  });

  test("字符串行与只有 id 的对象行仍可注册，脏行跳过", () => {
    const parsed = parseDiscoveredModels(["s1", { id: "o1" }, { name: "no-id" }, null, 42]);
    expect(parsed).toEqual([{ id: "s1" }, { id: "o1" }]);
  });

  test("字段别名与 limits 嵌套、k/M 数字字符串", () => {
    const parsed = parseDiscoveredModels({
      data: [
        { id: "a", max_model_len: "131072", max_completion_tokens: 8_192 },
        { id: "b", contextWindow: "128k", limits: { max_output_tokens: 16_384 } },
        { id: "c", limits: { context: 200_000 } },
      ],
    });
    expect(parsed[0]).toMatchObject({ contextWindow: 131_072, maxTokens: 8_192 });
    expect(parsed[1]).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
    expect(parsed[2].contextWindow).toBe(200_000);
  });

  test("非对话输出过滤可开关：发现路径丢弃，fetch 预填路径保留", () => {
    const payload = {
      data: [
        { id: "img", output_modalities: ["image"] },
        { id: "embed", architecture: { output_modalities: ["embedding"] } },
        { id: "chat", modalities: { output: ["text"] } },
      ],
    };
    expect(parseDiscoveredModels(payload, { filterNonText: true }).map((m) => m.id)).toEqual([
      "chat",
    ]);
    expect(parseDiscoveredModels(payload).map((m) => m.id)).toEqual(["img", "embed", "chat"]);
  });

  test("思考档位：自报档位映射自身、未自报档位显式 null；off 不写", () => {
    const parsed = parseDiscoveredModels({
      data: [{ id: "m", supports_reasoning: true, reasoning_levels: ["low", { effort: "High" }] }],
    });
    expect(parsed[0].reasoning).toBe(true);
    expect(parsed[0].thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    expect("off" in (parsed[0].thinkingLevelMap ?? {})).toBe(false);
  });

  test("supports_reasoning=false 时不生成档位映射", () => {
    const parsed = parseDiscoveredModels({
      data: [{ id: "m", supports_reasoning: false, reasoning_levels: ["low"] }],
    });
    expect(parsed[0].reasoning).toBe(false);
    expect(parsed[0].thinkingLevelMap).toBeUndefined();
  });

  test("输入模态：多层级别名收敛为 text/image", () => {
    const parsed = parseDiscoveredModels({
      data: [
        { id: "v", architecture: { input_modalities: ["text", "image", "audio"] } },
        { id: "t", modalities: { input: ["text"] } },
      ],
    });
    expect(parsed[0].input).toEqual(["text", "image"]);
    expect(parsed[1].input).toEqual(["text"]);
  });

  test("去重保留首次出现，顺序保留", () => {
    const parsed = parseDiscoveredModels([
      "m1",
      { id: "m1", context_length: 1 },
      { id: "m2" },
      " m1 ",
    ]);
    expect(parsed.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(parsed[0].contextWindow).toBeUndefined();
  });

  test("空/畸形载荷返回空列表", () => {
    expect(parseDiscoveredModels(undefined)).toEqual([]);
    expect(parseDiscoveredModels({})).toEqual([]);
    expect(parseDiscoveredModels({ data: "nope" })).toEqual([]);
    expect(parseDiscoveredModels({ models: 42 })).toEqual([]);
  });
});

describe("parseFetchedModelList（旧 fetch_models 契约回归）", () => {
  test("details 只收带元数据的条目，contextLength 命名保持", () => {
    const parsed = parseFetchedModelList({
      data: [
        { id: "m1", context_length: 1_000_000, max_completion_tokens: 8_192 },
        { id: "m2" },
      ],
    });
    expect(parsed.models).toEqual(["m1", "m2"]);
    expect(parsed.details).toEqual([
      { id: "m1", contextLength: 1_000_000, maxTokens: 8_192 },
    ]);
  });
});

describe("缓存", () => {
  const baseCache: DiscoveryCache = {
    version: 2,
    fingerprint: "f",
    models: [
      { id: "m1", name: " M1 ", contextWindow: 128_000, reasoning: true },
      { id: "m2" },
      { id: "m3", contextWindow: -5 },
      { id: "m1", contextWindow: 1 },
      // @ts-expect-error 脏行：缓存解码按缺失处理
      null,
    ],
    fetchedAt: 1_000,
  };

  test("decode 逐条降级：坏行丢弃、去重、id trim", () => {
    const decoded = decodeDiscoveryCache(JSON.stringify(baseCache));
    expect(decoded?.models.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(decoded?.models[0]).toMatchObject({ name: "M1", contextWindow: 128_000 });
    expect(decoded?.models[2].contextWindow).toBeUndefined();
  });

  test("decode：坏 JSON / 形状不符 / 空串返回 undefined", () => {
    expect(decodeDiscoveryCache("not-json")).toBeUndefined();
    expect(decodeDiscoveryCache(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(decodeDiscoveryCache("")).toBeUndefined();
    expect(decodeDiscoveryCache(null)).toBeUndefined();
  });

  test("指纹：换端点/协议/key/头都变；key 只进摘要，序无关的头稳定", () => {
    const base = { baseUrl: "https://api.x.com", api: "openai-chat" as const, apiKey: "sk-1", headers: { A: "1", B: "2" } };
    const h1 = discoveryFingerprint(base);
    // 同配置（头键序不同）指纹稳定
    expect(discoveryFingerprint({ ...base, headers: { B: "2", A: "1" } })).toBe(h1);
    expect(discoveryFingerprint({ ...base, baseUrl: "https://api.y.com" })).not.toBe(h1);
    expect(discoveryFingerprint({ ...base, apiKey: "sk-2" })).not.toBe(h1);
    expect(discoveryFingerprint({ ...base, api: "anthropic-messages" })).not.toBe(h1);
    expect(discoveryFingerprint({ ...base, headers: { A: "2", B: "1" } })).not.toBe(h1);
    // 尾部斜杠归一
    expect(discoveryFingerprint({ ...base, baseUrl: "https://api.x.com/" })).toBe(h1);
  });

  test("needsFetch：force 绕过一切；新鲜不拉；过期且无失败冷却才拉；冷却中不拉", () => {
    const now = 1_000_000;
    const fresh: DiscoveryCache = { ...baseCache, fetchedAt: now - 1000 };
    const stale: DiscoveryCache = { ...baseCache, fetchedAt: now - 7 * 60 * 60 * 1000 };
    const cooling: DiscoveryCache = { ...stale, lastFailedUnix: now - 60_000 };
    const cooled: DiscoveryCache = { ...stale, lastFailedUnix: now - 11 * 60 * 1000 };
    expect(discoveryNeedsFetch(undefined, {}, now)).toBe(true);
    expect(discoveryNeedsFetch(fresh, {}, now)).toBe(false);
    expect(discoveryNeedsFetch(fresh, { force: true }, now)).toBe(true);
    expect(discoveryNeedsFetch(stale, {}, now)).toBe(true);
    expect(discoveryNeedsFetch(cooling, {}, now)).toBe(false);
    expect(discoveryNeedsFetch(cooling, { force: true }, now)).toBe(true);
    expect(discoveryNeedsFetch(cooled, {}, now)).toBe(true);
  });
});

describe("loadAutoModels（手写 id 过滤）", () => {
  test("过滤手写 id 与重复 id", async () => {
    // loadAutoModels 读 kv（hostdb）：无存储环境时返回 []（catch 分支）。
    // 过滤逻辑的完整验证走 manualIds 传入路径——这里只验证无缓存时不抛错。
    const autos = await loadAutoModels(
      "p1",
      { baseUrl: "https://x", api: "openai-chat" },
      ["m1"],
    );
    expect(Array.isArray(autos)).toBe(true);
  });
});

describe("fetchDiscoveredModels（本地 Bun.serve）", () => {
  test("竞速：非空结果立即采用，落选请求被 abort 不悬挂", async () => {
    let slowAborted = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "fast" }] });
        }
        // /models：慢端点，挂到被 abort（fallback 兜底防进程悬挂）
        return new Promise<Response>((resolve) => {
          req.signal.addEventListener("abort", () => {
            slowAborted = true;
            resolve(new Response("aborted", { status: 499 }));
          });
          const fallback = setTimeout(
            () => resolve(Response.json({ data: [{ id: "slow" }] })),
            2_000,
          );
          fallback.unref?.();
        });
      },
    });
    try {
      const models = await fetchDiscoveredModels({
        baseUrl: `http://localhost:${server.port}`,
        api: "openai-chat",
        timeoutMs: 1_000,
      });
      expect(models.map((m) => m.id)).toEqual(["fast"]);
      // settle 后 finally 掐掉落选请求
      await Bun.sleep(100);
      expect(slowAborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("全部候选超时：错误文案可读（不是裸 AbortError）", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
    try {
      await expect(
        fetchDiscoveredModels({
          baseUrl: `http://localhost:${server.port}`,
          api: "openai-chat",
          timeoutMs: 200,
        }),
      ).rejects.toThrow("timed out");
    } finally {
      server.stop(true);
    }
  });
});

describe("loadAutoModels（local 存储端到端）", () => {
  // 模块级共享传输：本文件（test/model/）先于 test/storage/ 执行，用独立 tmp
  // 库初始化，结束后重置，避免与 hostdb.test.ts 串扰。
  const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-dynamic-discovery-"));
  beforeAll(() => {
    initLocalStorage(path.join(tmp, "state.db"));
  });
  afterAll(() => {
    resetStorageForTest();
  });

  test("排除手写 id（含停用行）；指纹不匹配视为无缓存", async () => {
    const parts = {
      baseUrl: "https://api.test",
      api: "openai-chat" as const,
      apiKey: "sk",
      headers: {},
    };
    await saveDiscoveryCache("p-discovery", {
      version: 2,
      fingerprint: discoveryFingerprint(parts),
      fetchedAt: 1,
      models: [
        { id: "auto1" },
        { id: "manual-on" },
        { id: "manual-off" },
        { id: "auto2" },
      ],
    });
    // 注册/清单路径传全部手写行 id（含停用行）：显式停用的模型不能被 AUTO 复活
    const autos = await loadAutoModels("p-discovery", parts, [
      "manual-on",
      "manual-off",
    ]);
    expect(autos.map((m) => m.id)).toEqual(["auto1", "auto2"]);
    // 换密钥 → 指纹变化 → 旧缓存失效（重新发现前不返回任何 AUTO 模型）
    const autosOtherKey = await loadAutoModels(
      "p-discovery",
      { ...parts, apiKey: "sk-2" },
      [],
    );
    expect(autosOtherKey).toEqual([]);
  });
});
