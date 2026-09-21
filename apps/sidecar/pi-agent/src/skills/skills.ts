/**
 * 技能（SKILL.md 指令文档）的来源、解析与运行时状态（设置 → 技能）。
 *
 * 渐进式披露：系统提示词只注入"生效技能"的目录（pi-agent-core 的
 * formatSkillsForSystemPrompt：<available_skills> XML，每技能 name/description/
 * location 三行）；正文永不进提示词——模型判断任务匹配后经 use_skill 工具按
 * 名加载（skill-use-tool.ts；目录段指引已改指该工具）。禁用或被遮蔽的技能连
 * 目录行都不出现。
 *
 * 来源分层，同名时前层遮蔽后层（工作区 > 生态·工作区 > 系统 > 生态·用户）：
 * - 工作区（可编辑）：<cwd>/.xulux/skills/*.md
 * - 生态·工作区（只读）：<cwd>/.agents/skills/（agentskills.io 标准目录，
 *   根级 .md 与 <dir>/SKILL.md 都识别，直接复用社区技能包）
 * - 系统（可编辑）：应用数据目录 skills/（生产由 Rust 注入 PI_DB_PATH 同级
 *   推导，兜底 ~/.xulux/skills；测试经 PI_SKILLS_DIR 钉住）
 * - 生态·用户（只读）：~/.agents/skills
 *
 * 文件格式：YAML frontmatter（name/description，可选 disable-model-invocation）
 * + Markdown 正文。加载走 pi-agent-core 的 loadSkills（NodeExecutionEnv），
 * 与 agentskills.io 规范一致（SKILL.md 嵌套、ignore 文件、命名/描述校验诊断）。
 * 注意：根级 .md 不写 name 时库会以父目录名兜底（同层多个无名文件会互相撞名），
 * 设置页写出的文件恒带 name，无此问题；同名遮蔽在 merge 时统一裁决。
 *
 * 启用开关是"本机的运行时决定"，不写进技能文件（工作区文件在 git 里）：
 * 整包存 SQLite kv（key = SKILLS_STATE_KV_KEY），与子智能体/MCP 同款链路。
 *
 * 缓存：目录树签名（递归含嵌套 SKILL.md 的 mtime——frontmatter 改动必须失效
 * 目录；正文改动不影响提示词，模型每次 read 都拿磁盘现值）。签名没变用缓存。
 * 保存/删除/开关后 protocol 层调 sessions.reloadSkills()：刷缓存 + 对活动会话
 * 重组系统提示词热替换（与 reloadSubagents / applyMode 同款手法）。
 */
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { activePlugins, resolvePluginComponent } from "../plugins/plugins";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export type SkillScope = "workspace" | "compat-workspace" | "system" | "compat" | "plugin";

/** 一条技能：库加载产物 + 来源层（cwd 供工作区层 stateKey 反推；pluginId 供插件层 stateKey 构造） */
export type LoadedSkill = { skill: Skill; scope: SkillScope; cwd?: string; pluginId?: string };

/** 设置页展示条目：加载产物 + 生效状态 */
export type SkillEntry = {
  name: string;
  description: string;
  scope: SkillScope;
  /** 开关（kv 决定；未记录 = 启用） */
  enabled: boolean;
  /** 被更高优先级同名技能遮蔽：enabled 但不生效 */
  shadowed: boolean;
  /** 生态目录只读：不可编辑/删除，只能开关 */
  editable: boolean;
  /** 技能文件绝对路径（模型 read 的 location；亦即正文按需读取入口） */
  path: string;
  /** 正文（frontmatter 之后；编辑器回填用，清单体积可控——目录页本身按需 read） */
  content: string;
  sizeBytes: number;
  updatedAt: string;
  /** scope = "plugin" 时来源插件身份（stateKey 命名空间） */
  pluginId?: string;
  /** true = 不出现在模型目录（agent skills 规范字段；仍列入设置页可开关） */
  disableModelInvocation?: boolean;
};

export type SkillDraft = {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
};

export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

