import { describe, expect, test } from "bun:test";
import { parseMcpSecretEnvRequests, parseSecretRequests } from "../main/secret-requests";

describe("parseSecretRequests", () => {
  test("顶层 secretEnv（旧 Rust 信封）", () => {
    expect(
      parseSecretRequests({ secretEnv: [{ name: "TOKEN", scope: "global" }] }),
    ).toEqual([{ name: "TOKEN", scope: "global" }]);
  });

  test("嵌套 params.secretEnv（Electron hostToolCall 信封）", () => {
    expect(
      parseSecretRequests({
        name: "bash",
        params: { secretEnv: [{ name: "TOKEN", scope: "workspace:/tmp/x" }] },
      }),
    ).toEqual([{ name: "TOKEN", scope: "workspace:/tmp/x" }]);
  });

  test("非法条目丢弃，合法条目保留", () => {
    expect(
      parseSecretRequests({
        params: {
          secretEnv: [
            { name: "1BAD", scope: "global" },
            { name: "GOOD", scope: "global" },
            { name: "ALSO_GOOD" },
            "not-an-object",
          ],
        },
      }),
    ).toEqual([
      { name: "GOOD", scope: "global" },
      { name: "ALSO_GOOD", scope: "global" },
    ]);
  });

  test("缺 secretEnv / 非数组返回空", () => {
    expect(parseSecretRequests({})).toEqual([]);
    expect(parseSecretRequests({ params: {} })).toEqual([]);
    expect(parseSecretRequests({ params: { secretEnv: "nope" } })).toEqual([]);
  });
});

describe("parseMcpSecretEnvRequests", () => {
  test("只保留合法的 global 请求，envName 可不同于密钥名", () => {
    expect(
      parseMcpSecretEnvRequests([
        { envName: "GITHUB_TOKEN", name: "GH_PAT", scope: "global" },
        { envName: "WORKSPACE_ONLY", name: "WS_KEY", scope: "workspace:/tmp/x" },
        { envName: "1BAD", name: "OK" },
        { envName: "MISSING_NAME" },
        "not-an-object",
      ]),
    ).toEqual([{ envName: "GITHUB_TOKEN", name: "GH_PAT", scope: "global" }]);
  });

  test("重复 envName 只保留第一条", () => {
    expect(
      parseMcpSecretEnvRequests([
        { envName: "TOKEN", name: "A" },
        { envName: "TOKEN", name: "B" },
      ]),
    ).toEqual([{ envName: "TOKEN", name: "A", scope: "global" }]);
  });

  test("非数组返回空", () => {
    expect(parseMcpSecretEnvRequests(undefined)).toEqual([]);
    expect(parseMcpSecretEnvRequests("nope")).toEqual([]);
  });
});
