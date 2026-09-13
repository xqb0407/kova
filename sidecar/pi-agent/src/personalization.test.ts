import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  PROTOCOL_TEXT_MAX_CHARS,
  resetPersonalizationForTest,
  rulesFilePath,
  soulFilePath,
} from "./personalization";
import { composeModeSystemPrompt } from "./modes";
import { initLocalStorage, kvGet, kvSet, resetStorageForTest } from "./hostdb";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "./tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-personalization-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 身份文件实时读盘：钉到临时目录，避免触碰开发者真实 ~/.xulux/
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态/env/transport，避免污染后续文件
  resetPersonalizationForTest();
  resetStorageForTest();
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

describe("normalizePersonalization", () => {
  test("未知档位与非字符串字段回落默认", () => {
    expect(normalizePersonalization({ style: "nope", userName: 42 })).toEqual(
      DEFAULT_PERSONALIZATION,
    );
    expect(normalizePersonalization(null)).toEqual(DEFAULT_PERSONALIZATION);
    expect(normalizePersonalization(undefined)).toEqual(DEFAULT_PERSONALIZATION);
  });

  test("称呼截断去空白；persona/自定义指令仅防御性收口（写文件不截断，注入另有预算）", () => {
    const n = normalizePersonalization({
      style: "blunt",
      userName: "  小明  ",
      persona: "x".repeat(PROTOCOL_TEXT_MAX_CHARS + 1000),
      customInstructions: "y".repeat(PROTOCOL_TEXT_MAX_CHARS + 1000),
    });
    expect(n.style).toBe("blunt");
    expect(n.userName).toBe("小明");
    expect(n.persona.length).toBe(PROTOCOL_TEXT_MAX_CHARS);
    expect(n.customInstructions.length).toBe(PROTOCOL_TEXT_MAX_CHARS);
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

  test("外部编辑身份文件无需 apply，下一次合成即生效；注入超预算截断", async () => {
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    writeFileSync(soulFilePath(), "灵魂：安静可靠的工程师搭档\n");
    writeFileSync(rulesFilePath(), "始终用中文回复\n");
    expect(getPersonalization().persona).toContain("灵魂：安静可靠的工程师搭档");
    const prompt = composeModeSystemPrompt("agent", "/tmp/ws");
    expect(prompt).toContain("Persona: 灵魂：安静可靠的工程师搭档");
    expect(prompt).toContain("always apply): 始终用中文回复");

    writeFileSync(rulesFilePath(), "y".repeat(9000));
    const block = personalizationPromptBlock();
    const injected = block.split("always apply): ")[1] ?? "";
    expect(injected.length).toBe(8000);

    rmSync(soulFilePath(), { force: true });
    rmSync(rulesFilePath(), { force: true });
    expect(personalizationPromptBlock()).not.toContain("Persona:");
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

describe("persistence (身份文件 + 结构化 kv)", () => {
  test("apply 写身份文件，kv 只落结构化字段；init 从 kv + 文件恢复", async () => {
    rmSync(soulFilePath(), { force: true });
    rmSync(rulesFilePath(), { force: true });
    await applyPersonalization({
      style: "guiding",
      userName: "阿珍",
      customInstructions: "回答尽量精简",
    });
    expect(readFileSync(soulFilePath(), "utf8")).toBe("");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("回答尽量精简");
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    expect(JSON.parse(row!.value)).toEqual({
      style: "guiding",
      userName: "阿珍",
      assistantName: "",
    });

    // 模拟重启：只清内存（apply 会落盘落 kv，不能当重启用），再由 init 恢复
    resetPersonalizationForTest();
    expect(getPersonalization().style).toBe("default");
    await initPersonalization();
    expect(getPersonalization().style).toBe("guiding");
    expect(getPersonalization().userName).toBe("阿珍");
    expect(getPersonalization().customInstructions).toBe("回答尽量精简");
    expect(personalizationPromptBlock()).toContain('The user goes by "阿珍".');
    expect(personalizationPromptBlock()).toContain("always apply): 回答尽量精简");
  });
});

describe("legacy kv migration（旧版整包 → 身份文件）", () => {
  test("旧版 kv 含 persona/自定义指令：启动迁移到文件，kv 收敛为结构化字段", async () => {
    rmSync(soulFilePath(), { force: true });
    rmSync(rulesFilePath(), { force: true });
    await kvSet(
      PERSONALIZATION_KV_KEY,
      JSON.stringify({
        style: "friendly",
        userName: "老王",
        assistantName: "Buddy",
        persona: "旧版人设",
        customInstructions: "旧版指令",
      }),
    );
    resetPersonalizationForTest();
    await initPersonalization();
    expect(readFileSync(soulFilePath(), "utf8")).toBe("旧版人设");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("旧版指令");
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    expect(JSON.parse(row!.value)).toEqual({
      style: "friendly",
      userName: "老王",
      assistantName: "Buddy",
    });
    expect(getPersonalization().persona).toBe("旧版人设");
    expect(getPersonalization().assistantName).toBe("Buddy");
  });

  test("身份文件已存在时文件优先，不覆盖外部内容", async () => {
    writeFileSync(soulFilePath(), "文件里的人设");
    await kvSet(
      PERSONALIZATION_KV_KEY,
      JSON.stringify({ style: "default", persona: "kv 里的人设" }),
    );
    resetPersonalizationForTest();
    await initPersonalization();
    expect(readFileSync(soulFilePath(), "utf8")).toBe("文件里的人设");
    expect(getPersonalization().persona).toBe("文件里的人设");
  });
});
