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
  type PersonalizationStyleOverride,
  resetPersonalizationForTest,
  rulesFilePath,
  soulFilePath,
} from "../../src/agent/personalization";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { initLocalStorage, kvGet, kvSet, resetStorageForTest } from "../../src/storage/hostdb";
import { SYSTEM_PROMPT_CORE, workspacePromptLine } from "../../src/tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-personalization-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 身份文件实时读盘：钉到临时目录，避免触碰开发者真实 ~/.kova/
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

  test("自定义风格净化：非法条目丢弃、id 去重、空名回落占位、超长截断、条数上限", () => {
    const capped = normalizePersonalization({
      styles: Array.from({ length: 25 }, (_, i) => ({
        id: `s${i}`,
        name: `风格${i}`,
        prompt: `描述${i}`,
      })),
    });
    expect(capped.styles.length).toBe(20);
    expect(capped.style).toBe("default");

    const n = normalizePersonalization({
      style: "custom:b",
      styles: [
        { id: "a", name: "  文艺  ", prompt: "p1" },
        { id: "a", name: "重复", prompt: "p2" },
        { id: "  ", name: "空 id", prompt: "p3" },
        { name: "缺 id", prompt: "p4" },
        { id: "b", prompt: "缺名字" },
        null,
        { id: "c", name: "x".repeat(40), prompt: "y".repeat(5000) },
      ],
    });
    expect(n.styles.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(n.styles[0]!.name).toBe("文艺");
    expect(n.styles[1]!.name).toBe("未命名风格");
    expect(n.styles[2]!.name.length).toBe(24);
    expect(n.styles[2]!.prompt.length).toBe(4_000);
    expect(n.style).toBe("custom:b");
  });

  test("style 引用悬空（条目不存在/列表缺失）回落 default；旧版 kv 无 styles 兼容", () => {
    expect(
      normalizePersonalization({
        style: "custom:missing",
        styles: [{ id: "a", name: "n", prompt: "p" }],
      }).style,
    ).toBe("default");
    expect(normalizePersonalization({ style: "custom:a" }).style).toBe("default");
    expect(normalizePersonalization({ style: "blunt", userName: "u" }).styles).toEqual([]);
    expect(normalizePersonalization({ style: "blunt" }).styleOverrides).toEqual([]);
  });

  test("内置覆盖记录净化：非内置 id 丢弃、去重保留首条、空记录丢弃、字段收口", () => {
    const n = normalizePersonalization({
      styleOverrides: [
        { id: "blunt", name: "  毒舌  ", prompt: " 说人话 ", hidden: false },
        { id: "blunt", name: "重复", prompt: "x", hidden: true }, // 去重：首条生效
        { id: "nope", name: "未知档", prompt: "y", hidden: true }, // 非内置档丢弃
        { id: "custom:abc", hidden: true }, // 自定义 id 不算内置档
        { id: "friendly", name: "", prompt: "", hidden: false }, // 三空记录丢弃
        { id: "guiding", name: "n".repeat(40), prompt: "p".repeat(5000), hidden: "yes" },
        null,
      ],
    });
    expect(n.styleOverrides).toEqual([
      { id: "blunt", name: "毒舌", prompt: "说人话", hidden: false },
      { id: "guiding", name: "n".repeat(24), prompt: "p".repeat(4000), hidden: false }, // 非 true 一律 false
    ]);
  });
});

