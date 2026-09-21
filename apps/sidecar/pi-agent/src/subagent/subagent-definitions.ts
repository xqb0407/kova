/**
 * 子代理定义的来源、解析与运行时状态（设置 → 子智能体）。
 *
 * 三层发现，同名时后层遮蔽前层（工作区 > 系统 > 内置）：
 * - 内置：内联常量，设置页只读查看，只可启用/关闭，永不被写。
 * - 系统：应用数据目录 `<app_data>/subagents/*.yml`（生产由 Tauri 注入
 *   PI_SUBAGENTS_DIR；兜底 PI_DB_PATH 同级 subagents/，再兜底 ~/.xulux/subagents）。
 * - 工作区：`<cwd>/.xulux/subagents/*.yml`，与 .xulux/plans 同族。
 *
 * 定义文件是纯 YAML（yaml 包解析/序列化）。启用开关是"本机的运行时决定"，
 * 不写进定义文件（工作区文件在 git 里）：整包存 SQLite kv（key = STATE_KV_KEY），
 * 与个性化设置同款链路。
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

/** 一份子代理定义（解析产物与运行时共用同一形状） */
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
  scope: SubagentScope;
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

/** delegate 可声明的工具全集（tools.ts 的内置编码工具；Task 组绝不外授） */
const KNOWN_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"];

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
  return join(homedir(), ".xulux", "subagents");
}

/** 工作区级定义目录 */
export function workspaceSubagentsDir(cwd: string): string {
  return join(cwd, ".xulux", "subagents");
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
};

/**
 * sidecar 内置的子代理定义。每一个都要挣得自己的 prompt-token 成本：
 * 都是把主代理本来要在全量上下文里内联完成的事拆出去——
 * 快速代码库导航、对改动的第二意见、跑测试命令、以及在独立上下文里实现多文件改动。
 */
export const BUILTIN_SUBAGENT_SPECS: readonly SubagentDraft[] = [
  {
    name: "explorer",
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
    name: "code-reviewer",
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
    name: "test-runner",
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
    name: "fixer",
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

  let tools: string[] = [];
  if (Array.isArray(r.tools)) tools = r.tools.map(String);
  else if (typeof r.tools === "string") tools = r.tools.split(",");
  tools = tools.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tools.length === 0) {
    return {
      ok: false,
      errors: [`${label} missing tools list (e.g. "tools: [read, grep]")`],
      warnings,
    };
  }
  for (const t of tools) {
    if (!KNOWN_TOOLS.includes(t)) warnings.push(`${label} unknown tool "${t}"`);
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
    if (!["name", "description", "tools", "maxTurns", "model", "prompt"].includes(key)) {
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

/** 从定义文件路径反推所属工作区 cwd（<cwd>/.xulux/subagents/x.yml → <cwd>，不带尾分隔符） */
function workspaceFromDefinitionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const marker = join(".xulux", "subagents");
  const idx = path.lastIndexOf(marker);
  if (idx < 0) return undefined;
  const cwd = path.slice(0, idx).replace(/[\\/]+$/, "");
  return cwd || undefined;
}

const YAML_HEADER = "# Xulux subagent definition — managed via Settings → Subagents\n";

/** 序列化一份定义为 YAML 文本（键序稳定，diff 友好；长行不折行） */
export function emitSubagentYaml(draft: SubagentDraft): string {
  const doc: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    tools: draft.tools,
  };
  if (draft.maxTurns !== undefined) doc.maxTurns = draft.maxTurns;
  if (draft.model) doc.model = draft.model;
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
};

export const SUBAGENT_STATE_KV_KEY = "pi.subagents";

let state: SubagentState = { disabled: {} };
let stateLoad: Promise<void> | undefined;

function emptyState(): SubagentState {
  return { disabled: {} };
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
  ];
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
    if (!KNOWN_TOOLS.includes(t.toLowerCase())) errors.push(`未知工具 "${t}"`);
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
}
