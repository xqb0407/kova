import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeDiscoveryCache,
  discoveryFingerprint,
  discoveryNeedsFetch,
  fetchAllModelPages,
  fetchDiscoveredModels,
  loadAutoModels,
  mergeModelPageBundles,
  modelListCandidateUrls,
  nextModelPageUrl,
  normalizeModelBaseUrl,
  parseDiscoveredModels,
  redactUrl,
  saveDiscoveryCache,
  type DiscoveryCache,
} from "../../src/model/dynamic-discovery";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { parseFetchedModelList } from "../../src/model/model-metadata";

describe("modelListCandidateUrls", () => {
  test("openai：已带 /v1 只试一次；不带时 /models 与 /v1/models 都试", () => {
    expect(modelListCandidateUrls("https://gw.example/v1", "openai-chat")).toEqual([
      "https://gw.example/v1/models",
    ]);
    expect(modelListCandidateUrls("https://gw.example/", "openai-chat")).toEqual([
      "https://gw.example/models",
      "https://gw.example/v1/models",
    ]);
  });

  test("anthropic：统一补 /v1（已带不加）并带 limit=1000", () => {
    expect(modelListCandidateUrls("https://api.example", "anthropic-messages")).toEqual([
      "https://api.example/v1/models?limit=1000",
    ]);
    expect(
      modelListCandidateUrls("https://api.example/v1/", "anthropic-messages"),
    ).toEqual(["https://api.example/v1/models?limit=1000"]);
  });

  test("完整端点先收敛：不会拼出 /models/models；查询串保留", () => {
    expect(modelListCandidateUrls("https://gw.example/v1/models", "openai-chat")).toEqual([
      "https://gw.example/v1/models",
    ]);
    expect(
      modelListCandidateUrls("https://gw.example/v1/chat/completions", "openai-chat"),
    ).toEqual(["https://gw.example/v1/models"]);
    expect(
      modelListCandidateUrls("https://gw.example/v1?api-version=2024-01-01", "openai-chat"),
    ).toEqual(["https://gw.example/v1/models?api-version=2024-01-01"]);
    expect(
      modelListCandidateUrls("HTTPS://GW.EXAMPLE/V1/models", "openai-chat"),
    ).toEqual(["https://gw.example/V1/models"]);
    expect(
      modelListCandidateUrls("https://api.example/v1/models", "anthropic-messages"),
    ).toEqual(["https://api.example/v1/models?limit=1000"]);
    expect(modelListCandidateUrls("https://", "openai-chat")).toEqual([]);
    expect(modelListCandidateUrls("not a url", "openai-chat")).toEqual([]);
  });
});

describe("normalizeModelBaseUrl", () => {
  test("完整端点收敛，保留路径前缀与查询串", () => {
    expect(normalizeModelBaseUrl("HTTPS://GW.EXAMPLE/V1/models")).toBe(
      "https://gw.example/V1",
    );
    expect(normalizeModelBaseUrl("https://gw.example/v1/chat/completions?x=1")).toBe(
      "https://gw.example/v1?x=1",
    );
    expect(normalizeModelBaseUrl("https://gw.example/models")).toBe(
      "https://gw.example",
    );
    expect(normalizeModelBaseUrl("")).toBe("");
    expect(normalizeModelBaseUrl("not a url")).toBe("not a url");
  });
});

