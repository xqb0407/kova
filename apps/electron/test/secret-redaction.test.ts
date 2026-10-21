import { afterEach, describe, expect, test } from "bun:test";
import {
  activeThreadSecrets,
  clearThreadSecretsForTest,
  redactToolResult,
  rememberThreadSecrets,
} from "../main/secret-redaction";

afterEach(() => clearThreadSecretsForTest());

const TOKEN = { name: "TOKEN", value: "sk-1234567890" };

describe("secret-redaction", () => {
  test("登记后 read 输出与嵌套字段都被脱敏", () => {
    rememberThreadSecrets("t1", [TOKEN], 1_000);
    const secrets = activeThreadSecrets("t1", 1_100);
    expect(secrets).toHaveLength(1);
    const result = redactToolResult(
      {
        output: "1\tsk-1234567890",
        nested: { text: "prefix sk-1234567890 suffix" },
      },
      secrets,
    ) as { output: string; nested: { text: string } };
    expect(result.output).toBe("1\t[REDACTED:TOKEN]");
    expect(result.nested.text).toBe("prefix [REDACTED:TOKEN] suffix");
  });

  test("图片字段不被改写", () => {
    const secrets = [TOKEN];
    const result = redactToolResult(
      { output: TOKEN.value, base64: TOKEN.value, mimeType: TOKEN.value },
      secrets,
    ) as { output: string; base64: string; mimeType: string };
    expect(result.output).toBe("[REDACTED:TOKEN]");
    expect(result.base64).toBe(TOKEN.value);
    expect(result.mimeType).toBe(TOKEN.value);
  });

  test("同名密钥以最新值为准", () => {
    rememberThreadSecrets("t2", [TOKEN], 1_000);
    rememberThreadSecrets("t2", [{ name: "TOKEN", value: "sk-new-0987654321" }], 1_100);
    const secrets = activeThreadSecrets("t2", 1_200);
    expect(secrets).toEqual([{ name: "TOKEN", value: "sk-new-0987654321" }]);
  });

  test("TTL 过期后不再脱敏", () => {
    rememberThreadSecrets("t3", [TOKEN], 1_000);
    expect(activeThreadSecrets("t3", 1_000 + 24 * 60 * 60 * 1000 + 1)).toEqual([]);
  });

  test("空 owner / 空密钥不登记", () => {
    rememberThreadSecrets("", [TOKEN]);
    rememberThreadSecrets("t4", []);
    expect(activeThreadSecrets("t4")).toEqual([]);
  });
});
