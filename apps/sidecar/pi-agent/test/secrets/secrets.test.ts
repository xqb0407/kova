/**
 * 密钥库模块测试：绑定解析（注入名单）+ 已加载技能台账。
 * 只测纯逻辑（策略判定），值本身不经过 sidecar——加密/注入/脱敏在 Rust 侧
 * （src-tauri/src/secret_env.rs 有对应单测 + 端到端 bash 注入测试）。
 */
import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SECRETS_CONFIG,
  applySecretsConfig,
  clearLoadedSkills,
  getSecretsConfig,
  isValidSecretName,
  loadedSkills,
  noteSkillLoaded,
  normalizeSecretsConfig,
  resetSecretsForTest,
  resolveSecretEnv,
  workspaceScope,
} from "../../src/secrets/secrets";
import {
  initLocalStorage,
  resetStorageForTest,
  secretDelete,
  secretList,
  secretSet,
} from "../../src/storage/hostdb";

const CWD = "/repo/demo";
const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-secrets-"));

// local 模式打通 kv 落盘路径（否则 applySecretsConfig 的持久化会记 warning 噪音）
beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  resetStorageForTest();
});

beforeEach(() => {
  resetSecretsForTest();
});

describe("normalizeSecretsConfig", () => {
  test("坏条目剔除，不整体失败", () => {
    const cfg = normalizeSecretsConfig({
      enabled: false,
      bindings: [
        { name: "GOOD_TOKEN", scope: "global", skills: ["Deploy", " * "] },
        { name: "1BAD", skills: ["x"] }, // 名字非法
        { scope: "global", skills: ["x"] }, // 缺名字
        "not-an-object",
        null,
      ],
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.bindings).toHaveLength(1);
    // 技能名归一（小写）；"*" 保留原义
    expect(cfg.bindings[0]).toEqual({
      name: "GOOD_TOKEN",
      scope: "global",
      skills: ["deploy", "*"],
    });
  });

  test("缺字段回落默认：enabled=true，scope 非法按 global", () => {
    const cfg = normalizeSecretsConfig({ bindings: [{ name: "A_B", scope: "elsewhere" }] });
    expect(cfg.enabled).toBe(true);
    expect(cfg.bindings[0]?.scope).toBe("global");
    expect(cfg.bindings[0]?.skills).toEqual([]);
  });

  test("非对象输入回落默认整包", () => {
    expect(normalizeSecretsConfig(undefined)).toEqual(DEFAULT_SECRETS_CONFIG);
    expect(normalizeSecretsConfig(null)).toEqual(DEFAULT_SECRETS_CONFIG);
  });
});

describe("resolveSecretEnv（注入名单解析）", () => {
  test("默认拒绝：没有绑定时不注入任何东西", () => {
    expect(resolveSecretEnv(CWD, "t1")).toEqual([]);
  });

  test("空技能列表 = 不注入（而不是注入给所有）", async () => {
    await applySecretsConfig({
      enabled: true,
      bindings: [{ name: "TOKEN", scope: "global", skills: [] }],
    });
    noteSkillLoaded("t1", "deploy");
    expect(resolveSecretEnv(CWD, "t1")).toEqual([]);
  });

  test('["*"] 对任意 bash 调用生效（无需加载技能）', async () => {
    await applySecretsConfig({
      enabled: true,
      bindings: [{ name: "GLOBAL_TOKEN", scope: "global", skills: ["*"] }],
    });
    expect(resolveSecretEnv(CWD, "t1")).toEqual([
      { name: "GLOBAL_TOKEN", scope: "global" },
    ]);
  });

  test("按技能授权：未加载不注入，加载后注入（名字大小写不敏感）", async () => {
    await applySecretsConfig({
      enabled: true,
      bindings: [{ name: "NPM_TOKEN", scope: "global", skills: ["deploy"] }],
    });
    expect(resolveSecretEnv(CWD, "t1")).toEqual([]);
    noteSkillLoaded("t1", "Deploy");
    expect(resolveSecretEnv(CWD, "t1")).toEqual([{ name: "NPM_TOKEN", scope: "global" }]);
    // 别的线程不受影响（台账按线程隔离）
    expect(resolveSecretEnv(CWD, "t2")).toEqual([]);
  });

  test("总开关关闭时一律不注入", async () => {
    await applySecretsConfig({
      enabled: false,
      bindings: [{ name: "TOKEN", scope: "global", skills: ["*"] }],
    });
    expect(resolveSecretEnv(CWD, "t1")).toEqual([]);
  });

  test("workspace 绑定展开成 workspace:<cwd>；同名只授权一次", async () => {
    await applySecretsConfig({
      enabled: true,
      bindings: [
        { name: "DEPLOY_KEY", scope: "workspace", skills: ["*"] },
        { name: "DEPLOY_KEY", scope: "global", skills: ["*"] },
      ],
    });
    expect(resolveSecretEnv(CWD, "t1")).toEqual([
      { name: "DEPLOY_KEY", scope: workspaceScope(CWD) },
    ]);
  });
});

describe("已加载技能台账", () => {
  test("登记幂等、按线程隔离、可清理", () => {
    noteSkillLoaded("t1", "Alpha");
    noteSkillLoaded("t1", "alpha");
    noteSkillLoaded("t1", "  ");
    noteSkillLoaded("t1", "beta");
    expect(loadedSkills("t1").sort()).toEqual(["alpha", "beta"]);
    expect(loadedSkills("t2")).toEqual([]);
    clearLoadedSkills("t1");
    expect(loadedSkills("t1")).toEqual([]);
  });
});

describe("isValidSecretName / applySecretsConfig", () => {
  test("名字规则与环境变量名一致", () => {
    expect(isValidSecretName("GITHUB_TOKEN")).toBe(true);
    expect(isValidSecretName("_x1")).toBe(true);
    expect(isValidSecretName("1BAD")).toBe(false);
    expect(isValidSecretName("has-dash")).toBe(false);
    expect(isValidSecretName("has space")).toBe(false);
    expect(isValidSecretName("")).toBe(false);
  });

  test("applySecretsConfig 回写内存（规范化后的形态）", async () => {
    const cfg = await applySecretsConfig({ enabled: true, bindings: [{ name: "T", skills: ["*"] }] });
    expect(cfg).toEqual(getSecretsConfig());
    expect(cfg.bindings[0]).toEqual({ name: "T", scope: "global", skills: ["*"] });
  });
});

describe("local 模式密钥往返（协议 handler 的底层）", () => {
  test("set → list（只有掩码，无明文）→ delete", async () => {
    await secretSet("DEMO_TOKEN", "global", "plain-value-abcd");
    const listed = await secretList();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "DEMO_TOKEN",
      scope: "global",
      masked: "****abcd",
      readable: true,
    });
    // 清单结构里绝不带明文（生产路径这条由 Rust secret_list 保证，此处覆盖 local 镜像）
    expect(JSON.stringify(listed)).not.toContain("plain-value-abcd");

    // 同名字不同作用域是两行；同 (name, scope) 覆盖
    await secretSet("DEMO_TOKEN", workspaceScope(CWD), "workspace-value-1");
    await secretSet("DEMO_TOKEN", "global", "plain-value-wxyz");
    const both = await secretList();
    expect(both).toHaveLength(2);
    expect(both.find((e) => e.scope === "global")?.masked).toBe("****wxyz");

    await secretDelete("DEMO_TOKEN", "global");
    const left = await secretList();
    expect(left).toHaveLength(1);
    expect(left[0]?.scope).toBe(workspaceScope(CWD));
    await secretDelete("DEMO_TOKEN", workspaceScope(CWD));
    expect(await secretList()).toHaveLength(0);
  });
});
