/**
 * 个性化管理工具（personalization_get/update）的行为测试：
 * 执行体走真实 applyPersonalization（tmp 身份目录 + 本地 SQLite kv），
 * onUpdated 用计数器注入，验证字段级合并、append 语义与审批名单。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  applyPersonalization,
  DEFAULT_PERSONALIZATION,
  getPersonalization,
  resetPersonalizationForTest,
  rulesFilePath,
  soulFilePath,
} from "../../src/agent/personalization";
import {
  buildPersonalizationTools,
  PERSONALIZATION_TOOL_NAMES,
} from "../../src/agent/personalization-tool";
import { APPROVAL_REQUIRED_TOOLS } from "../../src/agent/modes";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-personalization-tool-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
  // 身份文件/ kv 全部落 tmp，绝不碰真实 ~/.kova
  process.env.PI_IDENTITY_DIR = join(tmp, "identity");
});

beforeEach(async () => {
  // 每个用例从干净默认值开始（apply 会建目录 + 落空身份文件 + 清结构化 kv）
  resetPersonalizationForTest();
  await applyPersonalization(DEFAULT_PERSONALIZATION);
});

afterAll(() => {
  resetPersonalizationForTest();
  resetStorageForTest();
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((x) => x.name === name);
  if (!tool) throw new Error(`tool not built: ${name}`);
  return tool;
}

async function invoke(
  tools: AgentTool[],
  name: string,
  params: Record<string, unknown> = {},
): Promise<{ text: string; details?: unknown }> {
  const result = (await toolByName(tools, name).execute(
    "tc-1",
    params as never,
  )) as {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  return {
    text: result.content.map((c) => c.text ?? "").join("\n"),
    details: result.details,
  };
}

function build(onUpdated: () => void = () => {}) {
  return buildPersonalizationTools({ onUpdated });
}

describe("personalization_get", () => {
  test("返回当前设置与身份文件路径", async () => {
    const res = await invoke(build(), PERSONALIZATION_TOOL_NAMES.get);
    expect(res.text).toContain("回复风格：default");
    expect(res.text).toContain("用户称呼：（未设置）");
    expect(res.text).toContain("人设（soul.md，0 字符）");
    expect(res.text).toContain("自定义指令（rules.md，0 字符）");
    expect(res.text).toContain(`soul=${soulFilePath()}`);
    expect(res.text).toContain(`rules=${rulesFilePath()}`);
  });
});

describe("personalization_update", () => {
  test("改称呼 + append 规则：字段落库、身份文件追加、onUpdated 触发", async () => {
    await applyPersonalization({
      ...DEFAULT_PERSONALIZATION,
      customInstructions: "原有规则",
    });
    let updates = 0;
    const res = await invoke(build(() => updates++), PERSONALIZATION_TOOL_NAMES.update, {
      userName: "小明",
      assistantName: "Kova",
      customInstructions: { mode: "append", text: "新增规则" },
    });

    expect(res.text).toContain("已更新");
    expect(res.text).toContain("userName");
    expect(res.text).toContain("customInstructions");
    expect(getPersonalization().userName).toBe("小明");
    expect(getPersonalization().assistantName).toBe("Kova");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("原有规则\n\n新增规则");
    expect(readFileSync(soulFilePath(), "utf8")).toBe("");
    expect(updates).toBe(1);
  });

  test("只改称呼：不覆盖外部写入的 rules.md / soul.md", async () => {
    writeFileSync(rulesFilePath(), "外部规则");
    writeFileSync(soulFilePath(), "外部人设");
    const res = await invoke(build(), PERSONALIZATION_TOOL_NAMES.update, {
      userName: "只改名字",
    });

    expect(res.text).toContain("已更新：userName");
    expect(getPersonalization().userName).toBe("只改名字");
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("外部规则");
    expect(readFileSync(soulFilePath(), "utf8")).toBe("外部人设");
  });

  test("replace 模式整体替换；空串清空", async () => {
    await applyPersonalization({
      ...DEFAULT_PERSONALIZATION,
      customInstructions: "旧规则",
    });
    const tools = build();
    await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {
      customInstructions: { mode: "replace", text: "新规则" },
    });
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("新规则");

    await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {
      customInstructions: { mode: "replace", text: "" },
    });
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("");
  });

  test("没有提供字段 / append 空文本都返回错误，不落盘", async () => {
    const tools = build();
    const empty = await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {});
    expect(empty.text).toContain("没有提供要修改的字段");
    expect((empty.details as { error?: string }).error).toContain(
      "没有提供要修改的字段",
    );

    const blankAppend = await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {
      customInstructions: { mode: "append", text: "   " },
    });
    expect(blankAppend.text).toContain("append 模式下不能为空");
  });

  test("非法 mode：不把拼写错误降级成整体替换", async () => {
    const res = await invoke(build(), PERSONALIZATION_TOOL_NAMES.update, {
      customInstructions: { mode: "Append", text: "x" },
    });
    expect(res.text).toContain('mode 只能是 "replace" 或 "append"');
    expect(readFileSync(rulesFilePath(), "utf8")).toBe("");
  });

  test("非法 style / 重复 style id 返回错误，不写文件", async () => {
    const tools = build();
    const missing = await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {
      style: "custom:missing",
    });
    expect(missing.text).toContain("自定义风格不存在");
    expect(getPersonalization().style).toBe("default");

    const duplicate = await invoke(tools, PERSONALIZATION_TOOL_NAMES.update, {
      styles: [
        { id: "dup", name: "A", prompt: "a" },
        { id: "dup", name: "B", prompt: "b" },
      ],
    });
    expect(duplicate.text).toContain("id 重复");
    expect(getPersonalization().styles).toEqual([]);
  });

  test("styleOverrides 非法内置档位被拒绝", async () => {
    const res = await invoke(build(), PERSONALIZATION_TOOL_NAMES.update, {
      styleOverrides: [{ id: "nope", hidden: true }],
    });
    expect(res.text).toContain("必须是内置档位");
    expect(getPersonalization().styleOverrides).toEqual([]);
  });

  test("审批名单：update 需要审批，get 不需要", () => {
    expect(
      APPROVAL_REQUIRED_TOOLS.has(PERSONALIZATION_TOOL_NAMES.update),
    ).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has(PERSONALIZATION_TOOL_NAMES.get)).toBe(
      false,
    );
  });
});
