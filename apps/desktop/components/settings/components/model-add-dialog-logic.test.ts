import { describe, expect, test } from "bun:test";
import {
  addModelRow,
  attrSummary,
  baseUrlError,
  buildSaveInput,
  canSave,
  cleanHeaders,
  filterBuiltinModels,
  filterModelRows,
  isBaseUrlOk,
  isDraftFresh,
  mergeSeed,
  modelIdError,
  normalizeBaseUrl,
  parseModelIds,
  rowToModelInput,
  seedDraftWithModelSpec,
  thinkingSummary,
  toggleAllVisible,
  type ModelRow,
} from "./model-add-dialog-logic";
import { emptyAttrDraft, specToAttrDraft, type AttrDraft } from "./model-attr-editor";

/** 带草稿的行（模拟进过属性弹窗并确定的模型） */
const row = (id: string, name = ""): ModelRow => ({
  id,
  draft: { ...emptyAttrDraft(id), name },
  touched: true,
});

describe("isBaseUrlOk", () => {
  test("http/https 开头通过；其它拒绝；两端空白不影响", () => {
    expect(isBaseUrlOk("http://x.dev/v1")).toBe(true);
    expect(isBaseUrlOk("  https://api.example.com  ")).toBe(true);
    expect(isBaseUrlOk("api.example.com")).toBe(false);
    expect(isBaseUrlOk("ftp://x")).toBe(false);
    expect(isBaseUrlOk("")).toBe(false);
  });
  test("大小写不敏感；空格/hash/空主机与校验文案一致", () => {
    expect(isBaseUrlOk("HTTPS://api.example.com/v1")).toBe(true);
    expect(isBaseUrlOk("https://a b.dev/v1")).toBe(false);
    expect(isBaseUrlOk("https://api.example.com/v1#x")).toBe(false);
    expect(isBaseUrlOk("https://")).toBe(false);
  });
});

