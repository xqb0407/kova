import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDirArg, isAcpMode, resolveAcpPaths } from "../../src/acp/config";

describe("ACP 模式识别", () => {
  test("--acp 与 KOVA_ACP=1 都识别", () => {
    expect(isAcpMode(["bun", "src/index.ts", "--acp"], {})).toBe(true);
    expect(isAcpMode(["bun", "src/index.ts"], { KOVA_ACP: "1" })).toBe(true);
    expect(isAcpMode(["bun", "src/index.ts"], { KOVA_ACP: "true" })).toBe(true);
    expect(isAcpMode(["bun", "src/index.ts"], {})).toBe(false);
  });

  test("--data-dir 两种写法", () => {
    expect(dataDirArg(["bun", "--data-dir", "/tmp/a"])).toBe("/tmp/a");
    expect(dataDirArg(["bun", "--data-dir=/tmp/b"])).toBe("/tmp/b");
    expect(dataDirArg(["bun", "--data-dir"])).toBeUndefined();
  });
});

describe("ACP 路径解析", () => {
  test("--data-dir 优先于环境变量，默认目录在 ~/.kova/acp", () => {
    const argvPath = resolveAcpPaths(
      ["bun", "--data-dir", "/tmp/kova-acp-argv"],
      { KOVA_ACP_DATA_DIR: "/tmp/kova-acp-env" },
    );
    expect(argvPath.dataDir).toBe(resolve("/tmp/kova-acp-argv"));

    const envPath = resolveAcpPaths(["bun"], {
      KOVA_ACP_DATA_DIR: "/tmp/kova-acp-env",
    });
    expect(envPath.dataDir).toBe(resolve("/tmp/kova-acp-env"));
    expect(envPath.dbPath).toBe(resolve("/tmp/kova-acp-env/state.db"));
    expect(envPath.sessionsDir).toBe(resolve("/tmp/kova-acp-env/sessions"));

    const def = resolveAcpPaths(["bun"], {});
    expect(def.dataDir).toBe(join(homedir(), ".kova", "acp"));
  });
});
