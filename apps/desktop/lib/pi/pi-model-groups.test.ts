import { describe, expect, test } from "bun:test";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import {
  buildModelOptions,
  groupModelOptions,
  modelOptionId,
  splitModelOptionId,
} from "@/lib/pi/pi-model-groups";

function mk(overrides: Partial<PiModelSummary> = {}): PiModelSummary {
  return {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    contextWindow: 200_000,
    authed: true,
    ...overrides,
  };
}

describe("modelOptionId", () => {
  test("复合 id = provider/modelId", () => {
    expect(modelOptionId(mk())).toBe("anthropic/claude-sonnet-4");
  });

  test("与 splitModelOptionId 互逆", () => {
    const m = mk({ provider: "custom-gw", id: "openai/gpt-4o" });
    const { provider, modelId } = splitModelOptionId(modelOptionId(m));
    expect(provider).toBe("custom-gw");
    expect(modelId).toBe("openai/gpt-4o");
  });
});

describe("splitModelOptionId", () => {
  test("在第一个 '/' 处切分，modelId 可含 '/'", () => {
    expect(splitModelOptionId("provider/a/b/c")).toEqual({
      provider: "provider",
      modelId: "a/b/c",
    });
  });

  test("普通 id", () => {
    expect(splitModelOptionId("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });
});

describe("buildModelOptions", () => {
  test("空目录返回空列表", () => {
    expect(buildModelOptions([])).toEqual([]);
  });

  test("基本字段映射：id/name/keywords/description + 行内 mark", () => {
    const [opt] = buildModelOptions([mk()]);
    const { icon, ...rest } = opt!;
    expect(icon).toBeTruthy();
    expect(rest).toEqual({
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      disabled: false,
      keywords: ["anthropic", "Anthropic"],
      description: "Anthropic · 200K",
    });
  });

  test("name 为空时回退到模型 id", () => {
    const [opt] = buildModelOptions([mk({ name: "" })]);
    expect(opt.name).toBe("claude-sonnet-4");
  });

  test("未配置凭据的服务置灰", () => {
    const [authed, notAuthed] = buildModelOptions([
      mk({ authed: true }),
      mk({ authed: false }),
    ]);
    expect(authed.disabled).toBe(false);
    expect(notAuthed.disabled).toBe(true);
  });

  test("上下文窗口格式化：>=1M 用 M，>=1K 用 K，其余原样", () => {
    const opts = buildModelOptions([
      mk({ id: "m1", contextWindow: 1_000_000 }),
      mk({ id: "m2", contextWindow: 1_234_567 }),
      mk({ id: "m3", contextWindow: 128_000 }),
      mk({ id: "m4", contextWindow: 512 }),
    ]);
    expect(opts.map((o) => o.description)).toEqual([
      "Anthropic · 1M",
      "Anthropic · 1.2M",
      "Anthropic · 128K",
      "Anthropic · 512",
    ]);
  });
});

describe("groupModelOptions", () => {
  test("按服务名分组并保持目录顺序", () => {
    const models = [
      mk(),
      mk({ provider: "openai", providerName: "OpenAI", id: "gpt-4o", name: "GPT-4o" }),
      mk({ provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" }),
    ];
    const options = buildModelOptions(models);
    const groups = groupModelOptions(models, options);

    expect(groups.map((g) => g.title)).toEqual(["Anthropic", "OpenAI"]);
    expect(groups[0]!.options.map((o) => o.id)).toEqual([
      "anthropic/claude-sonnet-4",
      "anthropic/claude-haiku",
    ]);
    expect(groups[1]!.options.map((o) => o.id)).toEqual(["openai/gpt-4o"]);
  });

  test("不同 provider 但同名服务合并到同一组", () => {
    const models = [
      mk({ provider: "gw-a", providerName: "My Gateway", id: "m1" }),
      mk({ provider: "gw-b", providerName: "My Gateway", id: "m2" }),
    ];
    const groups = groupModelOptions(models, buildModelOptions(models));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("My Gateway");
    expect(groups[0]!.options.map((o) => o.id)).toEqual(["gw-a/m1", "gw-b/m2"]);
  });

  test("选项不在目录中时回退到选项 id 作为分组标题", () => {
    const groups = groupModelOptions([], buildModelOptions([mk()]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("anthropic/claude-sonnet-4");
    expect(groups[0]!.options).toEqual(buildModelOptions([mk()]));
  });
});
