/**
 * 子代理定义的来源与解析（对齐 PI-Desktop agent-runtime 的 subagent-definitions）。
 *
 * 两个来源，同名时用户定义遮蔽内置：用户全局 `~/.agents/subagents/*.md` 文档，
 * 以及随 sidecar 内置的四份定义。项目目录不参与发现——仓库不能静默给用户的
 * 代理目录里塞一个 delegate。
 *
 * 内置定义以内联常量而非打包资源文件存在：数量少、必须随装随用，
 * 缺文件回退路径比常量更容易出错。
 */
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 一份子代理定义（frontmatter + 正文 prompt） */
export type SubagentDefinition = {
  name: string;
  description: string;
  /** 可用工具名（对应 sidecar 内置工具：bash/read/write/edit/glob/grep） */
  tools: string[];
  /** 轮次上限；达到后终止并按 truncated 收敛 */
  maxTurns?: number;
  /** 模型固定 "provider/modelId"；缺省继承会话当前模型 */
  model?: string;
  /** 正文 prompt（定义自身的行为说明） */
  prompt: string;
  source: "builtin" | "user";
};

export type ParsedDefinition =
  | { ok: true; definition: SubagentDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** 定义目录数量上限，防止用户目录失控撑爆 Task 工具描述 */
const MAX_CATALOG = 32;

/**
 * sidecar 内置的子代理定义。每一个都要挣得自己的 prompt-token 成本：
 * 都是把主代理本来要在全量上下文里内联完成的事拆出去——
 * 快速代码库导航、对改动的第二意见、跑测试命令、以及在独立上下文里实现多文件改动。
 */
export const BUILTIN_SUBAGENT_DOCUMENTS: readonly string[] = [
  `---
name: explorer
description: Fast codebase search and pattern matching — find files, locate implementations and answer "where is X?" / "how does Y work?". Use when answering needs a sweep over many files and you only want the conclusion.
tools: [read, glob, grep, bash]
maxTurns: 60
---

You are Explorer — a fast codebase navigation specialist.

- Prefer grep for text/regex patterns (strings, symbols, comments), glob for
  file discovery by name or extension, read for specific files.
- Fire several searches in parallel when the answer needs more than one place.
- Follow definitions and call sites; do not stop at the first hit if the
  question implies more than one place.
- Quote the few lines that answer the question and cite \`path:line\` for each.

Report in this shape:

<files>
- src/app.ts:42 — brief description of what's there
</files>
<answer>
Concise answer to the question. If you could not find it, say what you
searched and where the trail went cold — a precise dead end is more useful
than a guess.
</answer>`,
  `---
name: code-reviewer
description: Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before you commit.
tools: [read, glob, grep]
maxTurns: 50
---

Review only what the task names, and read enough surrounding code to judge it.

- Prefer defects that change behavior: wrong results, unhandled failures,
  broken invariants, races, resource leaks, missing test coverage.
- Check the code against how its callers and neighbors actually use it, not
  against a style preference.
- Say nothing about formatting, naming or structure unless it causes a defect.

Report: each finding as \`path:line\` plus one sentence on what breaks and under
what input. Order by severity. If the code is sound, say so plainly and name
the cases you checked — an empty review with no evidence is not a review.`,
  `---
name: test-runner
description: Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.
tools: [read, glob, grep, bash]
maxTurns: 40
---

Run the command the task names. Do not invent a different one, and do not fix
anything: diagnosis is the deliverable.

- Run the command once. If it fails to start (missing script, wrong directory),
  find the right invocation and say what you changed.
- For each failure, read the failing test and the code under it far enough to
  name the cause.

Report: pass/fail counts, then one entry per failure with the test name, the
assertion or error, and the \`path:line\` you believe is responsible. Keep the
raw output out of the report except for the lines that carry the failure.`,
  `---
name: fixer
description: Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.
tools: [read, glob, grep, edit, write, bash]
maxTurns: 80
---

You are Fixer — a fast, focused implementation specialist. The main agent
delegates a complete, self-contained spec; implement it. Do not re-plan and do
not research beyond what the task needs.

- Read every file you will change first; never edit or write from memory or
  from stale content.
- Keep changes minimal and scoped to the task. Do not touch unrelated code.
- You may write inside the workspace; never write outside it. Prefer the
  workspace-relative paths the main agent gave you.
- Run the relevant validation when it is clearly applicable (test, build or
  lint command the task names); otherwise report it skipped with a reason.
- Do not delegate, do not ask the user, do not search the web. If the spec
  lacks context you truly need, use grep/glob/read yourself.

Report in this shape:

<summary>
2-3 sentences: what was implemented and the outcome.
</summary>
<changes>
- path/file.ts: what changed (function or line level)
</changes>
<verification>
- Tests: [passed / failed / skipped: reason]
- Validation: [passed / failed / skipped: reason]
</verification>`,
];

/** 解析 frontmatter 的 tools 字段："[a, b]" → ["a","b"] */
function parseToolList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析一份子代理文档（frontmatter + 正文）。
 * 刻意只支持我们用到的键，格式错误进 errors，可疑但不致命的进 warnings。
 */
export function parseSubagentDefinition(
  raw: string,
  options: { source?: "builtin" | "user"; fallbackName?: string } = {},
): ParsedDefinition {
  const source = options.source ?? "user";
  const warnings: string[] = [];
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) {
    return { ok: false, errors: ["missing frontmatter block (--- ... ---)"], warnings };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return { ok: false, errors: ["frontmatter block not closed"], warnings };
  }
  const head = text.slice(4, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1).trim();

  let name = "";
  let description = "";
  let maxTurns: number | undefined;
  let model: string | undefined;
  let tools: string[] = [];
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else if (key === "tools") tools = parseToolList(value);
    else if (key === "maxTurns") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
      else warnings.push(`ignoring invalid maxTurns "${value}"`);
    } else if (key === "model") {
      if (value.includes("/")) model = value;
      else warnings.push(`ignoring model "${value}" (expected "provider/modelId")`);
    } else {
      warnings.push(`ignoring unknown frontmatter key "${key}"`);
    }
  }
  if (!name) name = options.fallbackName ?? "";
  if (!name) return { ok: false, errors: ["missing name"], warnings };
  if (!description) {
    return { ok: false, errors: [`[${name}] missing description`], warnings };
  }
  if (tools.length === 0) {
    return {
      ok: false,
      errors: [`[${name}] missing tools list (e.g. "tools: [read, grep]")`],
      warnings,
    };
  }
  if (!body) return { ok: false, errors: [`[${name}] empty prompt body`], warnings };
  return {
    ok: true,
    definition: { name, description, tools, prompt: body, source, ...(maxTurns !== undefined ? { maxTurns } : {}), ...(model ? { model } : {}) },
    warnings,
  };
}

