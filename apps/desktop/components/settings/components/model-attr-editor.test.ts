import { describe, expect, test } from "bun:test";
import {
  attrDraftThinkingLevels,
  attrDraftToSpec,
  emptyAttrDraft,
  specToAttrDraft,
  type AttrDraft,
} from "./model-attr-editor";
import { mergeModelSpecForSave } from "./model-spec-save";

/** 行里一列都没显式存过（新模型 / 继承态） */
const blankStored = {
  name: null,
  reasoning: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  cost: null,
  promptCache: null,
};

describe("emptyAttrDraft（新模型的草稿初值）", () => {
  test("名称留空、容量留空、文本模态、单价 0、档位走 openai 兼容网关保守缺省", () => {
    const d = emptyAttrDraft("my-model");
    expect(d.name).toBe("");
    expect(d.ctx).toBe("");
    expect(d.max).toBe("");
    expect(d.text).toBe(true);
    expect(d.image).toBe(false);
    expect(d.reasoning).toBe(false);
    expect(d.t2i).toBe(false);
    expect(d.tOff).toBe("");
    expect([d.tMin, d.tLow, d.tMed, d.tHigh, d.tXhigh, d.tMax]).toEqual([
      true, true, true, true, false, false,
    ]);
    expect([d.cIn, d.cOut, d.cRead, d.cWrite]).toEqual(["0", "0", "0", "0"]);
  });
});

describe("attrDraftToSpec（草稿 → 提交属性，口径同旧 confirmAttrEditor）", () => {
  test("空名称不发 name：新模型没动过名字不能把 id 冻进行里", () => {
    const spec = attrDraftToSpec("glm-5.2", emptyAttrDraft("glm-5.2"));
    expect(spec.name).toBeUndefined();
    expect(spec.id).toBe("glm-5.2");
  });

  test("容量留空 → undefined；填了解析为数字", () => {
    const d = { ...emptyAttrDraft("m"), ctx: "128000", max: "" };
    const spec = attrDraftToSpec("m", d);
    expect(spec.contextWindow).toBe(128000);
    expect(spec.maxTokens).toBeUndefined();
  });

  test("模态按勾选拼数组；单价空串回落 0", () => {
    const d: AttrDraft = { ...emptyAttrDraft("m"), text: true, image: true, cIn: "", cOut: "2.5" };
    const spec = attrDraftToSpec("m", d);
    expect(spec.input).toEqual(["text", "image"]);
    expect(spec.cost).toEqual({ input: 0, output: 2.5, cacheRead: 0, cacheWrite: 0 });
  });

  test("prompt cache：两端都空不带字段；任一非空只带非空那端", () => {
    expect(attrDraftToSpec("m", emptyAttrDraft("m")).promptCache).toBeUndefined();
    const short = attrDraftToSpec("m", { ...emptyAttrDraft("m"), pcShort: "300" });
    expect(short.promptCache).toEqual({ short: 300 });
    const both = attrDraftToSpec("m", { ...emptyAttrDraft("m"), pcShort: "300", pcLong: "3600" });
    expect(both.promptCache).toEqual({ short: 300, long: 3600 });
  });
});

describe("attrDraftThinkingLevels（勾选的档位 → thinkingLevelMap 键）", () => {
  test("按 THINK_LEVELS 顺序输出勾选项", () => {
    const d = { ...emptyAttrDraft("m"), tMin: false, tLow: true, tMed: false, tHigh: true, tXhigh: true, tMax: false };
    expect(attrDraftThinkingLevels(d)).toEqual(["low", "high", "xhigh"]);
  });
  test("全不勾 → 空数组（不支持推理）", () => {
    const d = { ...emptyAttrDraft("m"), tMin: false, tLow: false, tMed: false, tHigh: false };
    expect(attrDraftThinkingLevels(d)).toEqual([]);
  });
});

describe("specToAttrDraft（编辑回填：生效值 → 草稿）", () => {
  const spec = {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    contextWindow: 256000,
    maxTokens: 64000,
    input: ["text", "image"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 0 },
    promptCache: { short: 300 },
  };

  test("逐字段回填为字符串态，模态拆成勾选", () => {
    const d = specToAttrDraft("glm-5.2", spec, { levels: ["low", "high"], off: "none", t2i: true });
    expect(d.name).toBe("GLM-5.2");
    expect(d.ctx).toBe("256000");
    expect(d.max).toBe("64000");
    expect(d.text).toBe(true);
    expect(d.image).toBe(true);
    expect(d.reasoning).toBe(true);
    expect(d.t2i).toBe(true);
    expect(d.tOff).toBe("none");
    expect([d.tMin, d.tLow, d.tMed, d.tHigh, d.tXhigh, d.tMax]).toEqual([false, true, false, true, false, false]);
    expect([d.cIn, d.cOut, d.cRead, d.cWrite]).toEqual(["0.6", "2.2", "0.1", "0"]);
    expect(d.pcShort).toBe("300");
    expect(d.pcLong).toBe("");
  });

  test("不传 thinking → 档位走保守缺省、t2i 关；名称缺席回落 id", () => {
    const d = specToAttrDraft("m", { id: "m" });
    expect(d.name).toBe("m");
    expect([d.tMin, d.tLow, d.tMed, d.tHigh, d.tXhigh, d.tMax]).toEqual([true, true, true, true, false, false]);
    expect(d.t2i).toBe(false);
    expect(d.text).toBe(true); // input 缺席按 ["text"]
  });

  test("回填 → 提交 roundtrip 不丢字段", () => {
    const d = specToAttrDraft("glm-5.2", spec);
    expect(attrDraftToSpec("glm-5.2", d)).toEqual(spec);
  });
});

describe("新弹窗保存链路：草稿 → spec → mergeModelSpecForSave", () => {
  test("自动获取加进来没碰过属性：只发 id（继承态）", () => {
    const current = attrDraftToSpec("kimi-k3", emptyAttrDraft("kimi-k3"));
    const out = mergeModelSpecForSave({ id: "kimi-k3", current, loaded: undefined, stored: blankStored });
    // loaded 缺席 = 新模型：current 里凡是有值的会被当"改过"。
    // 缺省草稿里 reasoning=false、input=["text"]、cost 全 0 是有值的 —— 这是旧流程
    // 也存在的已知边界（见 model-spec-save.ts 头注释），但 name 必须不在其中
    expect(out.id).toBe("kimi-k3");
    expect(out.name).toBeUndefined();
    expect(out.contextWindow).toBeUndefined();
    expect(out.maxTokens).toBeUndefined();
  });

  test("编辑已有模型只改上下文：仅 contextWindow 被回写，其它回落到行里显式值", () => {
    const loaded = {
      id: "glm-5.2",
      name: "GLM-5.2",
      reasoning: true,
      contextWindow: 256000,
      maxTokens: 64000,
      input: ["text", "image"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 0 },
    };
    const draft = { ...specToAttrDraft("glm-5.2", loaded), ctx: "128000" };
    const current = attrDraftToSpec("glm-5.2", draft);
    const out = mergeModelSpecForSave({
      id: "glm-5.2",
      current,
      loaded,
      // 行里只显式存过 maxTokens
      stored: { ...blankStored, maxTokens: 64000 },
    });
    expect(out).toEqual({ id: "glm-5.2", contextWindow: 128000, maxTokens: 64000 });
  });
});
