import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyPersonalization,
  DEFAULT_PERSONALIZATION,
  getPersonalization,
  initPersonalization,
  normalizePersonalization,
  personalizationPromptBlock,
  PERSONALIZATION_KV_KEY,
  resetPersonalizationForTest,
} from "./personalization";
import { composeModeSystemPrompt } from "./modes";
import { initLocalStorage, kvGet, resetStorageForTest } from "./hostdb";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "./tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-personalization-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与 transport/连接，避免污染后续文件
  resetPersonalizationForTest();
  resetStorageForTest();
});

describe("normalizePersonalization", () => {
  test("未知档位与非字符串字段回落默认", () => {
    expect(normalizePersonalization({ style: "nope", userName: 42 })).toEqual(
      DEFAULT_PERSONALIZATION,
    );
    expect(normalizePersonalization(null)).toEqual(DEFAULT_PERSONALIZATION);
    expect(normalizePersonalization(undefined)).toEqual(DEFAULT_PERSONALIZATION);
  });

  test("超长字段截断，称呼去首尾空白", () => {
    const n = normalizePersonalization({
      style: "blunt",
      userName: "  小明  ",
      persona: "x".repeat(5000),
      customInstructions: "y".repeat(9000),
    });
    expect(n.style).toBe("blunt");
    expect(n.userName).toBe("小明");
    expect(n.persona.length).toBe(4000);
    expect(n.customInstructions.length).toBe(8000);
  });
});

describe("personalizationPromptBlock", () => {
  test("全默认时为空串，默认提示词字节级不变", async () => {
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    expect(personalizationPromptBlock()).toBe("");
    const baseline = composeModeSystemPrompt("agent", "/tmp/ws");
    expect(baseline).toContain(SYSTEM_PROMPT_CORE);
    expect(baseline.endsWith(workspacePromptLine("/tmp/ws"))).toBe(true);
  });

  test("组合风格/称呼/人设/自定义指令，注入在 cwd 行之前", async () => {
    await applyPersonalization({
      style: "blunt",
      userName: "老王",
      assistantName: "Buddy",
      persona: "资深前端搭档",
      customInstructions: "用中文回复",
    });
    const block = personalizationPromptBlock();
    expect(block).toContain("Reply style - direct");
    expect(block).toContain('Your name is "Buddy".');
    expect(block).toContain('The user goes by "老王".');
    expect(block).toContain("Persona: 资深前端搭档");
    expect(block).toContain("always apply): 用中文回复");

    const prompt = composeModeSystemPrompt("agent", "/tmp/ws");
    expect(prompt).toContain(block);
    const cwdIndex = prompt.indexOf(workspacePromptLine("/tmp/ws"));
    expect(prompt.startsWith(SYSTEM_PROMPT_CORE)).toBe(true);
    expect(prompt.indexOf("Reply style - direct")).toBeLessThan(cwdIndex);
  });

  test("plan 模式同样携带个性化段", () => {
    const prompt = composeModeSystemPrompt("plan", "/tmp/ws");
    expect(prompt).toContain("Reply style - direct");
    expect(prompt).toContain("Plan mode");
  });

  test("恢复默认后提示词回到基线", async () => {
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    const baseline = composeModeSystemPrompt("agent", "/tmp/ws");
    await applyPersonalization({ style: "friendly" });
    expect(composeModeSystemPrompt("agent", "/tmp/ws")).not.toBe(baseline);
    expect(composeModeSystemPrompt("agent", "/tmp/ws")).toContain(
      "Reply style - warm and approachable",
    );
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    expect(composeModeSystemPrompt("agent", "/tmp/ws")).toBe(baseline);
  });
});

describe("persistence (kv via local sqlite)", () => {
  test("apply 落 kv 整包 JSON，init 从 kv 装回内存", async () => {
    await applyPersonalization({
      style: "guiding",
      userName: "阿珍",
      customInstructions: "回答尽量精简",
    });
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    expect(row?.value).toBeDefined();
    expect(JSON.parse(row!.value)).toMatchObject({
      style: "guiding",
      userName: "阿珍",
      customInstructions: "回答尽量精简",
    });

    // 模拟重启：只清内存（apply 会落 kv，不能当重启用），再由 init 从 kv 恢复
    resetPersonalizationForTest();
    expect(getPersonalization().style).toBe("default");
    await initPersonalization();
    expect(getPersonalization().style).toBe("guiding");
    expect(getPersonalization().userName).toBe("阿珍");
    expect(personalizationPromptBlock()).toContain('The user goes by "阿珍".');
  });
});