/** 开关状态键：生态·用户/系统按 scope:name；工作区两层按 cwd 隔离；插件层按 pluginId 命名空间 */
export function skillStateKey(
  scope: SkillScope,
  name: string,
  cwd?: string,
  pluginId?: string,
): string {
  const norm = normalizeSkillName(name);
  if (scope === "plugin") return `plugin:${pluginId ?? ""}::${norm}`;
  return scope === "workspace" || scope === "compat-workspace"
    ? `${scope}:${cwd ?? ""}::${norm}`
    : `${scope}:${norm}`;
}

// ---------------------------------------------------------------------------
// 目录解析
// ---------------------------------------------------------------------------

/** 系统级技能目录（应用数据目录下，与 state.db / subagents 同族） */
export function systemSkillsDir(): string {
  if (process.env.PI_SKILLS_DIR) return process.env.PI_SKILLS_DIR;
  const db = process.env.PI_DB_PATH;
  if (db) return join(dirname(resolve(db)), "skills");
  return join(homedir(), ".xulux", "skills");
}

/** 工作区级技能目录（本应用托管层） */
export function workspaceSkillsDir(cwd: string): string {
  return join(cwd, ".xulux", "skills");
}

/** 生态·用户技能目录（agentskills.io 标准，只读发现；测试经 PI_COMPAT_SKILLS_DIR 钉住） */
export function compatHomeSkillsDir(): string {
  if (process.env.PI_COMPAT_SKILLS_DIR) return process.env.PI_COMPAT_SKILLS_DIR;
  return join(homedir(), ".agents", "skills");
}

/** 生态·工作区技能目录（agentskills.io 标准，只读发现） */
export function compatWorkspaceSkillsDir(cwd: string): string {
  return join(cwd, ".agents", "skills");
}

// ---------------------------------------------------------------------------
// 加载（pi-agent-core loadSkills + 目录树签名缓存）
// ---------------------------------------------------------------------------

/** 每层目录的技能数量上限，防止失控目录撑爆系统提示词 */
const MAX_PER_LAYER = 64;
/** 单个技能文档字节上限（正文只按需 read，这里防的是意外巨型文件） */
export const MAX_SKILL_BYTES = 128 * 1024;
/** 名称/描述上限（与 pi-agent-core loadSkills 的校验一致） */
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;

/** 嵌套目录场景的文件树签名：frontmatter 改动随文件 mtime 失效，隐藏/node_modules 跳过 */
const SIGNATURE_MAX_ENTRIES = 512;

function dirSignature(dir: string): string {
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 6 || out.length > SIGNATURE_MAX_ENTRIES) return;
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(abs, name);
      const relPath = rel ? `${rel}/${name}` : name;
      try {
        const st = statSync(full);
        out.push(`${relPath}:${Math.round(st.mtimeMs)}:${st.isDirectory() ? "d" : st.size}`);
        if (st.isDirectory()) walk(full, relPath, depth + 1);
        if (out.length > SIGNATURE_MAX_ENTRIES) return;
      } catch {
        // 并发删除的条目忽略：下次签名自然收敛
      }
    }
  };
  walk(dir, "", 0);
  return out.join("|");
}

/** loadSkills 共用执行环境：只用绝对路径，cwd 仅兜底 */
const skillEnv = new NodeExecutionEnv({ cwd: homedir() });

async function loadSkillLayer(
  dir: string,
  scope: SkillScope,
  cwd: string | undefined,
  pluginId?: string,
): Promise<{ layers: LoadedSkill[]; diagnostics: string[] }> {
  const r = await loadSkills(skillEnv, dir, BACKGROUND_CONTEXT);
  const diagnostics = r.diagnostics.map(
    (d) => `${dir}: ${d.message} (${d.path})`,
  );
  if (r.skills.length > MAX_PER_LAYER) {
    diagnostics.push(
      `${dir}: dropped ${r.skills.length - MAX_PER_LAYER} skill(s) past the ${MAX_PER_LAYER}-skill cap`,
    );
    r.skills = r.skills.slice(0, MAX_PER_LAYER);
  }
  const layers: LoadedSkill[] = r.skills.map((skill) => ({
    skill,
    scope,
    ...(cwd ? { cwd } : {}),
    ...(pluginId ? { pluginId } : {}),
  }));
  return { layers, diagnostics };
}

