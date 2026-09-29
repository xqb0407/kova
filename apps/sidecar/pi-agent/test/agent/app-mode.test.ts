import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyAppMode,
  APP_MODE_KV_KEY,
  DEFAULT_APP_MODE,
  getAppMode,
  initAppMode,
  normalizeAppMode,
  resetAppModeForTest,
  setUiDesignActiveProbeForTest,
  appModePromptBlock,
} from "../../src/agent/app-mode";
import { AGENT_MODE_PROMPT, composeModeSystemPrompt } from "../../src/agent/modes";
import { initLocalStorage, kvGet, resetStorageForTest } from "../../src/storage/hostdb";
import { SYSTEM_PROMPT_CORE } from "../../src/tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-app-mode-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 身份文件实时读盘：钉到临时目录，避免触碰开发者真实 ~/.kova/（个性化段为空
  // 是 work 段插入位置断言的前提）
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态/env，避免污染后续文件
  resetAppModeForTest();
  setUiDesignActiveProbeForTest(null);
  resetStorageForTest();
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("normalizeAppMode", () => {
  test("仅接受三档字面量，其余回落 code", () => {
    expect(normalizeAppMode("work")).toBe("work");
    expect(normalizeAppMode("code")).toBe("code");
    expect(normalizeAppMode("design")).toBe("design");
    expect(normalizeAppMode("nope")).toBe("code");
    expect(normalizeAppMode(42)).toBe("code");
    expect(normalizeAppMode(null)).toBe("code");
    expect(normalizeAppMode(undefined)).toBe("code");
  });
});

describe("initAppMode / applyAppMode（kv 往返）", () => {
  test("applyAppMode 落 kv 且内存即时生效；initAppMode 从 kv 恢复", async () => {
    expect(getAppMode()).toBe(DEFAULT_APP_MODE);
    const applied = await applyAppMode("work");
    expect(applied).toBe("work");
    expect(getAppMode()).toBe("work");
    const row = await kvGet(APP_MODE_KV_KEY);
    expect(JSON.parse(row!.value as string)).toBe("work");

    // 模拟进程重启：内存清空后 init 恢复
    resetAppModeForTest();
    expect(getAppMode()).toBe("code");
    await initAppMode();
    expect(getAppMode()).toBe("work");
  });

  test("design 档同样落 kv 并经 init 恢复", async () => {
    const applied = await applyAppMode("design");
    expect(applied).toBe("design");
    resetAppModeForTest();
    await initAppMode();
    expect(getAppMode()).toBe("design");
  });

  test("kv 损坏/非法值回落默认，不抛错", async () => {
    await kvSetRaw(APP_MODE_KV_KEY, "{broken json");
    resetAppModeForTest();
    await initAppMode();
    expect(getAppMode()).toBe("code");

    await kvSetRaw(APP_MODE_KV_KEY, JSON.stringify("agent"));
    await initAppMode();
    expect(getAppMode()).toBe("code");
  });

  test("applyAppMode 非法值回落 code 并落 kv", async () => {
    const applied = await applyAppMode("plan");
    expect(applied).toBe("code");
    expect(getAppMode()).toBe("code");
  });
});

describe("appModePromptBlock / composeModeSystemPrompt", () => {
  test("code 档为空串；work 档含 Work mode 段", async () => {
    await applyAppMode("code");
    expect(appModePromptBlock()).toBe("");
    const P_code = composeModeSystemPrompt("agent", "/tmp/proj", null);
    expect(P_code).not.toContain("Work mode");
    expect(P_code).not.toContain("Design mode");
    expect(P_code.startsWith(SYSTEM_PROMPT_CORE)).toBe(true);

    await applyAppMode("work");
    const block = appModePromptBlock();
    expect(block).toContain("You are operating in Work mode");
    expect(block).toContain("take precedence");

    // 个性化段为空时，work 段应恰好插在模式附加段之后（其余字节不动）
    const P_work = composeModeSystemPrompt("agent", "/tmp/proj", null);
    expect(P_work).toBe(
      P_code.replace(
        AGENT_MODE_PROMPT,
        `${AGENT_MODE_PROMPT}\n\n${block}`,
      ),
    );
    expect(P_work.split("You are operating in Work mode").length - 1).toBe(1);
  });

  test("design 档含 Design mode 段且插入位置与 work 同槽", async () => {
    setUiDesignActiveProbeForTest(() => true);
    await applyAppMode("design");
    const block = appModePromptBlock();
    expect(block).toContain("You are operating in Design mode");
    expect(block).toContain("*.uidesign.json");
    expect(block).toContain("use_skill");
    expect(block).not.toContain("NOT currently installed");

    const P_design = composeModeSystemPrompt("agent", "/tmp/proj", null);
    expect(P_design).toContain(block);
    expect(P_design).not.toContain("Work mode");
    expect(P_design.split("You are operating in Design mode").length - 1).toBe(1);
  });

  test("ui-design 插件未启用时 design 段追加引导安装句", async () => {
    setUiDesignActiveProbeForTest(() => false);
    await applyAppMode("design");
    const block = appModePromptBlock();
    expect(block).toContain("NOT currently installed");
    expect(block).toContain("UI 设计");
  });

  test("切回 code 后提示词回到不含 work/design 段的形态", async () => {
    setUiDesignActiveProbeForTest(null);
    await applyAppMode("code");
    expect(appModePromptBlock()).toBe("");
    const P = composeModeSystemPrompt("agent", "/tmp/proj", null);
    expect(P).not.toContain("Work mode");
    expect(P).not.toContain("Design mode");
  });
});

/** 绕过 applyAppMode 直写 kv（模拟旧版/损坏数据） */
async function kvSetRaw(key: string, value: string): Promise<void> {
  const { kvSet } = await import("../../src/storage/hostdb");
  await kvSet(key, value);
}