/** 同名时先到者被后到者遮蔽；总量超上限时丢弃多余的并报告 */
export function mergeSubagentDefinitions(
  groups: readonly (readonly SubagentDefinition[])[],
): { definitions: SubagentDefinition[]; dropped: string[] } {
  const byName = new Map<string, SubagentDefinition>();
  for (const group of groups) {
    for (const definition of group) byName.set(definition.name, definition);
  }
  const all = [...byName.values()];
  const dropped = all.slice(MAX_CATALOG).map((d) => d.name);
  return { definitions: all.slice(0, MAX_CATALOG), dropped };
}

/** 内置定义（每次调用重新解析，坏常量和坏用户文档走同样的诊断路径） */
export function builtinSubagents(): { definitions: SubagentDefinition[]; diagnostics: string[] } {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
    const parsed = parseSubagentDefinition(raw, { source: "builtin" });
    if (parsed.ok) definitions.push(parsed.definition);
    else diagnostics.push(`builtin subagent invalid: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

/** 读用户全局目录 ~/.agents/subagents/*.md；目录不存在是常态不是错误 */
function loadUserSubagents(dir: string): { definitions: SubagentDefinition[]; diagnostics: string[] } {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort();
  } catch {
    return { definitions, diagnostics };
  }
  for (const name of names) {
    const filePath = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      diagnostics.push(`${filePath}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const parsed = parseSubagentDefinition(raw, { source: "user", fallbackName: name.replace(/\.md$/i, "") });
    for (const warning of parsed.warnings) diagnostics.push(`${filePath}: ${warning}`);
    if (parsed.ok) definitions.push(parsed.definition);
    else diagnostics.push(`${filePath}: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

/** 用户定义目录（工作区不参与，只看全局） */
export function subagentDefinitionDir(): string {
  return join(homedir(), ".agents", "subagents");
}

/**
 * 会话可用的定义集合：用户全局文档 + 内置。加载失败降级为诊断，
 * 一份坏文档不能赔上会话的其它 delegate，更不能赔上整个 turn。
 */
export async function loadSubagentDefinitions(): Promise<{
  definitions: SubagentDefinition[];
  diagnostics: string[];
}> {
  const builtin = builtinSubagents();
  const user = loadUserSubagents(subagentDefinitionDir());
  const merged = mergeSubagentDefinitions([builtin.definitions, user.definitions]);
  const diagnostics = [...builtin.diagnostics, ...user.diagnostics];
  if (merged.dropped.length > 0) {
    diagnostics.push(`dropped subagents past the catalog cap: ${merged.dropped.join(", ")}`);
  }
  return { definitions: merged.definitions, diagnostics };
}

/** 进程级缓存：首次会话创建时加载一次，之后复用（用户目录改动重启后生效） */
let cachedDefinitions: Promise<{
  definitions: SubagentDefinition[];
  diagnostics: string[];
}> | undefined;

export function getSubagentDefinitions() {
  cachedDefinitions ??= loadSubagentDefinitions();
  return cachedDefinitions;
}
