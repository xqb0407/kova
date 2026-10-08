/**
 * 子代理定义的来源、解析与运行时状态（设置 → 子智能体）。
 *
 * 三层发现，同名时后层遮蔽前层（工作区 > 系统 > 内置）：
 * - 内置：内联常量，设置页只读查看，只可启用/关闭，永不被写。
 * - 系统：应用数据目录 `<app_data>/subagents/*.yml`（生产由 Tauri 注入
 *   PI_SUBAGENTS_DIR；兜底 PI_DB_PATH 同级 subagents/，再兜底 ~/.kova/subagents）。
 * - 工作区：`<cwd>/.kova/subagents/*.yml`，与 .kova/plans 同族。
 *
 * 定义文件是纯 YAML（yaml 包解析/序列化）。启用开关与模型覆盖都是"本机的运行时
 * 决定"，不写进定义文件（工作区文件在 git 里，内置更是永不写）：整包存 SQLite kv
 * （key = STATE_KV_KEY），与个性化设置同款链路。模型覆盖因此成为只读层（内置/插件）
 * 也能在设置页选模型的落点——生效优先级：Task 参数 > kv 覆盖 > 定义自带 > 会话模型。
 *
 * 动态化：每次加载对目录做签名（文件名+mtime+大小），签名没变用缓存——
 * 设置页保存/删除后缓存自然失效，活动会话由 protocol 层的 reloadSubagents
 * 重排工具组，下一个 turn 即生效，无需重启。
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { activePlugins, resolvePluginComponent } from "../plugins/plugins";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export type SubagentScope = "builtin" | "system" | "workspace" | "plugin";

/**
 * 记忆档位：
 * - none（缺省）：无记忆——不注入、不给工具。每次委派冷启动。
 * - private：私有命名空间 <cwd>/.kova/agent-memory/<name>/，跨委派累积，
 *   只本子代理可见。与用户主记忆结构上隔离，子代理写不进 ~/.kova/memory。
 * - shared：与主代理共享工作区作用域记忆 <cwd>/.kova/memory/。
 *
 * private 是推荐档：子代理生成的内容（可能是幻觉）不该进主代理的提示词。
 */
export type SubagentMemoryMode = "none" | "private" | "shared";

/**
 * 声明式知识源：就是一份文档（或一组文档）。
 *
 * 只有文档一种形态。外部系统（飞书表格、Notion、数据库）不走这里——
 * 它们由 mcp.servers 授予，agent 直接调那些服务器的工具。把 MCP 也做进
 * 知识源等于同一件事说两遍，还多一套要维护的类型分支。
 *
 * 正文永不预加载：提示词只拿到一行目录，kb_search 关键词检索后按需 read。
 */
export type KnowledgeSource = {
  name: string;
  /** 工作区相对 glob，如 ./docs/**\/*.md */
  path: string;
};

/** 一份子代理定义（解析产物与运行时共用同一形状） */
export type SubagentDefinition = {
  name: string;
  description: string;
  /** 可用工具名（对应 GRANTABLE_TOOLS；存规范注册名） */
  tools: string[];
  /** 轮次上限；达到后终止并按 truncated 收敛 */
  maxTurns?: number;
  /** 模型固定 "provider/modelId"；缺省继承会话当前模型（只读层由 kv 覆盖注入） */
  model?: string;
  /** 正文 prompt（定义自身的行为说明） */
  prompt: string;
  scope: SubagentScope;
  /** 技能白名单（按名）：未列出的技能对子代理不可见 */
  skills?: string[];
  /** MCP 服务器白名单：未列出的服务器对子代理不可达 */
  mcpServers?: string[];
  /** 声明式知识源，按需拉取 */
  knowledge?: KnowledgeSource[];
  /** 记忆档位；缺省即 none */
  memory?: SubagentMemoryMode;
  /** scope = "plugin" 时的来源插件身份（开关与模型覆盖都靠它命名空间） */
  pluginId?: string;
  /** YAML 原文（设置页"YAML 视图"与保存回读用；内置由常量序列化而来） */
  raw?: string;
  /** 定义文件路径（内置为 undefined） */
  path?: string;
  /** 启用/禁用开关的身份键（见 stateKey） */
  stateKey: string;
};

/** 设置页展示条目：定义 + 生效状态 */
export type SubagentEntry = SubagentDefinition & {
  /** 当前是否挂载（内置恒可关；工作区未信任时为 false） */
  enabled: boolean;
  /** 内置只读：设置页不允许编辑/删除，只能开关与复制 */
  editable: boolean;
};