/** 全局两层（系统 + 生态·用户）缓存：不随会话变 */
const globalCache: { sig: string; entry?: { layers: LoadedSkill[]; diagnostics: string[] } } = {
  sig: "",
};
/** 工作区两层（托管 + 生态）按 cwd 缓存 */
const workspaceCache = new Map<
  string,
  { sig: string; entry: { layers: LoadedSkill[]; diagnostics: string[] } }
>();
/** 插件层按 pluginId 缓存（目录签名失效；顺序 = pluginId 排序，垫底遮蔽语义见 mergeLayers） */
const pluginCache = new Map<
  string,
  { sig: string; entry: { layers: LoadedSkill[]; diagnostics: string[] } }
>();

export type SkillsSnapshot = {
  /** 生效技能（去重遮蔽 + 开关过滤；disableModelInvocation 由提示词格式化器再滤） */
  activeSkills: Skill[];
  /** 设置页清单：全部条目，含 enabled/shadowed/editable */
  entries: SkillEntry[];
  diagnostics: string[];
};

/** 从缓存合并（无 IO）：同名遮蔽 [工作区, 生态·工作区, 系统, 生态·用户, 插件] 先见者胜 */
function mergeLayers(cwd?: string): SkillsSnapshot {
  const globalEntry = globalCache.entry ?? { layers: [], diagnostics: [] };
  const wsEntry = (cwd ? workspaceCache.get(cwd)?.entry : undefined) ?? {
    layers: [],
    diagnostics: [],
  };
  const pluginEntries = [...pluginCache.values()].map((c) => c.entry);
  const ordered = [
    ...wsEntry.layers,
    ...globalEntry.layers,
    ...pluginEntries.flatMap((e) => e.layers),
  ];
  const diagnostics = [
    ...wsEntry.diagnostics,
    ...globalEntry.diagnostics,
    ...pluginEntries.flatMap((e) => e.diagnostics),
  ];

  const winners = new Map<string, LoadedSkill>();
  const shadowedKeys = new Set<string>();
  for (const loaded of ordered) {
    const norm = normalizeSkillName(loaded.skill.name);
    const key = skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId);
    if (winners.has(norm)) {
      shadowedKeys.add(key);
      continue;
    }
    winners.set(norm, loaded);
  }

  const entries: SkillEntry[] = ordered.map((loaded) => {
    const key = skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId);
    return {
      name: loaded.skill.name,
      description: loaded.skill.description,
      scope: loaded.scope,
      enabled: state.disabled[key] !== true,
      shadowed: shadowedKeys.has(key),
      editable: (loaded.scope === "system" || loaded.scope === "workspace") && !loaded.pluginId,
      path: loaded.skill.filePath,
      content: loaded.skill.content,
      sizeBytes: fileSizeOf(loaded.skill.filePath),
      updatedAt: fileTimeOf(loaded.skill.filePath),
      ...(loaded.pluginId ? { pluginId: loaded.pluginId } : {}),
      ...(loaded.skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
    };
  });

  const activeSkills = [...winners.values()]
    .filter(
      (loaded) =>
        state.disabled[
          skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId)
        ] !== true,
    )
    .map((loaded) => loaded.skill);

  return { activeSkills, entries, diagnostics };
}

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileTimeOf(path: string): string {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return "";
  }
}

/**
 * 刷新缓存（幂等）：全局两层按签名、工作区两层按 cwd+签名。
 * resolveSession 组装提示词前必须 await 本函数预热，skillsPromptBlock 才有数可读。
 */
