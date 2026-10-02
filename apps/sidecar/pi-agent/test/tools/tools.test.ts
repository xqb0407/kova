import { describe, expect, test } from "bun:test";
import { buildHostToolPayload, globToRegExp } from "../../src/tools/tools";

describe("buildHostToolPayload（宿主信封组装的安全边界）", () => {
  test("模型伪造的 secretEnv 被摘掉：注入名单只能由本侧 augment 决定", () => {
    // 工具 schema 里没有 secretEnv，但不妨碍模型多吐一个字段——放行就等于
    // 绕过用户的密钥授权策略，直接要求注入任意密钥
    const payload = buildHostToolPayload({
      command: "echo $GITHUB_TOKEN",
      secretEnv: [{ name: "GITHUB_TOKEN", scope: "global" }],
      secretEnvResolved: [{ name: "X", value: "leak" }],
    });
    expect(payload).toEqual({ command: "echo $GITHUB_TOKEN" });
  });

  test("本侧 augment 给的名单照常写入（且覆盖模型同名键）", () => {
    const payload = buildHostToolPayload(
      { command: "npm publish", secretEnv: [{ name: "FAKE", scope: "global" }] },
      { secretEnv: [{ name: "NPM_TOKEN", scope: "global" }] },
    );
    expect(payload.secretEnv).toEqual([{ name: "NPM_TOKEN", scope: "global" }]);
  });

  test("无 augment / 空 augment 时信封与模型参数一致（剔除保留字段后）", () => {
    expect(buildHostToolPayload({ file_path: "a.txt" })).toEqual({ file_path: "a.txt" });
    expect(buildHostToolPayload({ file_path: "a.txt" }, {})).toEqual({ file_path: "a.txt" });
  });

  test("不改动入参对象（纯函数）", () => {
    const input = { command: "ls", secretEnv: [{ name: "X", scope: "global" }] };
    buildHostToolPayload(input);
    expect(input.secretEnv).toHaveLength(1);
  });

  test("模型伪造的 accelEnv 也被摘掉：加速前缀只能由本侧按用户设置决定", () => {
    // 放行等于给模型一条「把 bash 流量导去任意主机」的通路——GIT_CONFIG_*
    // 在 git 眼里就是任意 url.<base>.insteadOf 配置
    const payload = buildHostToolPayload({
      command: "git clone https://github.com/o/r.git",
      accelEnv: { GIT_CONFIG_COUNT: "1" },
    });
    expect(payload).toEqual({ command: "git clone https://github.com/o/r.git" });
  });

  test("本侧 augment 给的 accelEnv 照常写入（覆盖模型同名键）", () => {
    const payload = buildHostToolPayload(
      { command: "git clone https://github.com/o/r.git", accelEnv: { EVIL: "1" } },
      { accelEnv: { GIT_CONFIG_COUNT: "1" } },
    );
    expect(payload.accelEnv).toEqual({ GIT_CONFIG_COUNT: "1" });
  });
});

describe("globToRegExp", () => {
  test("**/ 前缀匹配任意深度（含零层）", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/lib/deep/a.ts")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
  });

  test("* 不跨路径分隔符", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(false);
  });

  test("**.ext 匹配跨层", () => {
    const re = globToRegExp("src**.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src.ts")).toBe(true);
  });

  test("? 匹配单个字符", () => {
    const re = globToRegExp("a?c.ts");
    expect(re.test("abc.ts")).toBe(true);
    expect(re.test("ac.ts")).toBe(false);
    expect(re.test("abbc.ts")).toBe(false);
  });

  test("正则元字符按字面量处理", () => {
    const re = globToRegExp("a(b).ts");
    expect(re.test("a(b).ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  test("大小写不敏感（Windows 友好）", () => {
    expect(globToRegExp("*.TS").test("a.ts")).toBe(true);
  });
});