export type ParsedDefinition =
  | { ok: true; definition: SubagentDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** 每层目录的定义数量上限，防止目录失控撑爆 Task 工具描述 */
const MAX_PER_LAYER = 32;

/**
 * 可授予工具目录（"允许表的允许表"）。YAML 只能命名这里的工具，
 * 运行时还需该工具确实存在于会话 baseTools，两条件都满足才授予。
 *
 * 刻意缺席的工具：
 * - Question：子代理问不了用户（composeSubagentSystemPrompt 已声明此事）
 * - mcp / memory_*：只能经 mcp.servers / memory 维度挂载，
 *   按裸工具名声明会绕过作用域与隔离，故不在此表
 * - browser / screenshot / imagegen / open_file / open_panel：主代理交互面，
 *   子代理无 UI 承载
 * - subagents_* / skills_* / plugins_* / design_themes_* / scheduler_*：
 *   管理面，已在 resolve.ts buildAgentExtensions 明确排除出 baseTools
 *
 * 注册名大小写不一致（WebFetch 是 CamelCase，use_skill 是 snake_case），
 * 声明侧大小写不敏感，落库一律为规范注册名。
 */
export const GRANTABLE_TOOLS: readonly string[] = [
  // 内置编码工具（tools.ts）
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "task_output",
  "task_stop",
  // 网络（http-tools.ts）
  "WebFetch",
  "WebSearch",
  // 能力授予目标（skill-use-tool.ts / todo-state.ts）
  "use_skill",
  "todo",
];

/** 声明名（大小写不敏感）→ 规范注册名；不在表内返回 undefined */
export function canonicalToolName(declared: string): string | undefined {
  const want = declared.trim().toLowerCase();
  return GRANTABLE_TOOLS.find((t) => t.toLowerCase() === want);
}

/** 单个子代理可声明的技能上限：每个都会进系统提示词目录块 */
const MAX_SKILL_TARGETS = 16;
/** 单个子代理可声明的知识源上限（每个一行目录，且 kb_search 要遍历 files 类） */
const MAX_KNOWLEDGE_SOURCES = 12;

/**
 * 检索读不了的二进制文档扩展名：knowledge.ts 按 \0 探测跳过二进制，
 * 指向这类文件的知识源永远零命中，是白给的配置。解析层警告（不毁文件），
 * 写路径直接拒（用户点了保存就不该静默放过）——与 read 工具依赖同策略。
 */
const BINARY_DOC_PATH = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)\s*$/i;

/**
 * 解析 knowledge 列表。格式错误的条目丢弃并记警告——一份坏知识源不该
 * 赔掉整份定义（与工具列表同哲学）。
 */
