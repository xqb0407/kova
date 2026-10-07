/**
 * 子智能体编辑器的纯逻辑：表单草稿 ↔ 定义草稿 ↔ YAML。
 *
 * 从组件里抽出来单独成模块，是为了能单测——这里曾经出过一次真实事故：
 * formToYaml 只序列化五个键，新增的能力维度（skills/mcp/knowledge/memory）
 * 在做「复制为系统级」时被静默丢弃，用户点了复制，能力全没了，且无任何报错。
 * 那类缺陷只有测试能挡住，靠渲染截图看不出来（被丢的字段本来就不显示）。
 *
 * 本模块不引 React、不碰 DOM：纯函数进出，可在 node 下直接测。
 */
import type { PiKnowledgeSource, SubagentDraft, SubagentEntry } from "./subagents";

/** 编辑目标：新建 / 编辑既有 / 复制为可编辑层 */
export type EditorTarget =
  | { mode: "create"; scope: "system" | "workspace" }
  | { mode: "edit"; entry: SubagentEntry }
  | { mode: "copy"; entry: SubagentEntry };

export type EditorScope = "system" | "workspace";

/** 编辑器落盘的作用域：create 用指定的，edit/copy 沿定义自身（非工作区即系统） */
export function editorScope(target: EditorTarget): EditorScope {
  if (target.mode === "create") return target.scope;
  return target.entry.scope === "workspace" ? "workspace" : "system";
}

/** 记忆档位。缺省 none；独立于设置 → 记忆的全局开关 */
export const MEMORY_OPTIONS: Array<{
  value: NonNullable<SubagentDraft["memory"]>;
  label: string;
  hint: string;
}> = [
  { value: "none", label: "无", hint: "不注入、不给工具。每次委派都是冷启动。" },
  {
    value: "private",
    label: "私有",
    hint: "存在本工作区的专属目录里，跨委派累积，只有它自己看得见。",
  },
  {
    value: "shared",
    label: "共享",
    hint: "与主代理的工作区记忆同一目录。它写的内容会出现在你后续的对话里。",
  },
];

/** 表单草稿（maxTurns 用字符串承载，空 = 不设置） */
export type FormDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns: string;
  model: string;
  prompt: string;
  skills: string[];
  mcpServers: string[];
  knowledge: PiKnowledgeSource[];
  memory: NonNullable<SubagentDraft["memory"]>;
};

export const EMPTY_FORM: FormDraft = {
  name: "",
  description: "",
  tools: ["read", "glob", "grep"],
  maxTurns: "",
  model: "",
  prompt: "",
  skills: [],
  mcpServers: [],
  knowledge: [],
  memory: "none",
};

/** 定义条目 → 表单草稿（能力维度未声明时回落成空，控件统一按空值渲染） */
export function entryToForm(entry: SubagentEntry): FormDraft {
  return {
    name: entry.name,
    description: entry.description,
    tools: entry.tools,
    maxTurns: entry.maxTurns !== undefined ? String(entry.maxTurns) : "",
    model: entry.model ?? "",
    prompt: entry.prompt,
    skills: entry.skills ?? [],
    mcpServers: entry.mcpServers ?? [],
    knowledge: entry.knowledge ?? [],
    memory: entry.memory ?? "none",
  };
}

/**
 * 表单草稿 → 定义草稿。
 * 空值一律不落草稿：sidecar 据此判定"该维度未声明"；落了空数组会让
 * YAML 视图糊上一层空壳，也让"复制内置"带上无意义的空字段。
 */
export function formToDraft(form: FormDraft): SubagentDraft {
  const maxTurns = Number(form.maxTurns);
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    tools: form.tools,
    prompt: form.prompt,
    ...(form.maxTurns.trim() && Number.isFinite(maxTurns) && maxTurns > 0
      ? { maxTurns: Math.floor(maxTurns) }
      : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.skills.length ? { skills: form.skills } : {}),
    ...(form.mcpServers.length ? { mcpServers: form.mcpServers } : {}),
    ...(form.knowledge.length ? { knowledge: form.knowledge } : {}),
    ...(form.memory !== "none" ? { memory: form.memory } : {}),
  };
}

/**
 * 表单草稿 → YAML 文本（新建/复制时的初始展示；合法性与回读以 sidecar 解析为准）。
 * 五个维度必须全部写出——漏掉任一个就是上面注释里那起事故。
 */
export function formToYaml(form: FormDraft): string {
  const lines = [
    "# Kova subagent definition — managed via Settings → Subagents",
    `name: ${JSON.stringify(form.name.trim())}`,
    `description: ${JSON.stringify(form.description.trim())}`,
    `tools: [${form.tools.join(", ")}]`,
  ];
  const maxTurns = Number(form.maxTurns);
  if (form.maxTurns.trim() && Number.isFinite(maxTurns) && maxTurns > 0) {
    lines.push(`maxTurns: ${Math.floor(maxTurns)}`);
  }
  if (form.model.trim()) lines.push(`model: ${form.model.trim()}`);
  if (form.skills.length) lines.push(`skills: [${form.skills.join(", ")}]`);
  if (form.mcpServers.length) {
    lines.push("mcp:");
    lines.push(`  servers: [${form.mcpServers.join(", ")}]`);
  }
  for (const k of form.knowledge) {
    lines.push("knowledge:");
    lines.push(`  - name: ${JSON.stringify(k.name)}`);
    lines.push(`    path: ${JSON.stringify(k.path)}`);
  }
  if (form.memory !== "none") lines.push(`memory: ${form.memory}`);
  lines.push("prompt: |");
  const body = form.prompt.endsWith("\n") ? form.prompt : `${form.prompt}\n`;
  for (const line of body.split("\n")) lines.push(line ? `  ${line}` : "");
  return lines.join("\n");
}
