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

/* ---------------------------------------------------------------------------
 * 知识源路径：选择器结果 → 工作区相对 glob
 *
 * 让人手打 `./docs/**\/*.md` 是没道理的——glob 语法不该是使用知识库的前置知识。
 * 浏览按钮选完目录，这里负责把绝对路径收敛成 workspace 相对 glob。
 * 抽成纯函数是因为它有真实的分支（工作区内外、分隔符、尾斜杠），
 * 而这些分支在 UI 里没法可靠地手测。
 * ------------------------------------------------------------------------- */

/** 一个知识源默认收哪些文件：目录下全部（检索侧会跳过二进制与超大文件） */
export const KNOWLEDGE_GLOB_SUFFIX = "/**/*";

export type RelGlobResult =
  | { ok: true; glob: string }
  | { ok: false; reason: "outside" | "invalid" };

/**
 * 绝对目录 → 工作区相对 glob。
 * 不在工作区内就拒绝：检索侧按 `path.join(cwd, rel)` 解析，绝对路径会被拼成
 * `cwd + 绝对路径` 这种无意义的串，静默搜不到任何东西。
 */
export function dirToWorkspaceGlob(dir: string, cwd: string): RelGlobResult {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  const w = norm(cwd);
  if (!d || !w) return { ok: false, reason: "invalid" };
  // 大小写不敏感比较：macOS/Windows 默认文件系统大小写不敏感，
  // 用户从选择器拿到的路径大小写与工作区记录未必一致
  const dl = d.toLowerCase();
  const wl = w.toLowerCase();
  if (dl === wl) return { ok: true, glob: `./${KNOWLEDGE_GLOB_SUFFIX.slice(1)}` };
  if (!dl.startsWith(`${wl}/`)) return { ok: false, reason: "outside" };
  const rel = d.slice(w.length + 1);
  return { ok: true, glob: `./${rel}${KNOWLEDGE_GLOB_SUFFIX}` };
}
