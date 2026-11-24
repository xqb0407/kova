import { describe, expect, test } from "bun:test";
import { normalizeUhpConfig, defaultUhpConfig } from "../main/uhp/config";
import { buildModelsResponse, resolveModelEntry, canonicalModelId } from "../main/uhp/model";
import { constantTimeEqual } from "../main/uhp/auth";
import { parseMultipart } from "../main/uhp/multipart";
import { zipStore } from "../main/uhp/zip";

describe("UHP settings normalization", () => {
  test("clamps invalid port and approval values", () => {
    const config = normalizeUhpConfig({
      enabled: true,
      port: 999999,
      approvalLevel: "nope",
      maxConcurrentTasks: 99,
      responseRetentionDays: -1,
    });
    expect(config.port).toBe(65535);
    expect(config.approvalLevel).toBe("workspace-write");
    expect(config.maxConcurrentTasks).toBe(16);
    expect(config.responseRetentionDays).toBe(1);
  });

  test("keeps defaults for non-object input", () => {
    expect(normalizeUhpConfig(null)).toEqual(defaultUhpConfig());
  });
});

describe("UHP model projection", () => {
  const models = [
    { provider: "openai", providerName: "OpenAI", id: "gpt-5", name: "GPT-5", enabled: true, authed: true },
    { provider: "openai", providerName: "OpenAI", id: "gpt-5-mini", name: "GPT-5 mini", enabled: true, authed: false },
  ];

  test("canonical id is provider/model", () => {
    expect(canonicalModelId(models[0])).toBe("openai/gpt-5");
  });

  test("resolves canonical and unique bare ids", () => {
    expect(resolveModelEntry(models, "openai/gpt-5")?.id).toBe("gpt-5");
    expect(resolveModelEntry(models, "gpt-5")?.id).toBe("gpt-5");
    expect(resolveModelEntry(models, "missing")).toBeNull();
  });

  test("reports availability and a backend default", () => {
    const response = buildModelsResponse(models, "openai/gpt-5");
    expect(response.backends.openai?.default).toBe("openai/gpt-5");
    expect(response.backends.openai?.models.find((m) => m.id === "openai/gpt-5")?.default).toBe(true);
    expect(response.backends.openai?.models.find((m) => m.id === "openai/gpt-5-mini")?.available).toBe(false);
  });
});

describe("UHP auth", () => {
  test("constant-time equality handles length mismatch", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("UHP multipart", () => {
  test("parses one file part", () => {
    const boundary = "----test";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts).toHaveLength(1);
    expect(parts[0].filename).toBe("a.txt");
    expect(parts[0].data.toString()).toBe("hello");
  });
});

describe("UHP zip", () => {
  test("writes a valid empty zip", () => {
    const zip = zipStore([]);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0506");
  });

  test("writes one stored/deflated entry", () => {
    const zip = zipStore([{ name: "a.txt", data: Buffer.from("hello") }]);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(zip.includes(Buffer.from("a.txt"))).toBe(true);
  });
});