export async function ensureSkillsLoaded(cwd?: string): Promise<void> {
  await initSkillsState();
  const systemDir = systemSkillsDir();
  const compatDir = compatHomeSkillsDir();
  const globalSig = `${systemDir}|${dirSignature(systemDir)}|${compatDir}|${dirSignature(compatDir)}`;
  if (globalCache.sig !== globalSig || !globalCache.entry) {
    const [system, compat] = await Promise.all([
      loadSkillLayer(systemDir, "system", undefined),
      loadSkillLayer(compatDir, "compat", undefined),
    ]);
    globalCache.sig = globalSig;
    globalCache.entry = {
      layers: [...system.layers, ...compat.layers],
      diagnostics: [...system.diagnostics, ...compat.diagnostics],
    };
  }
  if (cwd) {
    const wsDir = workspaceSkillsDir(cwd);
    const compatWsDir = compatWorkspaceSkillsDir(cwd);
    const sig = `${dirSignature(wsDir)}|${dirSignature(compatWsDir)}`;
    const cached = workspaceCache.get(cwd);
    if (!cached || cached.sig !== sig) {
      const [managed, compat] = await Promise.all([
        loadSkillLayer(wsDir, "workspace", cwd),
        loadSkillLayer(compatWsDir, "compat-workspace", cwd),
      ]);
      workspaceCache.set(cwd, {
        sig,
        entry: {
          layers: [...managed.layers, ...compat.layers],
          diagnostics: [...managed.diagnostics, ...compat.diagnostics],
        },
      });
    }
  }
  // 插件层（全局，垫底）：逐启用插件加载其技能目录；签名含插件清单以感知安装/卸载/更新
  const pluginLayers = activePlugins().filter((p) => {
    const dir = resolvePluginComponent(p.manifest, "skills");
    return dir ? existsSync(dir) : false;
  });
  const liveIds = new Set(pluginLayers.map((p) => p.pluginId));
  for (const staleId of [...pluginCache.keys()].filter((id) => !liveIds.has(id))) {
    pluginCache.delete(staleId);
  }
  for (const plugin of pluginLayers) {
    const dir = resolvePluginComponent(plugin.manifest, "skills") as string;
    const sig = `${dirSignature(dir)}|${plugin.version}|${plugin.installedAt}`;
    const cached = pluginCache.get(plugin.pluginId);
    if (cached && cached.sig === sig) continue;
    const loaded = await loadSkillLayer(dir, "plugin", undefined, plugin.pluginId);
    pluginCache.set(plugin.pluginId, { sig, entry: loaded });
  }
}

/** 同步读缓存快照（供 skillsPromptBlock / settings 清单；未预热时返回空档） */
export function skillsSnapshot(cwd?: string): SkillsSnapshot {
  return mergeLayers(cwd && cwd.trim() ? cwd.trim() : undefined);
}

/** 库目录段的"读文件加载"指引 → 改指 use_skill 工具（专属回执带技能目录锚点，
 *  前端也能渲染成「调用技能」行）。按整句精确替换：库文案变了就替换不中，
 *  退化为旧的 read 语义（功能不受损，只是少了专属渲染），不报错。 */
const SKILL_READ_LINE = "Read the full skill file when the task matches its description.";
const SKILL_USE_LINE =
  "When the task matches a skill's description, call the use_skill tool with that skill's <name> to load its full instructions; do not read the skill file with the read tool.";

/** 系统提示词的技能目录段：无生效技能返回空串（默认提示词字节级不变） */
export function skillsPromptBlock(cwd: string): string {
  const block = formatSkillsForSystemPrompt(skillsSnapshot(cwd).activeSkills);
  if (!block) return "";
  return block.split(SKILL_READ_LINE).join(SKILL_USE_LINE);
}

// ---------------------------------------------------------------------------
// 运行时状态（启用开关），整包 SQLite kv
// ---------------------------------------------------------------------------

export type SkillsState = {
  /** stateKey -> 被显式关闭 */
  disabled: Record<string, true>;
};

export const SKILLS_STATE_KV_KEY = "pi.skills";

let state: SkillsState = { disabled: {} };
let stateLoad: Promise<void> | undefined;