function parseKnowledgeSources(
  raw: unknown,
  label: string,
  warnings: string[],
): KnowledgeSource[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push(`${label} ignoring knowledge (expected a list of sources)`);
    return undefined;
  }
  const out: KnowledgeSource[] = [];
  if (raw.length > MAX_KNOWLEDGE_SOURCES) {
    warnings.push(
      `${label} knowledge over the ${MAX_KNOWLEDGE_SOURCES}-source cap, extra entries dropped`,
    );
  }
  for (const [i, entry] of raw.slice(0, MAX_KNOWLEDGE_SOURCES).entries()) {
    const at = `${label} knowledge[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`${at} must be a mapping`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) {
      warnings.push(`${at} missing name`);
      continue;
    }
    // 知识源只有文档一种。外部系统（飞书/Notion/数据库）走 mcp.servers
    // ——那条路已经能直接调服务器工具，再拿知识源指一遍是同一件事说两遍。
    // 这条判定必须排在 path 校验之前：MCP 条目本来就没有 path，先报"缺 path"
    // 会让用户以为补个路径就行，而正确做法是改用 mcp.servers。
    if (e.type === "mcp") {
      warnings.push(`${at} MCP 知识源已不再支持：改用 mcp.servers 授予该服务器`);
      continue;
    }
    const path = typeof e.path === "string" ? e.path.trim() : "";
    if (!path) {
      warnings.push(`${at} missing path`);
      continue;
    }
    // 不丢条目只警告：文件是磁盘上的用户数据，二进制源虽检索不到，
    // 静默删除会让下次保存把条目带走；写路径（validateDraft）才拒绝
    if (BINARY_DOC_PATH.test(path)) {
      warnings.push(`${at} points to a binary document, kb_search cannot read it — convert to Markdown/CSV or plain text`);
    }
    out.push({ name, path });
  }
  return out.length ? out : undefined;
}

export function normalizeSubagentName(value: string): string {
  return value.trim().toLowerCase();
}

/** 开关状态键：内置/系统按 scope:name；工作区按 cwd 隔离（同名不同仓库互不影响）；插件层按 pluginId 命名空间 */
export function subagentStateKey(
  scope: SubagentScope,
  name: string,
  cwd?: string,
  pluginId?: string,
): string {
  const norm = normalizeSubagentName(name);
  if (scope === "plugin") return `plugin:${pluginId ?? ""}::${norm}`;
  return scope === "workspace" ? `workspace:${cwd ?? ""}::${norm}` : `${scope}:${norm}`;
}

// ---------------------------------------------------------------------------
// 目录解析
// ---------------------------------------------------------------------------

/** 系统级定义目录（应用数据目录下，与 state.db / sessions 同族） */
export function systemSubagentsDir(): string {
  if (process.env.PI_SUBAGENTS_DIR) return process.env.PI_SUBAGENTS_DIR;
  const db = process.env.PI_DB_PATH;
  if (db) return join(dirname(resolve(db)), "subagents");
  return join(homedir(), ".kova", "subagents");
}

/** 工作区级定义目录 */
export function workspaceSubagentsDir(cwd: string): string {
  return join(cwd, ".kova", "subagents");
}

// ---------------------------------------------------------------------------
// 内置定义（只读基线：设置页可查看/开关/复制为系统级，永不写回）
// ---------------------------------------------------------------------------

export type SubagentDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns?: number;
  model?: string;
  prompt: string;
  /** 技能白名单（按名） */
  skills?: string[];
  /** MCP 服务器白名单 */
  mcpServers?: string[];
  /** 声明式知识源 */
  knowledge?: KnowledgeSource[];
  /** 记忆档位（none 即不写） */
  memory?: SubagentMemoryMode;
};

/**
 * sidecar 内置的子代理定义。每一个都要挣得自己的 prompt-token 成本：
 * 都是把主代理本来要在全量上下文里内联完成的事拆出去——
 * 快速代码库导航、对改动的第二意见、跑测试命令、以及在独立上下文里实现多文件改动。
 */
export const BUILTIN_SUBAGENT_SPECS: readonly SubagentDraft[] = [
  {
    name: "Explorer",
    description:
      'Fast codebase search and pattern matching — find files, locate implementations and answer "where is X?" / "how does Y work?". Use when answering needs a sweep over many files and you only want the conclusion.',
    tools: ["read", "glob", "grep", "bash"],
    maxTurns: 60,
    prompt: `You are Explorer — a fast codebase navigation specialist.

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
  },
  {
    name: "Code-reviewer",
    description:
      "Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before you commit.",
    tools: ["read", "glob", "grep"],
    maxTurns: 50,
    prompt: `Review only what the task names, and read enough surrounding code to judge it.

- Prefer defects that change behavior: wrong results, unhandled failures,
  broken invariants, races, resource leaks, missing test coverage.
- Check the code against how its callers and neighbors actually use it, not
  against a style preference.
- Say nothing about formatting, naming or structure unless it causes a defect.

Report: each finding as \`path:line\` plus one sentence on what breaks and under
what input. Order by severity. If the code is sound, say so plainly and name
the cases you checked — an empty review with no evidence is not a review.`,
  },
  {
    name: "Test-runner",
    description:
      "Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.",
    tools: ["read", "glob", "grep", "bash"],
    maxTurns: 40,
    prompt: `Run the command the task names. Do not invent a different one, and do not fix
anything: diagnosis is the deliverable.

- Run the command once. If it fails to start (missing script, wrong directory),
  find the right invocation and say what you changed.
- For each failure, read the failing test and the code under it far enough to
  name the cause.

Report: pass/fail counts, then one entry per failure with the test name, the
assertion or error, and the \`path:line\` you believe is responsible. Keep the
raw output out of the report except for the lines that carry the failure.`,
  },
  {
    name: "Fixer",
    description:
      "Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.",
    tools: ["read", "glob", "grep", "edit", "write", "bash"],
    maxTurns: 80,
    prompt: `You are Fixer — a fast, focused implementation specialist. The main agent
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
  },
];

/** 内置定义（常量直构，不经文件层；坏不了，也没有可诊断的路径） */
export function builtinSubagents(): SubagentDefinition[] {
  return BUILTIN_SUBAGENT_SPECS.map((spec) => ({
    ...spec,
    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    scope: "builtin" as const,
    raw: emitSubagentYaml(spec),
    stateKey: subagentStateKey("builtin", spec.name),
  }));
}

// ---------------------------------------------------------------------------
// YAML 解析 / 序列化
// ---------------------------------------------------------------------------

/** 定义文件承认的顶层键（其余进 warnings，不丢弃定义） */
const KNOWN_YAML_KEYS: readonly string[] = [
  "name",
  "description",
  "tools",
  "maxTurns",
  "model",
  "prompt",
  // 能力授予维度
  "skills",
  "mcp",
  "knowledge",
  "memory",
];

/**
 * 解析一份 YAML 定义。格式错误进 errors，可疑但不致命的进 warnings。
 * fallbackName 用文件名兜底（与旧 frontmatter 行为一致）。
 */
export function parseSubagentYaml(
  raw: string,
  options: {
    scope: SubagentScope;
    filePath?: string;
    fallbackName?: string;
    /** scope = "plugin" 必填：stateKey 命名空间 */
    pluginId?: string;
  } = { scope: "system" },
): ParsedDefinition {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    };
  }
  if (doc === null) {
    return { ok: false, errors: ["empty YAML document"], warnings };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["top level must be a mapping"], warnings };
  }
  const r = doc as Record<string, unknown>;

  let name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name && options.fallbackName) name = options.fallbackName.trim();
  if (!name) return { ok: false, errors: ["missing name"], warnings };

  const label = `[${name}]`;
  const description =
    typeof r.description === "string" ? r.description.trim() : "";
  if (!description) {
    return { ok: false, errors: [`${label} missing description`], warnings };
  }

  // 工具名归一为规范注册名（WebFetch ≠ webfetch）。找不到的记警告而非丢弃：
  // 丢一个工具可能让定义彻底不可用，用户无从得知缺了什么。
  let tools: string[] = [];
  if (Array.isArray(r.tools)) tools = r.tools.map(String);
  else if (typeof r.tools === "string") tools = r.tools.split(",");
  const canonicalTools: string[] = [];
  for (const t of tools) {
    const canon = canonicalToolName(t);
    if (canon) {
      if (!canonicalTools.includes(canon)) canonicalTools.push(canon);
    } else {
      warnings.push(`${label} unknown tool "${t.trim()}"`);
    }
  }
  if (canonicalTools.length === 0) {
    return {
      ok: false,
      errors: [`${label} missing tools list (e.g. "tools: [read, grep]")`],
      warnings,
    };
  }
  tools = canonicalTools;

  // ---- 能力授予维度（§4）：skills / mcp / knowledge / memory ----

  let skills: string[] | undefined;
  if (r.skills !== undefined) {
    const raw = Array.isArray(r.skills)
      ? r.skills.map(String)
      : typeof r.skills === "string"
        ? r.skills.split(",")
        : [];
    if (!Array.isArray(r.skills) && typeof r.skills !== "string") {
      warnings.push(`${label} ignoring non-list skills`);
    } else {
      const list = raw.map((s) => s.trim()).filter(Boolean);
      if (list.length > MAX_SKILL_TARGETS) {
        warnings.push(`${label} skills over the ${MAX_SKILL_TARGETS} cap, extra entries dropped`);
      }
      skills = [...new Set(list)].slice(0, MAX_SKILL_TARGETS);
    }
  }

  let mcpServers: string[] | undefined;
  if (r.mcp !== undefined) {
    const block = r.mcp;
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      warnings.push(`${label} ignoring mcp (expected a mapping with a servers list)`);
    } else {
      const rawServers = (block as Record<string, unknown>).servers;
      if (rawServers !== undefined) {
        if (Array.isArray(rawServers)) {
          mcpServers = [...new Set(rawServers.map(String).map((s) => s.trim()).filter(Boolean))];
        } else if (typeof rawServers === "string") {
          mcpServers = [...new Set(rawServers.split(",").map((s) => s.trim()).filter(Boolean))];
        } else {
          warnings.push(`${label} ignoring mcp.servers (expected a list)`);
        }
      }
    }
  }

  const knowledge = parseKnowledgeSources(r.knowledge, label, warnings);

  let memory: SubagentMemoryMode | undefined;
  if (r.memory !== undefined) {
    const m = String(r.memory).trim().toLowerCase();
    if (m === "none" || m === "private" || m === "shared") {
      memory = m;
    } else {
      warnings.push(`${label} ignoring invalid memory "${String(r.memory)}" (expected none|private|shared)`);
    }
  }

  // 能力依赖：知识源需要 read 才能打开检索到的文件
  if (knowledge?.length && !tools.includes("read")) {
    warnings.push(`${label} declares a knowledge source but not the read tool; search hits cannot be opened`);
  }

  let maxTurns: number | undefined;
  if (r.maxTurns !== undefined) {
    const n = Number(r.maxTurns);
    if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
    else warnings.push(`${label} ignoring invalid maxTurns "${String(r.maxTurns)}"`);
  }

  let model: string | undefined;
  if (r.model !== undefined) {
    const m = String(r.model).trim();
    if (m.includes("/")) model = m;
    else warnings.push(`${label} ignoring model "${m}" (expected "provider/modelId")`);
  }

  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (!prompt) return { ok: false, errors: [`${label} empty prompt body`], warnings };

  for (const key of Object.keys(r)) {
    if (!KNOWN_YAML_KEYS.includes(key)) {
      warnings.push(`${label} ignoring unknown key "${key}"`);
    }
  }

  return {
    ok: true,
    definition: {
      name,
      description,
      tools,
      prompt,
      scope: options.scope,
      ...(skills && skills.length ? { skills } : {}),
      ...(mcpServers && mcpServers.length ? { mcpServers } : {}),
      ...(knowledge && knowledge.length ? { knowledge } : {}),
      ...(memory && memory !== "none" ? { memory } : {}),
      ...(options.scope === "plugin" && options.pluginId
        ? { pluginId: options.pluginId }
        : {}),
      ...(options.filePath ? { path: options.filePath } : {}),
      stateKey: subagentStateKey(
        options.scope,
        name,
        options.scope === "workspace" ? workspaceFromDefinitionPath(options.filePath) : undefined,
        options.pluginId,
      ),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(model ? { model } : {}),
    },
    warnings,
  };
}

/** 从定义文件路径反推所属工作区 cwd（<cwd>/.kova/subagents/x.yml → <cwd>，不带尾分隔符） */
function workspaceFromDefinitionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const marker = join(".kova", "subagents");
  const idx = path.lastIndexOf(marker);
  if (idx < 0) return undefined;
  const cwd = path.slice(0, idx).replace(/[\\/]+$/, "");
  return cwd || undefined;
}

const YAML_HEADER = "# Kova subagent definition — managed via Settings → Subagents\n";

/** 序列化一份定义为 YAML 文本（键序稳定，diff 友好；长行不折行） */
export function emitSubagentYaml(draft: SubagentDraft): string {
  const doc: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    tools: draft.tools,
  };
  if (draft.maxTurns !== undefined) doc.maxTurns = draft.maxTurns;
  if (draft.model) doc.model = draft.model;
  // 能力维度：只在有内容时写，避免给未声明的维度留空壳噪声
  if (draft.skills?.length) doc.skills = draft.skills;
  if (draft.mcpServers?.length) doc.mcp = { servers: draft.mcpServers };
  if (draft.knowledge?.length) doc.knowledge = draft.knowledge;
  if (draft.memory && draft.memory !== "none") doc.memory = draft.memory;
  doc.prompt = draft.prompt.endsWith("\n") ? draft.prompt : `${draft.prompt}\n`;
  return YAML_HEADER + stringifyYaml(doc, { lineWidth: 0 });
}

/**
 * 定义名 → 文件名。只替换各平台文件名的非法字符（含路径分隔与空白），
 * 保留非 ASCII（中文名直接做文件名，slug 化成 ASCII 会把多个中文名撞成同一个 agent.yml）。
 */
export function subagentFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[:<>"/\\?*|\s\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || "agent"}.yml`;
}

