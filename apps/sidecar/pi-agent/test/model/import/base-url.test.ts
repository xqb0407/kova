import { describe, test, expect } from "bun:test";
import { normalizeImportedBaseUrl } from "../../../src/model/import/types";

/**
 * baseUrl 归一化：Kova 在 baseUrl 之后直接接端点路径，不做版本推断
 * （openai-chat → /chat/completions，openai-responses → /responses，
 *  anthropic-messages → /v1/messages）。来源配置写法不统一，必须先归一，
 * 否则会出现 127.0.0.1:1234/responses 这种必然 404 的地址。
 */
describe("normalizeImportedBaseUrl · openai 类（版本段要在 baseUrl 里）", () => {
  test("缺版本段时补 /v1", () => {
    expect(normalizeImportedBaseUrl("https://api.deepseek.com", "openai-chat")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeImportedBaseUrl("https://token.sensenova.cn", "openai-chat")).toBe(
      "https://token.sensenova.cn/v1",
    );
  });

  test("本地端点带尾斜杠：既去尾斜杠又补版本段", () => {
    // 实测踩到的坑：LM Studio 的 base 写成 http://127.0.0.1:1234/，
    // 直接照抄会拼成 http://127.0.0.1:1234/responses
    expect(normalizeImportedBaseUrl("http://127.0.0.1:1234/", "openai-responses")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  test("已有版本段不动", () => {
    expect(normalizeImportedBaseUrl("https://opencode.ai/zen/go/v1", "openai-chat")).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(normalizeImportedBaseUrl("https://example.com/v2", "openai-responses")).toBe(
      "https://example.com/v2",
    );
  });

  test("带私有前缀的路径认得出末段是版本号，不重复补", () => {
    expect(
      normalizeImportedBaseUrl(
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "openai-chat",
      ),
    ).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(
      normalizeImportedBaseUrl("https://ark.cn-beijing.volces.com/api/coding/v3", "openai-responses"),
    ).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
  });

  test("末段不是版本号才补：/apps/anthropic 这类路径对 openai 类仍会补 /v1", () => {
    expect(
      normalizeImportedBaseUrl("https://gw.example.com/apps/anthropic", "openai-chat"),
    ).toBe("https://gw.example.com/apps/anthropic/v1");
  });

  test("保留端口、查询串与 fragment", () => {
    expect(
      normalizeImportedBaseUrl("https://aigw.example.com:8443/v1?k=1#f", "openai-chat"),
    ).toBe("https://aigw.example.com:8443/v1?k=1#f");
    expect(normalizeImportedBaseUrl("https://aigw.example.com:8443", "openai-chat")).toBe(
      "https://aigw.example.com:8443/v1",
    );
  });
});

describe("normalizeImportedBaseUrl · anthropic 类（版本段要留给 Kova 补）", () => {
  test("不带版本段的原样保留", () => {
    expect(
      normalizeImportedBaseUrl("https://token.sensenova.cn", "anthropic-messages"),
    ).toBe("https://token.sensenova.cn");
    expect(
      normalizeImportedBaseUrl("https://coding.dashscope.aliyuncs.com/apps/anthropic", "anthropic-messages"),
    ).toBe("https://coding.dashscope.aliyuncs.com/apps/anthropic");
  });

  test("尾部带 /v1 的要剥掉，否则 Kova 拼成 /v1/v1/messages", () => {
    expect(normalizeImportedBaseUrl("https://foo.example.com/v1", "anthropic-messages")).toBe(
      "https://foo.example.com",
    );
    expect(
      normalizeImportedBaseUrl("https://gw.example.com/apps/anthropic/v1", "anthropic-messages"),
    ).toBe("https://gw.example.com/apps/anthropic");
  });

  test("中间段的 /v1 不动（只有尾部那层是版本段）", () => {
    expect(
      normalizeImportedBaseUrl("https://v1.example.com/apps/anthropic", "anthropic-messages"),
    ).toBe("https://v1.example.com/apps/anthropic");
  });

  test("尾斜杠照样去掉", () => {
    expect(
      normalizeImportedBaseUrl("https://foo.example.com/", "anthropic-messages"),
    ).toBe("https://foo.example.com");
  });
});

describe("normalizeImportedBaseUrl · 容错", () => {
  test("URL 解析不了时原样返回，交给写入层报错而不是静默改坏", () => {
    expect(normalizeImportedBaseUrl("不是地址", "openai-chat")).toBe("不是地址");
  });

  test("幂等：归一一次再归一次结果不变", () => {
    const once = normalizeImportedBaseUrl("https://api.deepseek.com", "openai-chat");
    expect(normalizeImportedBaseUrl(once, "openai-chat")).toBe(once);
    const anth = normalizeImportedBaseUrl("https://foo.example.com/v1", "anthropic-messages");
    expect(normalizeImportedBaseUrl(anth, "anthropic-messages")).toBe(anth);
  });
});