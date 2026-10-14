import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyAppMode,
  APP_MODE_KV_KEY,
  DEFAULT_APP_MODE,
  effectiveAppMode,
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

describe("appModePromptBlock / composeModeSystemPrompt（档位是入参，不是模块全局）", () => {
  test("code 档为空串；work 档含 Work mode 段", () => {
    expect(appModePromptBlock("code")).toBe("");
    const P_code = composeModeSystemPrompt("agent", "/tmp/proj", "code", null);
    expect(P_code).not.toContain("Work mode");
    expect(P_code).not.toContain("Design mode");
    expect(P_code.startsWith(SYSTEM_PROMPT_CORE)).toBe(true);

    const block = appModePromptBlock("work");
    expect(block).toContain("You are operating in Work mode");
    expect(block).toContain("take precedence");

    // 个性化段为空时，work 段应恰好插在模式附加段之后（其余字节不动）
    const P_work = composeModeSystemPrompt("agent", "/tmp/proj", "work", null);
    expect(P_work).toBe(
      P_code.replace(
        AGENT_MODE_PROMPT,
        `${AGENT_MODE_PROMPT}\n\n${block}`,
      ),
    );
    expect(P_work.split("You are operating in Work mode").length - 1).toBe(1);
  });

  test("design 档含 Design mode 段且插入位置与 work 同槽", () => {
    setUiDesignActiveProbeForTest(() => true);
    const block = appModePromptBlock("design");
    expect(block).toContain("You are operating in Design mode");
    expect(block).toContain("*.uidesign.json");
    expect(block).toContain("use_skill");
    expect(block).not.toContain("NOT currently installed");

    const P_design = composeModeSystemPrompt("agent", "/tmp/proj", "design", null);
    expect(P_design).toContain(block);
    expect(P_design).not.toContain("Work mode");
    expect(P_design.split("You are operating in Design mode").length - 1).toBe(1);
  });

  test("ui-design 插件未启用时 design 段追加引导安装句", () => {
    setUiDesignActiveProbeForTest(() => false);
    const block = appModePromptBlock("design");
    expect(block).toContain("NOT currently installed");
    expect(block).toContain("UI 设计");
  });

  /** 会话隔离的根：提示词段只随入参档变，切换全局默认不动已定档会话。
   *  （旧行为是读模块全局 —— A 会话切档把所有驻留会话的提示词一起换掉） */
  test("全局默认漂移不改写已定档会话的提示词", async () => {
    setUiDesignActiveProbeForTest(null);
    await applyAppMode("work");
    // 自己切过档、停在 code 的会话：偏好列有值 → 提示词不含 work 段
    const P_code = composeModeSystemPrompt("agent", "/tmp/proj", effectiveAppMode("code"), null);
    expect(P_code).not.toContain("Work mode");
    // 从未切过档的会话：偏好列为 NULL → 跟默认档，含 work 段
    const P_follow = composeModeSystemPrompt("agent", "/tmp/proj", effectiveAppMode(null), null);
    expect(P_follow).toContain("You are operating in Work mode");
    await applyAppMode("code");
  });
});

describe("effectiveAppMode（会话生效档裁决：偏好列 ?? 全局默认）", () => {
  test("合法偏好值优先；NULL/缺省/脏值跟随当前全局默认", async () => {
    await applyAppMode("design");
    expect(effectiveAppMode("work")).toBe("work");
    expect(effectiveAppMode("code")).toBe("code");
    expect(effectiveAppMode(null)).toBe("design");
    expect(effectiveAppMode(undefined)).toBe("design");
    expect(effectiveAppMode("banana")).toBe("design");
    await applyAppMode("code");
    expect(effectiveAppMode(null)).toBe("code");
  });
});

/** 绕过 applyAppMode 直写 kv（模拟旧版/损坏数据） */
async function kvSetRaw(key: string, value: string): Promise<void> {
  const { kvSet } = await import("../../src/storage/hostdb");
  await kvSet(key, value);
}