// ---------------------------------------------------------------------------
// 运行时状态（启用开关），整包 SQLite kv
// ---------------------------------------------------------------------------

export type SubagentState = {
  /** stateKey -> 被显式关闭 */
  disabled: Record<string, true>;
  /** stateKey -> "provider/modelId" 模型覆盖；只读层（内置/插件）靠它选模型 */
  modelOverrides: Record<string, string>;
};

export const SUBAGENT_STATE_KV_KEY = "pi.subagents";

let state: SubagentState = emptyState();
let stateLoad: Promise<void> | undefined;

function emptyState(): SubagentState {
  return { disabled: {}, modelOverrides: {} };
}

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initSubagentState(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(SUBAGENT_STATE_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as Partial<SubagentState>;
      state = {
        disabled: (parsed.disabled ?? {}) as Record<string, true>,
        // 老载荷只有 disabled；缺失即无覆盖，解析失败也不该赔上整个清单
        modelOverrides: parsed.modelOverrides ?? {},
      };
    } catch (err) {
      logErr("subagents-state:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

async function ensureSubagentState(): Promise<void> {
  await initSubagentState();
}

async function persistState(): Promise<void> {
  try {
    await kvSet(SUBAGENT_STATE_KV_KEY, JSON.stringify(state));
  } catch (err) {
    logErr("subagents-state save:", err instanceof Error ? err.message : String(err));
  }
}

/** 测试钩子：清掉 kv 装载与目录缓存，回到全默认状态 */
export function resetSubagentsForTest(): void {
  state = emptyState();
  stateLoad = undefined;
  globalCache.dir = "";
  globalCache.entry = undefined;
  workspaceCache.clear();
  subagentPluginCache.clear();
}

export async function setSubagentEnabled(
  scope: SubagentScope,
  name: string,
  enabled: boolean,
  cwd?: string,
  pluginId?: string,
): Promise<void> {
  await ensureSubagentState();
  const key = subagentStateKey(scope, name, cwd, pluginId);
  if (enabled) delete state.disabled[key];
  else state.disabled[key] = true;
  await persistState();
}

/**
 * 设一条模型覆盖（"provider/modelId"）。传空串/空白即清除覆盖，该定义回落
 * 自带 model，再回落会话当前模型。
 *
 * 只校验形状，不查目录：模型目录是惰性单例，把保存绑死在目录就绪上会让
 * "服务还没配好就存不进去"。拼错的键在 Task 解析时已有明确报错
 * （subagent/tools.ts 的 resolveDelegateModel）。
 */
export async function setSubagentModelOverride(
  scope: SubagentScope,
  name: string,
  model: string | undefined,
  cwd?: string,
  pluginId?: string,
): Promise<void> {
  await ensureSubagentState();
  const key = subagentStateKey(scope, name, cwd, pluginId);
  const trimmed = model?.trim() ?? "";
  if (!trimmed) {
    delete state.modelOverrides[key];
  } else {
    if (!trimmed.includes("/")) {
      throw new Error(`模型需为 "provider/modelId" 形式，收到 "${trimmed}"`);
    }
    state.modelOverrides[key] = trimmed;
  }
  await persistState();
}

/** 插件子智能体组件清单（插件详情页用）：扫描指定目录并叠加当前开关状态 */
export function listPluginSubagentEntries(
  dir: string,
  pluginId: string,
): Array<{ name: string; description: string; enabled: boolean }> {
  const { definitions, diagnostics } = loadLayer(dir, "plugin", pluginId);
  for (const d of diagnostics) logErr(`plugin ${pluginId} subagents:`, d);
  return definitions.map((def) => ({
    name: def.name,
    description: def.description,
    enabled: state.disabled[def.stateKey] !== true,
  }));
}

/**
 * 插件子智能体定义原文（插件详情页"查看内容"用）：按名取该条目的 YAML 原文与
 * 文件路径。清单只带 name/description（见上），正文按需现取——列表页不必为
 * 每个子智能体把整段 prompt 带在每次 list_plugins 应答里。
 * 未找到或该条目无可用原文（如内置序列化而来）返回 undefined。
 */
export function readPluginSubagentDoc(
  dir: string,
  pluginId: string,
  name: string,
): { raw: string; path: string } | undefined {
  const { definitions } = loadLayer(dir, "plugin", pluginId);
  const def = definitions.find((d) => d.name === name);
  if (!def?.raw || !def.path) return undefined;
  return { raw: def.raw, path: def.path };
}

// ---------------------------------------------------------------------------
// 三层加载（签名缓存）
// ---------------------------------------------------------------------------

type LayerEntry = { definitions: SubagentDefinition[]; diagnostics: string[] };

function dirSignature(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((n) => /\.ya?ml$/i.test(n))
      .sort()
      .map((n) => {
        const st = statSync(join(dir, n));
        return `${n}:${Math.round(st.mtimeMs)}:${st.size}`;
      })
      .join("|");
  } catch {
    return "";
  }
}

function loadLayer(
  dir: string,
  scope: SubagentScope,
  /** 工作区层的 stateKey 需要能反推出 cwd，path 已含目录前缀足够 */
  pluginId?: string,
): LayerEntry {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    return { definitions, diagnostics };
  }
  if (names.length > MAX_PER_LAYER) {
    diagnostics.push(
      `${dir}: dropped ${names.length - MAX_PER_LAYER} definition file(s) past the ${MAX_PER_LAYER}-file cap`,
    );
    names = names.slice(0, MAX_PER_LAYER);
  }
  for (const fileName of names) {
    const filePath = join(dir, fileName);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      diagnostics.push(`${filePath}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const parsed = parseSubagentYaml(raw, {
      scope,
      filePath,
      fallbackName: basename(fileName).replace(/\.ya?ml$/i, ""),
      ...(scope === "plugin" && pluginId ? { pluginId } : {}),
    });
    for (const warning of parsed.warnings) diagnostics.push(`${filePath}: ${warning}`);
    if (parsed.ok) definitions.push({ ...parsed.definition, raw });
    else diagnostics.push(`${filePath}: ${parsed.errors.join("; ")}`);
  }
  return { definitions, diagnostics };
}

/** 内置 + 系统层的缓存（两层都不随会话变） */
const globalCache: { dir: string; entry?: LayerEntry } = { dir: "" };
/** 工作区层按 cwd 缓存 */
const workspaceCache = new Map<string, { sig: string; entry: LayerEntry }>();
/** 插件层按 pluginId 缓存（目录签名失效） */
const subagentPluginCache = new Map<string, { sig: string; entry: LayerEntry }>();

export type SubagentLoadResult = {
  /** 挂到 Task 工具组的定义集合：已启用，同名工作区>系统>内置 */
  definitions: SubagentDefinition[];
  /** 设置页清单：三层全部条目（内置含在内），带 enabled/editable */
  entries: SubagentEntry[];
  /** 已启用的定义里是否有同名条目遮蔽了内置（诊断用） */
  diagnostics: string[];
};

/**
 * 把 kv 里的模型覆盖烘焙进定义。覆盖优先于定义自带的 model，并重算 raw
 * （设置页"YAML 原文"页签与表单读的是同一份 raw，两者不能各说各话）。
 * 逐字段重挑而不是 spread 整个 def：emitSubagentYaml 收的是 SubagentDraft，
 * 带上 scope/raw/stateKey 这些运行时字段过不了结构检查。
 */
function applyModelOverride(def: SubagentDefinition): SubagentDefinition {
  const override = state.modelOverrides[def.stateKey];
  if (!override || override === def.model) return def;
  return {
    ...def,
    model: override,
    ...(def.raw
      ? {
          raw: emitSubagentYaml({
            name: def.name,
            description: def.description,
            tools: def.tools,
            ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
            model: override,
            prompt: def.prompt,
            // 能力维度必须逐个带过来：漏掉任一个，用户在设置页"复制/查看 YAML"
            // 看到的就会是一份少了能力的定义（§7.3② 同类缺陷）
            ...(def.skills ? { skills: def.skills } : {}),
            ...(def.mcpServers ? { mcpServers: def.mcpServers } : {}),
            ...(def.knowledge ? { knowledge: def.knowledge } : {}),
            ...(def.memory ? { memory: def.memory } : {}),
          }),
        }
      : {}),
  };
}

/**
 * 会话可用的定义集合：内置 + 系统层 + 工作区层。
 * 一份坏文档降级为诊断，不赔上其它 delegate，更不能赔上整个 turn。
 */
export async function loadSubagentDefinitions(options: {
  cwd?: string;
  /** 测试注入：覆盖系统目录解析 */
  systemDir?: string;
} = {}): Promise<SubagentLoadResult> {
  await ensureSubagentState();
  const systemDir = options.systemDir ?? systemSubagentsDir();

  const globalSig = `builtin|${systemDir}|${dirSignature(systemDir)}`;
  if (globalCache.dir !== globalSig || !globalCache.entry) {
    const system = loadLayer(systemDir, "system");
    globalCache.dir = globalSig;
    globalCache.entry = {
      definitions: [...builtinSubagents(), ...system.definitions],
      diagnostics: system.diagnostics,
    };
  }
  const globalEntry = globalCache.entry;

  let workspaceEntry: LayerEntry = { definitions: [], diagnostics: [] };
  const cwd = options.cwd;
  if (cwd) {
    const dir = workspaceSubagentsDir(cwd);
    const sig = dirSignature(dir);
    const cached = workspaceCache.get(cwd);
    if (cached && cached.sig === sig) {
      workspaceEntry = cached.entry;
    } else {
      workspaceEntry = loadLayer(dir, "workspace");
      workspaceCache.set(cwd, { sig, entry: workspaceEntry });
    }
  }

  // 插件层（垫底）：逐启用插件扫描其 subagents 目录，pluginId 排序保证同名遮蔽确定性
  const pluginEntries: LayerEntry[] = [];
  for (const plugin of activePlugins()) {
    const dir = resolvePluginComponent(plugin.manifest, "subagents");
    if (!dir || !existsSync(dir)) continue;
    const sig = dirSignature(dir);
    const cacheKey = `${plugin.pluginId}`;
    const cached = subagentPluginCache.get(cacheKey);
    const entry =
      cached && cached.sig === sig ? cached.entry : loadLayer(dir, "plugin", plugin.pluginId);
    subagentPluginCache.set(cacheKey, { sig, entry });
    pluginEntries.push(entry);
  }

  const diagnostics = [
    ...globalEntry.diagnostics,
    ...workspaceEntry.diagnostics,
    ...pluginEntries.flatMap((e) => e.diagnostics),
  ];

  const isEnabled = (def: SubagentDefinition): boolean =>
    state.disabled[def.stateKey] !== true;

  const mounted = new Map<string, SubagentDefinition>();
  const ordered = [
    ...globalEntry.definitions,
    ...workspaceEntry.definitions,
    ...pluginEntries.flatMap((e) => e.definitions),
  ].map(applyModelOverride);
  for (const def of ordered) {
    if (!isEnabled(def)) continue;
    mounted.set(normalizeSubagentName(def.name), def);
  }

  const entries: SubagentEntry[] = ordered.map((def) => ({
    ...def,
    enabled: isEnabled(def),
    editable: def.scope !== "builtin" && def.scope !== "plugin",
  }));

  return {
    definitions: [...mounted.values()],
    entries,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// 写路径（设置页 → 系统/工作区目录）
// ---------------------------------------------------------------------------

function validateDraft(draft: SubagentDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("名称不能为空");
  if (!/^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff ._-]{0,63}$/.test(draft.name.trim())) {
    errors.push("名称需以字母/数字/汉字开头，仅可含字母、数字、汉字、空格、._-（≤64 字符）");
  }
  if (!draft.description.trim()) errors.push("描述不能为空");
  if (draft.tools.length === 0) errors.push("至少选择一个工具");
  for (const t of draft.tools) {
    if (!canonicalToolName(t)) errors.push(`未知工具 "${t}"`);
  }
  // 知识源依赖 read：解析层只警告，写路径直接拒（用户点了保存就不该静默放过）
  if (
    draft.knowledge?.length &&
    !draft.tools.some((t) => canonicalToolName(t) === "read")
  ) {
    errors.push("声明了 files 知识源就必须授予 read 工具，否则检索结果无法打开");
  }
  if (draft.skills && draft.skills.length > MAX_SKILL_TARGETS) {
    errors.push(`技能数超过上限 ${MAX_SKILL_TARGETS}`);
  }
  if (draft.knowledge && draft.knowledge.length > MAX_KNOWLEDGE_SOURCES) {
    errors.push(`知识源数超过上限 ${MAX_KNOWLEDGE_SOURCES}`);
  }
  for (const k of draft.knowledge ?? []) {
    if (!k.name.trim()) errors.push("知识源缺少名称");
    if (!k.path?.trim()) {
      errors.push(`知识源 "${k.name}" 缺少 path`);
    } else if (BINARY_DOC_PATH.test(k.path.trim())) {
      errors.push(
        `知识源 "${k.name}" 指向 PDF/Office 二进制文档，检索读不了：请先把资料转成 Markdown/CSV/纯文本，或改指向文本目录`,
      );
    }
  }
  if (!draft.prompt.trim()) errors.push("prompt 不能为空");
  if (draft.maxTurns !== undefined && (!Number.isFinite(draft.maxTurns) || draft.maxTurns < 1)) {
    errors.push("maxTurns 需为正整数");
  }
  if (draft.model && !draft.model.includes("/")) {
    errors.push('model 需为 "provider/modelId" 形式');
  }
  return errors;
}

/** YAML 文本 → draft（设置页"YAML 原文"编辑的保存路径：与文件加载共用同一解析校验） */
export function parseSubagentDraftYaml(
  raw: string,
  scope: "system" | "workspace",
): { ok: true; draft: SubagentDraft } | { ok: false; errors: string[] } {
  const parsed = parseSubagentYaml(raw, { scope });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const d = parsed.definition;
  return {
    ok: true,
    draft: {
      name: d.name,
      description: d.description,
      tools: d.tools,
      prompt: d.prompt,
      ...(d.maxTurns !== undefined ? { maxTurns: d.maxTurns } : {}),
      ...(d.model ? { model: d.model } : {}),
      // 能力维度逐个透传——设置页"YAML 原文"保存路径靠这一份往返保真
      ...(d.skills ? { skills: d.skills } : {}),
      ...(d.mcpServers ? { mcpServers: d.mcpServers } : {}),
      ...(d.knowledge ? { knowledge: d.knowledge } : {}),
      ...(d.memory ? { memory: d.memory } : {}),
    },
  };
}

export type SubagentWriteOptions = {
  /** workspace 层必填：所属工作区 cwd */
  cwd?: string;
  /** 测试注入：覆盖系统目录解析（workspace 层忽略） */
  systemDir?: string;
  /** 编辑时改名：旧名对应的本层文件一并删除 */
  replaceName?: string;
};

/**
 * 保存（新增或同名覆盖）一份系统/工作区定义。
 * 名称跨层唯一：内置只读可关可复制，不允许被同名遮蔽——要定制内置走"复制为
 * 系统级"。工作区经设置页保存时顺带完成信任（用户明确意图，不再二次弹窗）。
 */
export async function saveSubagentDefinition(
  scope: "system" | "workspace",
  draft: SubagentDraft,
  options: SubagentWriteOptions = {},
): Promise<void> {
  const { cwd, replaceName } = options;
  const errors = validateDraft(draft);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const norm = normalizeSubagentName(draft.name);

  const builtinHit = builtinSubagents().some((d) => normalizeSubagentName(d.name) === norm);
  if (builtinHit) {
    throw new Error(
      `名称 "${draft.name}" 与内置子智能体重名：内置定义只读，请改名，或在设置页关闭内置后用副本替代`,
    );
  }

  const dir =
    scope === "system"
      ? options.systemDir ?? systemSubagentsDir()
      : workspaceSubagentsDir(cwd ?? homedir());
  // 跨层查重（系统 vs 工作区也不允许同名——两层同时挂载时谁盖谁说不清）
  const otherLayerDefs = (
    await loadSubagentDefinitions({
      cwd: scope === "workspace" ? undefined : cwd,
      systemDir: options.systemDir,
    })
  ).entries.filter((e) => e.scope !== scope);
  if (otherLayerDefs.some((e) => normalizeSubagentName(e.name) === norm)) {
    throw new Error(`名称 "${draft.name}" 已被另一层的定义占用，请换一个名字`);
  }

  const filePath = join(dir, subagentFileName(draft.name));
  const replaceNorm = replaceName ? normalizeSubagentName(replaceName) : undefined;
  // 同名编辑 = 覆盖本层同名文件（可能文件名 slug 不同）；改名编辑再清掉旧名文件
  if (existsSync(dir)) {
    for (const existing of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n))) {
      const full = join(dir, existing);
      if (full === filePath) continue;
      try {
        const parsed = parseSubagentYaml(readFileSync(full, "utf8"), {
          scope,
          filePath: full,
          fallbackName: basename(existing).replace(/\.ya?ml$/i, ""),
        });
        if (!parsed.ok) continue;
        const existingNorm = normalizeSubagentName(parsed.definition.name);
        if (existingNorm === norm || (replaceNorm && existingNorm === replaceNorm)) {
          unlinkSync(full);
        }
      } catch {
        // 坏文件交给诊断路径处理，不挡保存
      }
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, emitSubagentYaml(draft), "utf8");
}

/** 删除一份系统/工作区定义（内置不可删）。按名称找到文件后删除并清开关残留。 */
export async function deleteSubagentDefinition(
  scope: "system" | "workspace",
  name: string,
  options: SubagentWriteOptions = {},
): Promise<void> {
  const { cwd } = options;
  const dir =
    scope === "system"
      ? options.systemDir ?? systemSubagentsDir()
      : workspaceSubagentsDir(cwd ?? homedir());
  const norm = normalizeSubagentName(name);
  let removed = false;
  if (existsSync(dir)) {
    for (const fileName of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n))) {
      const full = join(dir, fileName);
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSubagentYaml(raw, {
        scope,
        filePath: full,
        fallbackName: basename(fileName).replace(/\.ya?ml$/i, ""),
      });
      if (parsed.ok && normalizeSubagentName(parsed.definition.name) === norm) {
        unlinkSync(full);
        removed = true;
      }
    }
  }
  if (!removed) throw new Error(`未找到 ${scope === "system" ? "系统" : "工作区"}定义 "${name}"`);
  await setSubagentEnabled(scope, name, true, cwd).catch(() => {});
  // 覆盖是按 stateKey 存的，定义没了就该一起走，别在 kv 里留孤儿键
  await setSubagentModelOverride(scope, name, undefined, cwd).catch(() => {});
}