describe("redactUrl", () => {
  test("query 值、userinfo、hash 不落日志；键名保留", () => {
    expect(
      redactUrl(
        "https://user:pass@gw.example/v1/models?api-version=2024&token=abc#frag",
      ),
    ).toBe("https://gw.example/v1/models?api-version=***&token=***");
    expect(redactUrl("https://gw.example/v1/models?token=a&token=b")).toBe(
      "https://gw.example/v1/models?token=***&token=***",
    );
    expect(redactUrl("https://gw.example/v1/models")).toBe(
      "https://gw.example/v1/models",
    );
  });
});

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
    const skipped: string[] = [];
    expect(
      parseDiscoveredModels(payload, {
        filterNonText: true,
        onFiltered: (id) => skipped.push(id),
      }).map((m) => m.id),
    ).toEqual(["chat"]);
    expect(skipped).toEqual(["img", "embed"]);
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

  test("扩展信封：items / result / 嵌套 data.models 都能识别", () => {
    for (const payload of [
      { items: [{ id: "a" }] },
      { result: [{ id: "a" }] },
      { data: { models: [{ id: "a" }] } },
      { models: { data: [{ id: "a" }] } },
    ]) {
      expect(parseDiscoveredModels(payload).map((m) => m.id)).toEqual(["a"]);
    }
  });

  test("多个信封数组：空 data 不挡 models；多个非空取并集", () => {
    expect(
      parseDiscoveredModels({ data: [], models: [{ id: "m" }] }).map((m) => m.id),
    ).toEqual(["m"]);
    expect(
      parseDiscoveredModels({
        data: [{ id: "a" }],
        models: [{ id: "a" }, { id: "b" }],
      }).map((m) => m.id),
    ).toEqual(["a", "b"]);
    expect(
      parseDiscoveredModels({
        data: [{ id: "x" }],
        models: [{ id: "a" }, { id: "b" }],
      }).map((m) => m.id),
    ).toEqual(["x", "a", "b"]);
  });

  test("通用的 list/items 不会抢走 data/models 的真模型清单", () => {
    expect(
      parseDiscoveredModels({
        data: [{ id: "m" }],
        list: [{ name: "a" }, { name: "b" }, { name: "c" }],
      }).map((m) => m.id),
    ).toEqual(["m"]);
  });

  test("顶层数组全空时继续下钻嵌套信封", () => {
    expect(
      parseDiscoveredModels({
        data: [],
        models: { data: [{ id: "m" }] },
      }).map((m) => m.id),
    ).toEqual(["m"]);
  });

  test("空字符串行/非模型数组不会挡住真正的模型数组或嵌套信封", () => {
    expect(
      parseDiscoveredModels({ data: [""], models: [{ id: "m" }] }).map((m) => m.id),
    ).toEqual(["m"]);
    expect(
      parseDiscoveredModels({
        list: [{ name: "x" }],
        models: { data: [{ id: "m" }] },
      }).map((m) => m.id),
    ).toEqual(["m"]);
  });

  test("id 别名与数字 id；name 仍不作为 id", () => {
    expect(
      parseDiscoveredModels({
        data: [{ model: "a" }, { model_id: "b" }, { id: 123 }, { name: "display" }],
      }).map((m) => m.id),
    ).toEqual(["a", "b", "123"]);
  });

  test("被 filterNonText 丢掉的行不占用去重位", () => {
    const parsed = parseDiscoveredModels(
      {
        data: [
          { id: "x", output_modalities: ["image"] },
          { id: "x", output_modalities: ["text"] },
        ],
      },
      { filterNonText: true },
    );
    expect(parsed.map((m) => m.id)).toEqual(["x"]);
  });
});

describe("nextModelPageUrl", () => {
  test("has_more + last_id → after_id；直接 next 支持相对地址", () => {
    expect(
      nextModelPageUrl("https://gw.example/v1/models", {
        has_more: true,
        last_id: "m2",
      }),
    ).toBe("https://gw.example/v1/models?after_id=m2");
    expect(
      nextModelPageUrl("https://gw.example/v1/models", {
        has_more: 1,
        last_id: "m2",
      }),
    ).toBe("https://gw.example/v1/models?after_id=m2");
    expect(
      nextModelPageUrl("https://gw.example/v1/models", {
        next: "/v1/models?page=2",
      }),
    ).toBe("https://gw.example/v1/models?page=2");
    expect(
      nextModelPageUrl("https://gw.example/v1/models", {
        next: "https://evil.example/models",
      }),
    ).toBeUndefined();
    expect(
      nextModelPageUrl("https://gw.example/v1/models", { has_more: false }),
    ).toBeUndefined();
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
  test("合并宽限期：快端点先回，慢端点不悬挂；结果保留快端点", async () => {
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
      // 宽限期结束后 finally 掐掉落选请求
      await Bun.sleep(100);
      expect(slowAborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("分页：has_more + last_id 拉完所有页并按 id 去重", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/models") return new Response("no", { status: 404 });
        if (url.searchParams.get("after_id") === "m2") {
          return Response.json({
            object: "list",
            data: [{ id: "m3" }, { id: "m2" }, { id: "m4" }],
            has_more: false,
          });
        }
        return Response.json({
          object: "list",
          data: [{ id: "m1" }, { id: "m2" }],
          has_more: true,
          first_id: "m1",
          last_id: "m2",
        });
      },
    });
    try {
      const models = await fetchDiscoveredModels({
        baseUrl: `http://localhost:${server.port}/v1`,
        api: "openai-chat",
        timeoutMs: 2_000,
      });
      expect(models.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    } finally {
      server.stop(true);
    }
  });

  test("候选合并：慢端点返回不同的完整列表时取并集", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/models") {
          return Response.json({ data: [{ id: "fast-1" }, { id: "fast-2" }] });
        }
        if (path === "/v1/models") {
          await Bun.sleep(100);
          return Response.json({
            data: [{ id: "full-1" }, { id: "full-2" }, { id: "full-3" }],
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    try {
      const models = await fetchDiscoveredModels({
        baseUrl: `http://localhost:${server.port}`,
        api: "openai-chat",
        timeoutMs: 2_000,
      });
      expect(models.map((m) => m.id)).toEqual([
        "fast-1",
        "fast-2",
        "full-1",
        "full-2",
        "full-3",
      ]);
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