describe("personalizationPromptBlock", () => {
  test("全默认时为空串，默认提示词字节级不变", async () => {
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    expect(personalizationPromptBlock()).toBe("");
    const baseline = composeModeSystemPrompt("agent", "/tmp/ws", "code");
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

    const prompt = composeModeSystemPrompt("agent", "/tmp/ws", "code");
    expect(prompt).toContain(block);
    const cwdIndex = prompt.indexOf(workspacePromptLine("/tmp/ws"));
    expect(prompt.startsWith(SYSTEM_PROMPT_CORE)).toBe(true);
    expect(prompt.indexOf("Reply style - direct")).toBeLessThan(cwdIndex);
  });

  test("plan 模式同样携带个性化段", () => {
    const prompt = composeModeSystemPrompt("plan", "/tmp/ws", "code");
    expect(prompt).toContain("Reply style - direct");
    expect(prompt).toContain("Plan mode");
  });

  test("外部编辑身份文件无需 apply，下一次合成即生效；注入超预算截断", async () => {
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    writeFileSync(soulFilePath(), "灵魂：安静可靠的工程师搭档\n");
    writeFileSync(rulesFilePath(), "始终用中文回复\n");
    expect(getPersonalization().persona).toContain("灵魂：安静可靠的工程师搭档");
    const prompt = composeModeSystemPrompt("agent", "/tmp/ws", "code");
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
    const baseline = composeModeSystemPrompt("agent", "/tmp/ws", "code");
    await applyPersonalization({ style: "friendly" });
    expect(composeModeSystemPrompt("agent", "/tmp/ws", "code")).not.toBe(baseline);
    expect(composeModeSystemPrompt("agent", "/tmp/ws", "code")).toContain(
      "Reply style - warm and approachable",
    );
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    expect(composeModeSystemPrompt("agent", "/tmp/ws", "code")).toBe(baseline);
  });

  test("内置档覆盖注入：prompt 原文注入不叠前缀；隐藏/空 prompt 仍走内置文案", async () => {
    await applyPersonalization({
      style: "blunt",
      styleOverrides: [
        { id: "blunt", name: "毒舌", prompt: "别绕弯子，先挑毛病再给方案。", hidden: false },
        { id: "friendly", name: "", prompt: "", hidden: true }, // 仅隐藏：不改变注入
      ],
    });
    const block = personalizationPromptBlock();
    expect(block).toBe("别绕弯子，先挑毛病再给方案。"); // 无 "Reply style - …" 双重前缀

    // 隐藏的档位仍可直接选中生效（可用性由前端网格控制，注入端只认覆盖内容）
    await applyPersonalization({
      style: "friendly",
      styleOverrides: [{ id: "friendly", name: "", prompt: "", hidden: true }],
    });
    expect(personalizationPromptBlock()).toContain("Reply style - warm and approachable");

    // 恢复默认（删记录）后回到基线
    await applyPersonalization(DEFAULT_PERSONALIZATION);
    expect(personalizationPromptBlock()).toBe("");
  });

  test("自定义风格注入：prompt 原样带名称上下文；空白 prompt 不注入", async () => {
    await applyPersonalization({
      style: "custom:s1",
      styles: [
        { id: "s1", name: "文艺", prompt: "文风偏文学，善用比喻" },
        { id: "s2", name: "空描述", prompt: "   " },
      ],
    });
    const block = personalizationPromptBlock();
    expect(block).toContain("Reply style - 文艺: 文风偏文学，善用比喻");
    expect(composeModeSystemPrompt("agent", "/tmp/ws", "code")).toContain(block);

    // 选中但描述为空的条目：风格段整体不注入（全默认其余字段 → 空串）
    await applyPersonalization({
      style: "custom:s2",
      styles: [{ id: "s2", name: "空描述", prompt: "   " }],
    });
    expect(personalizationPromptBlock()).toBe("");
    await applyPersonalization(DEFAULT_PERSONALIZATION);
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
      styles: [],
      styleOverrides: [],
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

  test("自定义风格随结构化字段落 kv；init 恢复后档位与列表都在", async () => {
    rmSync(soulFilePath(), { force: true });
    rmSync(rulesFilePath(), { force: true });
    await applyPersonalization({
      style: "custom:s9",
      styles: [{ id: "s9", name: "赛博", prompt: "术语与冷幽默" }],
    });
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    expect(JSON.parse(row!.value)).toEqual({
      style: "custom:s9",
      userName: "",
      assistantName: "",
      styles: [{ id: "s9", name: "赛博", prompt: "术语与冷幽默" }],
      styleOverrides: [],
    });

    // 模拟重启：清内存后由 init 从 kv 恢复
    resetPersonalizationForTest();
    expect(getPersonalization().style).toBe("default");
    await initPersonalization();
    expect(getPersonalization().style).toBe("custom:s9");
    expect(getPersonalization().styles).toEqual([
      { id: "s9", name: "赛博", prompt: "术语与冷幽默" },
    ]);
    expect(personalizationPromptBlock()).toContain("Reply style - 赛博: 术语与冷幽默");

    // 复位：落回默认整包，避免影响后续 describe
    await applyPersonalization(DEFAULT_PERSONALIZATION);
  });

  test("内置覆盖记录随 kv round-trip；旧版 kv（无 styleOverrides）启动兼容", async () => {
    // 标注类型：不标注则 id 字面量被放宽成 string，与 toEqual/applyPersonalization 的
    // PersonalizationBuiltinStyle 形参不兼容
    const overrides: PersonalizationStyleOverride[] = [
      { id: "professional", name: "严肃", prompt: "禁止玩笑与表情。", hidden: false },
    ];
    await applyPersonalization({ style: "professional", styleOverrides: overrides });
    resetPersonalizationForTest();
    await initPersonalization();
    expect(getPersonalization().styleOverrides).toEqual(overrides);
    expect(personalizationPromptBlock()).toBe("禁止玩笑与表情。");

    // 旧版 kv：缺 styleOverrides 字段 → 空列表，内置文案原样
    await kvSet(PERSONALIZATION_KV_KEY, JSON.stringify({ style: "professional", userName: "" }));
    resetPersonalizationForTest();
    await initPersonalization();
    expect(getPersonalization().styleOverrides).toEqual([]);
    expect(personalizationPromptBlock()).toContain("Reply style - professional");

    await applyPersonalization(DEFAULT_PERSONALIZATION);
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
    // 旧版 kv 无 styles/styleOverrides：迁移后收敛为结构化字段 + 空列表
    expect(JSON.parse(row!.value)).toEqual({
      style: "friendly",
      userName: "老王",
      assistantName: "Buddy",
      styles: [],
      styleOverrides: [],
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
