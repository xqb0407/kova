/**
 * 子智能体编辑器纯逻辑测试。
 *
 * 重点是守卫一类真实发生过的事故：formToYaml / formToDraft 静默丢字段。
 * 那类缺陷渲染截图看不出来（被丢的字段本来就不显示），只有断言能挡。
 */
import { describe, expect, test } from "bun:test";
import {
  editorScope,
  EMPTY_FORM,
  entryToForm,
  formToDraft,
  formToYaml,
  type FormDraft,
} from "./editor-form";
import type { SubagentEntry } from "./subagents";

const entry = (over: Partial<SubagentEntry> = {}): SubagentEntry => ({
  name: "cs",
  description: "客服",
  tools: ["read", "grep"],
  prompt: "你是售后",
  scope: "system",
  enabled: true,
  editable: true,
  ...over,
});

const fullForm = (): FormDraft => ({
  name: "cs",
  description: "客服",
  tools: ["read", "WebFetch"],
  maxTurns: "60",
  model: "anthropic/claude-sonnet-4",
  prompt: "你是售后",
  skills: ["refund-policy", "tone-guide"],
  mcpServers: ["crm", "notion"],
  knowledge: [
    { name: "产品手册", type: "files", path: "./docs/**/*.md" },
    { name: "政策库", type: "mcp", server: "notion", tool: "notion__search" },
  ],
  memory: "private",
});

describe("entryToForm / formToDraft 往返", () => {
  test("五维度全量往返无损", () => {
    const form = fullForm();
    const draft = formToDraft(form);
    expect(draft.skills).toEqual(["refund-policy", "tone-guide"]);
    expect(draft.mcpServers).toEqual(["crm", "notion"]);
    expect(draft.knowledge).toEqual(form.knowledge);
    expect(draft.memory).toBe("private");
    expect(draft.tools).toEqual(["read", "WebFetch"]);
    expect(draft.maxTurns).toBe(60);
    expect(draft.model).toBe("anthropic/claude-sonnet-4");
  });

  test("entryToForm 把未声明的维度回落成空（控件统一按空值渲染）", () => {
    const form = entryToForm(entry());
    expect(form.skills).toEqual([]);
    expect(form.mcpServers).toEqual([]);
    expect(form.knowledge).toEqual([]);
    expect(form.memory).toBe("none");
    expect(form.maxTurns).toBe("");
    expect(form.model).toBe("");
  });

  test("entryToForm → formToDraft 不凭空造出维度", () => {
    // 未声明的定义编辑后保存，不该冒出一堆空字段（YAML 视图会因此变脏）
    const draft = formToDraft(entryToForm(entry()));
    expect(draft.skills).toBeUndefined();
    expect(draft.mcpServers).toBeUndefined();
    expect(draft.knowledge).toBeUndefined();
    expect(draft.memory).toBeUndefined();
  });

  test("WebFetch 大小写原样保留（后端按规范注册名匹配）", () => {
    const draft = formToDraft({ ...EMPTY_FORM, name: "x", tools: ["read", "WebFetch"] });
    expect(draft.tools).toContain("WebFetch");
  });
});

describe("formToYaml 不丢字段", () => {
  test("五个维度全部出现在 YAML 里", () => {
    const yaml = formToYaml(fullForm());
    expect(yaml).toContain("skills: [refund-policy, tone-guide]");
    expect(yaml).toContain("mcp:");
    expect(yaml).toContain("servers: [crm, notion]");
    expect(yaml).toContain("knowledge:");
    expect(yaml).toContain('name: "产品手册"');
    expect(yaml).toContain("type: files");
    expect(yaml).toContain("type: mcp");
    expect(yaml).toContain('server: "notion"');
    expect(yaml).toContain('tool: "notion__search"');
    expect(yaml).toContain("memory: private");
  });

  test("空维度不写出（不给未声明的维度留空壳）", () => {
    const yaml = formToYaml({ ...EMPTY_FORM, name: "x", prompt: "p" });
    expect(yaml).not.toContain("skills:");
    expect(yaml).not.toContain("mcp:");
    expect(yaml).not.toContain("knowledge:");
    expect(yaml).not.toContain("memory:");
  });

  test("memory: none 不写 memory 行", () => {
    const yaml = formToYaml({ ...fullForm(), memory: "none" });
    expect(yaml).not.toContain("memory:");
  });

  test("prompt 正文缩进正确且以换行结尾", () => {
    const yaml = formToYaml({ ...EMPTY_FORM, name: "x", prompt: "第一行\n第二行" });
    expect(yaml).toContain("prompt: |");
    expect(yaml).toContain("  第一行");
    expect(yaml).toContain("  第二行");
    expect(yaml.endsWith("\n")).toBe(true);
  });

  test("name 含特殊字符时被 JSON 转义（不破 YAML 结构）", () => {
    const yaml = formToYaml({ ...EMPTY_FORM, name: 'a "quoted" name', prompt: "p" });
    expect(yaml).toContain('name: "a \\"quoted\\" name"');
  });

  test("maxTurns 非数字/零/负数都不写出", () => {
    for (const bad of ["", "abc", "0", "-3"]) {
      const yaml = formToYaml({ ...EMPTY_FORM, name: "x", maxTurns: bad, prompt: "p" });
      expect(yaml).not.toContain("maxTurns");
    }
  });
});

describe("editorScope", () => {
  test("create 用指定作用域", () => {
    expect(editorScope({ mode: "create", scope: "system" })).toBe("system");
    expect(editorScope({ mode: "create", scope: "workspace" })).toBe("workspace");
  });

  test("edit/copy 沿定义自身；内置与插件落到系统级", () => {
    expect(editorScope({ mode: "edit", entry: entry({ scope: "workspace" }) })).toBe("workspace");
    expect(editorScope({ mode: "edit", entry: entry({ scope: "builtin" }) })).toBe("system");
    expect(editorScope({ mode: "copy", entry: entry({ scope: "plugin" }) })).toBe("system");
  });
});