function emptyState(): SkillsState {
  return { disabled: {} };
}

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initSkillsState(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(SKILLS_STATE_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as Partial<SkillsState>;
      state = { disabled: (parsed.disabled ?? {}) as Record<string, true> };
    } catch (err) {
      logErr("skills-state:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

async function persistState(): Promise<void> {
  try {
    await kvSet(SKILLS_STATE_KV_KEY, JSON.stringify(state));
  } catch (err) {
    logErr("skills-state save:", err instanceof Error ? err.message : String(err));
  }
}

/** 测试钩子：清掉 kv 装载与目录缓存，回到全默认状态 */
export function resetSkillsForTest(): void {
  state = emptyState();
  stateLoad = undefined;
  globalCache.sig = "";
  globalCache.entry = undefined;
  workspaceCache.clear();
  pluginCache.clear();
}

export async function setSkillEnabled(
  scope: SkillScope,
  name: string,
  enabled: boolean,
  cwd?: string,
  pluginId?: string,
): Promise<void> {
  await initSkillsState();
  const key = skillStateKey(scope, name, cwd, pluginId);
  if (enabled) delete state.disabled[key];
  else state.disabled[key] = true;
  await persistState();
}

/** 批量开关单次条目上限（设置页一个页签最多几百条） */
export const MAX_SKILL_BATCH_TARGETS = 512;

/**
 * 批量开关：把一批 (scope, name) 条目直接置为目标状态（重复条目天然幂等），
 * 只落一次盘。cwd 仅参与工作区两层（workspace / compat-workspace）的 stateKey，
 * 与单条开关同一套键规则。
 */
export async function setSkillsEnabled(
  targets: Array<{ scope: SkillScope; name: string; pluginId?: string }>,
  enabled: boolean,
  cwd?: string,
): Promise<void> {
  if (targets.length === 0) return;
  if (targets.length > MAX_SKILL_BATCH_TARGETS) {
    throw new Error(`setSkillsEnabled: too many targets (max ${MAX_SKILL_BATCH_TARGETS})`);
  }
  await initSkillsState();
  for (const t of targets) {
    const key = skillStateKey(t.scope, t.name, cwd, t.pluginId);
    if (enabled) delete state.disabled[key];
    else state.disabled[key] = true;
  }
  await persistState();
}

/**
 * 插件技能组件清单（插件详情页用）：加载指定目录并叠加当前开关状态。
 * 与合并链共用 loadSkillLayer（同一校验/上限），scope 恒为 "plugin"。
 */
export async function listPluginSkillEntries(
  dir: string,
  pluginId: string,
): Promise<Array<{ name: string; description: string; enabled: boolean; path: string }>> {
  await initSkillsState();
  const { layers } = await loadSkillLayer(dir, "plugin", undefined, pluginId);
  return layers.map((l) => ({
    name: l.skill.name,
    description: l.skill.description,
    enabled: state.disabled[skillStateKey("plugin", l.skill.name, undefined, pluginId)] !== true,
    path: l.skill.filePath,
  }));
}

// ---------------------------------------------------------------------------
// 文档解析 / 渲染（frontmatter + 正文）
// ---------------------------------------------------------------------------

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 解析一份技能文档（导入路径与加载校验共用同一 frontmatter 规则）。
 * frontmatter 用 yaml 包解析（与 pi-agent-core loadSkills 一致，支持块标量）。
 */
export function parseSkillDoc(
  raw: string,
  options: { fallbackName?: string } = {},
): { ok: true; draft: SkillDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let name = "";
  let description = "";
  let disableModelInvocation = false;
  let body = raw;
  const m = FRONT_MATTER_RE.exec(raw);
  if (m) {
    let fm: unknown;
    try {
      fm = parseYaml(m[1]);
    } catch (err) {
      return {
        ok: false,
        errors: [`frontmatter 解析失败: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    if (fm !== null && typeof fm === "object" && !Array.isArray(fm)) {
      const r = fm as Record<string, unknown>;
      if (typeof r.name === "string") name = r.name.trim();
      if (typeof r.description === "string") description = r.description.trim();
      if (r["disable-model-invocation"] === true) disableModelInvocation = true;
    }
    body = raw.slice(m[0].length);
  }
  if (!name && options.fallbackName) name = options.fallbackName.trim();
  body = body.trim();
  if (!name) errors.push("缺少 name（frontmatter 或文件名兜底）");
  if (!description) errors.push("缺少 description（模型据此判断何时使用该技能）");
  if (!body) errors.push("正文为空");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`description 超过 ${MAX_DESCRIPTION_CHARS} 字符（${description.length}）`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name,
      description,
      content: body,
      ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
    },
  };
}

/** 渲染一份技能文档：frontmatter（yaml 序列化保证引号/多行安全）+ 正文 */
export function renderSkillDoc(draft: SkillDraft): string {
  const fm = stringifyYaml({
    name: draft.name,
    description: draft.description,
    ...(draft.disableModelInvocation ? { "disable-model-invocation": true } : {}),
  });
  return `---\n${fm}---\n\n${draft.content.trim()}\n`;
}

// ---------------------------------------------------------------------------
// 写路径（设置页 → 系统/工作区目录）
// ---------------------------------------------------------------------------

/** 技能名 → 文件名（沿用子智能体的宽松规则：保留非 ASCII，仅替换非法字符） */
export function skillFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[:<>"/\\?*|\s\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS);
  return `${slug || "skill"}.md`;
}

function validateSkillDraft(draft: SkillDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("名称不能为空");
  if (draft.name.trim().length > MAX_NAME_CHARS) {
    errors.push(`名称不能超过 ${MAX_NAME_CHARS} 字符`);
  }
  if (!draft.description.trim()) errors.push("描述不能为空（模型据此决定何时使用）");
  if (draft.description.trim().length > MAX_DESCRIPTION_CHARS) {
    errors.push(`描述不能超过 ${MAX_DESCRIPTION_CHARS} 字符`);
  }
  if (!draft.content.trim()) errors.push("正文不能为空");
  if (Buffer.byteLength(renderSkillDoc(draft), "utf8") > MAX_SKILL_BYTES) {
    errors.push(`文档超过 ${Math.floor(MAX_SKILL_BYTES / 1024)} KB 上限`);
  }
  return errors;
}

export type SkillWriteOptions = {
  /** workspace 层必填：所属工作区 cwd */
  cwd?: string;
  /** 测试注入：覆盖系统目录解析（workspace 层忽略） */
  systemDir?: string;
  /** 编辑时改名：旧名对应的本层文件一并删除 */
  replaceName?: string;
};

/**
 * 保存（新增或同名覆盖）一份系统/工作区技能。
 * 与子智能体不同，跨层同名允许（工作区遮蔽系统是刻意支持的项目定制路径，
 * 生态目录只读更拦不住）；同层同名 = 覆盖旧文件。
 */
export async function saveSkillDoc(
  scope: "system" | "workspace",
  draft: SkillDraft,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd, replaceName } = options;
  const errors = validateSkillDraft(draft);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const norm = normalizeSkillName(draft.name);

  const dir =
    scope === "system"
      ? options.systemDir ?? systemSkillsDir()
      : workspaceSkillsDir(cwd ?? homedir());
  const filePath = join(dir, skillFileName(draft.name));
  const replaceNorm = replaceName ? normalizeSkillName(replaceName) : undefined;
  // 同名编辑 = 覆盖本层同名文件（可能文件名 slug 不同）；改名编辑再清掉旧名文件
  if (existsSync(dir)) {
    for (const existing of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
      const full = join(dir, existing);
      if (full === filePath) continue;
      try {
        const parsed = parseSkillDoc(readFileSync(full, "utf8"), {
          fallbackName: basename(existing).replace(/\.md$/i, ""),
        });
        const existingNorm = parsed.ok
          ? normalizeSkillName(parsed.draft.name)
          : normalizeSkillName(basename(existing).replace(/\.md$/i, ""));
        if (existingNorm === norm || (replaceNorm && existingNorm === replaceNorm)) {
          unlinkSync(full);
        }
      } catch {
        // 坏文件交给诊断路径处理，不挡保存
      }
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, renderSkillDoc(draft), "utf8");
}

/** 删除一份系统/工作区技能（生态目录只读不可删）。清同名文件并清开关残留。 */
export async function deleteSkillDoc(
  scope: "system" | "workspace",
  name: string,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd } = options;
  const dir =
    scope === "system"
      ? options.systemDir ?? systemSkillsDir()
      : workspaceSkillsDir(cwd ?? homedir());
  const norm = normalizeSkillName(name);
  let removed = false;
  if (existsSync(dir)) {
    for (const fileName of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
      const full = join(dir, fileName);
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillDoc(raw, {
        fallbackName: basename(fileName).replace(/\.md$/i, ""),
      });
      const fileNorm = parsed.ok
        ? normalizeSkillName(parsed.draft.name)
        : normalizeSkillName(basename(fileName).replace(/\.md$/i, ""));
      if (fileNorm === norm) {
        unlinkSync(full);
        removed = true;
      }
    }
  }
  if (!removed) throw new Error(`未找到 ${scope === "system" ? "系统" : "工作区"}技能 "${name}"`);
  await setSkillEnabled(scope, name, true, cwd).catch(() => {});
}