describe("normalizeBaseUrl（完整端点收敛回 baseUrl）", () => {
  test("去掉端点后缀与末尾斜杠，大小写归一，保留查询串", () => {
    expect(normalizeBaseUrl("HTTPS://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeBaseUrl("https://api.example.com/v1/responses/")).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeBaseUrl("https://api.example.com/models")).toBe(
      "https://api.example.com",
    );
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(
      normalizeBaseUrl("https://api.example.com/v1/models?api-version=2024-01-01"),
    ).toBe("https://api.example.com/v1?api-version=2024-01-01");
  });
  test("含空白/无法解析时原样返回，交给校验报错", () => {
    expect(normalizeBaseUrl(" https://a b.dev/v1 ")).toBe("https://a b.dev/v1");
    expect(normalizeBaseUrl("not a url")).toBe("not a url");
    expect(normalizeBaseUrl("")).toBe("");
  });
});

describe("parseModelIds / modelIdError（手填与粘贴）", () => {
  test("单行、换行、逗号、分号、制表符、外层引号都拆成独立 id", () => {
    expect(parseModelIds("a")).toEqual(["a"]);
    expect(parseModelIds("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(parseModelIds("a, b;c")).toEqual(["a", "b", "c"]);
    expect(parseModelIds("a\tb")).toEqual(["a", "b"]);
    expect(parseModelIds("a，b；c、d")).toEqual(["a", "b", "c", "d"]);
    expect(parseModelIds("\"a\"\n'b'")).toEqual(["a", "b"]);
    expect(parseModelIds("“a”\n‘b’")).toEqual(["a", "b"]);
  });
  test("JSON 字符串数组与 /models data 形态都能拆", () => {
    expect(parseModelIds('["a","b"]')).toEqual(["a", "b"]);
    expect(parseModelIds("[123,456]")).toEqual(["123", "456"]);
    expect(parseModelIds('[{"id":"a"},{"id":"b"}]')).toEqual(["a", "b"]);
    expect(
      parseModelIds('[{"id":"a"},{"model":"b"},{"model_id":"c"},{"id":123}]'),
    ).toEqual(["a", "b", "c", "123"]);
  });
  test("内部空白/括号/引号非法；空串忽略", () => {
    expect(modelIdError("a b")).toBe("模型 ID 不能包含空格");
    expect(modelIdError("a[b")).toBe("模型 ID 包含非法字符（括号、引号或分隔符）");
    expect(modelIdError('a"b')).toBe("模型 ID 包含非法字符（括号、引号或分隔符）");
    expect(modelIdError(" a ")).toBeNull();
    expect(modelIdError("")).toBeNull();
  });
});

describe("buildSaveInput 地址归一", () => {
  test("完整端点保存前收敛为 baseUrl", () => {
    const out = buildSaveInput({
      providerId: "custom",
      apiKey: "",
      isCustom: true,
      custom: {
        name: "网关",
        api: "openai-chat",
        baseUrl: "HTTPS://x.dev/v1/models",
        headers: [],
        models: [row("m")],
        autoDiscover: false,
      },
      builtin: { hasEnvFields: false, env: {}, selected: [], attrs: {} },
    });
    expect(out.custom?.baseUrl).toBe("https://x.dev/v1");
  });
});

describe("baseUrlError（接口地址即时校验：给具体原因）", () => {
  test("空串不报错（还没填不算错）", () => {
    expect(baseUrlError("")).toBeNull();
    expect(baseUrlError("   ")).toBeNull();
  });
  test("合法地址返回 null；带空白/协议错误给具体文案", () => {
    expect(baseUrlError("http://x.dev/v1")).toBeNull();
    expect(baseUrlError("https://api.example.com")).toBeNull();
    expect(baseUrlError("http://a b.dev")).toBe("地址中不能有空格");
    expect(baseUrlError("ftp://x.dev")).toBe("仅支持 http:// 或 https://");
    expect(baseUrlError("x.dev/v1")).toBe("需以 http:// 或 https:// 开头");
  });
  test("URL 语法错误与空主机名", () => {
    expect(baseUrlError("http://")).toBe("缺少主机名");
    expect(baseUrlError("ht^tp://x")).toBe("需以 http:// 或 https:// 开头");
  });
});

describe("cleanHeaders", () => {
  test("空名行丢弃、名称去空白、值原样保留", () => {
    expect(
      cleanHeaders([
        { name: " X-Title ", value: " kova " },
        { name: "", value: "orphan" },
        { name: "   ", value: "blank" },
      ]),
    ).toEqual([{ name: "X-Title", value: " kova " }]);
  });
});

describe("addModelRow（手填/自动获取加入模型）", () => {
  test("追加新 id，草稿为 null、未编辑（提交只发 id）", () => {
    const next = addModelRow([], "  my-model ");
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("my-model");
    expect(next[0].draft).toBeNull();
    expect(next[0].touched).toBe(false);
  });
  test("重复 id 与空串都不改变列表（返回同一引用，避免无谓重渲染）", () => {
    const rows = [row("a")];
    expect(addModelRow(rows, "a")).toBe(rows);
    expect(addModelRow(rows, "   ")).toBe(rows);
  });
});

describe("rowToModelInput（提交形态）", () => {
  test("没进过属性弹窗（draft null）：只发 id，属性继续走目录/缺省推导", () => {
    const out = rowToModelInput("kimi-k3", null, false);
    expect(out).toEqual({
      id: "kimi-k3",
      spec: { id: "kimi-k3" },
      thinkingLevels: [],
      thinkingOff: "",
      t2i: false,
      touched: false,
    });
  });
  test("fetch 元数据预填的窗口字段随行提交，touched 仍为 false（不冻结其它属性）", () => {
    const rows = addModelRow([], "m1", {
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    });
    const out = rowToModelInput(
      rows[0].id,
      rows[0].draft,
      rows[0].touched,
      rows[0].seedSpec,
    );
    expect(out.spec).toEqual({
      id: "m1",
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    });
    expect(out.touched).toBe(false);
    expect(out.thinkingLevels).toEqual([]);
    expect(out.t2i).toBe(false);
  });

  test("编辑预填但用户没重新进属性弹窗（touched false）：同样只发 id", () => {
    const prefilled: AttrDraft = { ...emptyAttrDraft("m"), ctx: "256000" };
    const out = rowToModelInput("m", prefilled, false);
    expect(out.spec).toEqual({ id: "m" });
    expect(out.touched).toBe(false);
  });
  test("用户确定过属性（touched true）：带完整 spec + 档位 + 生图标记", () => {
    const draft: AttrDraft = { ...emptyAttrDraft("m"), ctx: "128000", reasoning: true, t2i: true };
    const out = rowToModelInput("m", draft, true);
    expect(out.spec.contextWindow).toBe(128000);
    expect(out.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
    expect(out.t2i).toBe(true);
    expect(out.touched).toBe(true);
  });
});

describe("filterModelRows / filterBuiltinModels（列表搜索）", () => {
  const rows = [row("glm-5.2", "GLM 旗舰"), row("kimi-k3"), row("gpt-5.6")];
  test("按 id 或显示名不区分大小写匹配；空查询原样返回", () => {
    expect(filterModelRows(rows, "GLM").map((r) => r.id)).toEqual(["glm-5.2"]);
    expect(filterModelRows(rows, "旗舰").map((r) => r.id)).toEqual(["glm-5.2"]);
    expect(filterModelRows(rows, "k").map((r) => r.id)).toEqual(["kimi-k3"]);
    expect(filterModelRows(rows, "  ")).toBe(rows);
  });
  test("内置目录：name 缺席也能按 id 搜", () => {
    const cat = [{ id: "o5" }, { id: "gpt-5.6", name: "GPT-5.6" }];
    expect(filterBuiltinModels(cat, "o5").map((m) => m.id)).toEqual(["o5"]);
    expect(filterBuiltinModels(cat, "gpt").map((m) => m.id)).toEqual(["gpt-5.6"]);
  });
});

describe("toggleAllVisible（全选只作用于过滤后的可见集）", () => {
  test("可见集未全选 → 并入可见集，其它已选保留", () => {
    expect(toggleAllVisible(["x"], ["a", "b"]).sort()).toEqual(["a", "b", "x"]);
  });
  test("可见集已全选 → 只移除可见集，其它已选保留", () => {
    expect(toggleAllVisible(["a", "b", "x"], ["a", "b"])).toEqual(["x"]);
  });
  test("不产生重复", () => {
    expect(toggleAllVisible(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("canSave（保存按钮门禁）", () => {
  const base = {
    saving: false,
    providerId: "custom",
    isCustom: true,
    editingBuiltin: false,
    name: "网关",
    baseUrl: "http://x.dev/v1",
    apiKey: "",
    modelCount: 1,
  };
  test("自定义：名称 + 合法地址 + ≥1 模型即可，密钥可空（本地端点）", () => {
    expect(canSave(base)).toBe(true);
    expect(canSave({ ...base, name: " " })).toBe(false);
    expect(canSave({ ...base, baseUrl: "x.dev" })).toBe(false);
    expect(canSave({ ...base, modelCount: 0 })).toBe(false);
  });
  test("门禁按归一后的地址判断：完整端点/大小写/hash 不再静默禁用", () => {
    expect(canSave({ ...base, baseUrl: "HTTPS://x.dev/v1/models" })).toBe(true);
    expect(canSave({ ...base, baseUrl: "https://x.dev/v1#x" })).toBe(true);
    expect(canSave({ ...base, baseUrl: "https://x.dev/v1 b" })).toBe(false);
  });
  test("自定义 + 自动发现：模型区豁免（零手写模型可保存）", () => {
    expect(canSave({ ...base, modelCount: 0, autoDiscover: true })).toBe(true);
    // 其余门禁照旧：名称/地址不合法仍然拦
    expect(canSave({ ...base, modelCount: 0, autoDiscover: true, name: "" })).toBe(false);
    expect(canSave({ ...base, modelCount: 0, autoDiscover: true, baseUrl: "" })).toBe(false);
    // autoDiscover 关闭时恢复 ≥1 模型要求
    expect(canSave({ ...base, modelCount: 0, autoDiscover: false })).toBe(false);
  });
  test("内置新增：必须有密钥；内置编辑：密钥可留空（保持原 Key）", () => {
    const builtin = { ...base, providerId: "openai", isCustom: false, modelCount: 0 };
    expect(canSave(builtin)).toBe(false);
    expect(canSave({ ...builtin, apiKey: "sk-1" })).toBe(true);
    expect(canSave({ ...builtin, editingBuiltin: true })).toBe(true);
  });
  test("未选提供商 / 保存中 → 禁用", () => {
    expect(canSave({ ...base, providerId: null })).toBe(false);
    expect(canSave({ ...base, saving: true })).toBe(false);
  });
});

describe("buildSaveInput（onSave 载荷）", () => {
  test("自定义端点：裁剪空白、清理 headers、每个模型拆成 spec + 档位 + t2i", () => {
    const glm: ModelRow = {
      id: "glm-5.2",
      draft: {
        ...emptyAttrDraft("glm-5.2"),
        name: "GLM-5.2",
        ctx: "128000",
        reasoning: true,
        tOff: "none",
        t2i: true,
      },
      touched: true,
    };
    const out = buildSaveInput({
      providerId: "custom",
      apiKey: " sk-1 ",
      isCustom: true,
      custom: {
        name: " 网关 ",
        api: "openai-chat",
        baseUrl: " http://x.dev/v1 ",
        headers: [{ name: "", value: "" }, { name: "X", value: "1" }],
        models: [glm],
        autoDiscover: false,
      },
      builtin: { hasEnvFields: false, env: {}, selected: [], attrs: {} },
    });
    expect(out.providerId).toBe("custom");
    expect(out.apiKey).toBe("sk-1");
    expect(out.models).toBeUndefined();
    expect(out.custom?.name).toBe("网关");
    expect(out.custom?.baseUrl).toBe("http://x.dev/v1");
    expect(out.custom?.headers).toEqual([{ name: "X", value: "1" }]);
    const m = out.custom!.models[0];
    expect(m.id).toBe("glm-5.2");
    expect(m.spec.name).toBe("GLM-5.2");
    expect(m.spec.contextWindow).toBe(128000);
    expect(m.spec.reasoning).toBe(true);
    expect(m.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
    expect(m.thinkingOff).toBe("none");
    expect(m.t2i).toBe(true);
  });

  test("内置厂商：启用集照发；只有声明了补充字段才带 env；没改属性就不带 modelAttrs", () => {
    const common = {
      providerId: "openai",
      apiKey: "sk-1",
      isCustom: false,
      custom: { name: "", api: "openai-chat" as const, baseUrl: "", headers: [], models: [], autoDiscover: false },
    };
    const noEnv = buildSaveInput({
      ...common,
      builtin: { hasEnvFields: false, env: { A: "1" }, selected: ["gpt-5.6"], attrs: {} },
    });
    expect(noEnv.custom).toBeUndefined();
    expect(noEnv.models).toEqual(["gpt-5.6"]);
    expect(noEnv.env).toBeUndefined();
    expect(noEnv.modelAttrs).toBeUndefined();

    const withEnv = buildSaveInput({
      ...common,
      builtin: {
        hasEnvFields: true,
        env: { CLOUDFLARE_ACCOUNT_ID: "acc" },
        selected: [],
        attrs: { "gpt-5.6": { draft: { ...emptyAttrDraft("gpt-5.6"), ctx: "200000" } } },
      },
    });
    expect(withEnv.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acc" });
    expect(withEnv.modelAttrs).toHaveLength(1);
    expect(withEnv.modelAttrs![0].spec.contextWindow).toBe(200000);
  });
});

describe("attrSummary / thinkingSummary（行内摘要）", () => {
  test("容量摘要：有啥显示啥，都空则空串", () => {
    expect(attrSummary(emptyAttrDraft("m"))).toBe("");
    expect(attrSummary({ ...emptyAttrDraft("m"), ctx: "128000" })).toBe("128K");
    expect(attrSummary({ ...emptyAttrDraft("m"), ctx: "1000000", max: "8192" })).toBe("1M · 8192");
    expect(attrSummary({ ...emptyAttrDraft("m"), ctx: "abc" })).toBe("");
  });
  test("思考摘要：未勾支持 → 提示；勾了按档位标签 + 关闭下发值", () => {
    expect(thinkingSummary(emptyAttrDraft("m"))).toBe("未标记支持深度思考（先在上方勾选）");
    const d = { ...emptyAttrDraft("m"), reasoning: true, tOff: "none" };
    expect(thinkingSummary(d)).toBe("最小 / 轻度 / 中 / 高；关闭时下发 none");
    expect(thinkingSummary({ ...d, tOff: "" })).toBe("最小 / 轻度 / 中 / 高");
    const none = { ...d, tMin: false, tLow: false, tMed: false, tHigh: false };
    expect(thinkingSummary(none)).toBe("无思考档位");
  });
});

describe("isDraftFresh / mergeSeed（目录种子预填）", () => {
  const seed = {
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 16384,
    input: ["text", "image"],
    thinkingLevelMap: { off: "none" },
    supportedThinkingLevels: ["low", "high", "xhigh"],
    cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  };

  test("缺省草稿算 fresh；填过容量或单价就不算", () => {
    expect(isDraftFresh(emptyAttrDraft("m"))).toBe(true);
    expect(isDraftFresh({ ...emptyAttrDraft("m"), ctx: "1" })).toBe(false);
    expect(isDraftFresh({ ...emptyAttrDraft("m"), cIn: "0.5" })).toBe(false);
    // 编辑回填的已有模型（有生效值）不会被当成新模型去查种子
    expect(isDraftFresh(specToAttrDraft("m", { id: "m", contextWindow: 1 }))).toBe(false);
  });

  test("空字段被种子补上；档位整体按种子刷新", () => {
    const d = mergeSeed(emptyAttrDraft("m"), seed);
    expect(d.ctx).toBe("131072");
    expect(d.max).toBe("16384");
    expect(d.reasoning).toBe(true);
    expect(d.image).toBe(true);
    expect(d.tOff).toBe("none");
    expect([d.tMin, d.tLow, d.tMed, d.tHigh, d.tXhigh, d.tMax]).toEqual([false, true, false, true, true, false]);
    expect([d.cIn, d.cOut, d.cRead, d.cWrite]).toEqual(["0.5", "2", "0.1", "0.2"]);
  });

  test("fetch 元数据只补空的 ctx/max，不覆盖用户已填值", () => {
    const seeded = seedDraftWithModelSpec(emptyAttrDraft("m"), {
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    });
    expect(seeded.ctx).toBe("1000000");
    expect(seeded.max).toBe("8192");

    const manual = seedDraftWithModelSpec(
      { ...emptyAttrDraft("m"), ctx: "256000" },
      { contextWindow: 1_000_000, maxTokens: 8_192 },
    );
    expect(manual.ctx).toBe("256000");
    expect(manual.max).toBe("8192");
  });

  test("用户已填的字段不被种子覆盖（单价非 0 也算已填）", () => {
    const mine = { ...emptyAttrDraft("m"), ctx: "999", tOff: "off", cIn: "9" };
    const d = mergeSeed(mine, seed);
    expect(d.ctx).toBe("999");
    expect(d.tOff).toBe("off");
    expect(d.cIn).toBe("9");
    expect(d.cOut).toBe("2"); // 仍是初值 "0" 的才补
  });
});
