/**
 * 技能来源分层发现与合并：工作区 > 生态·工作区 > 系统 > 生态·用户 > 插件，
 * 同名前层遮蔽后层。加载走 pi-agent-core 的 loadSkills（NodeExecutionEnv），
 * 缓存按目录树签名（frontmatter 改动失效；正文改动不影响提示词）。
 * 启用开关判定见 state.ts，文档写路径见 docs.ts。
 */
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from "../vendor/pi-harness/skills";
import { activePlugins, resolvePluginComponents } from "../plugins/plugins";
import { externalSkillDirs } from "../agent/external-dirs";
import {
  initSkillsState,
  isSkillDisabled,
  normalizeSkillName,
  skillStateKey,
  type SkillScope,
} from "./state";

/** 一条技能：库加载产物 + 来源层（cwd 供工作区层 stateKey 反推；pluginId 供插件层 stateKey 构造） */
/** 生态用户目录里由本应用安装的技能标记（技能目录内文件）：设置页据此只放开删除 */
export const COMPAT_MANAGED_MARKER = ".kova-managed";

export type LoadedSkill = {
  skill: Skill;
  scope: SkillScope;
  cwd?: string;
  pluginId?: string;
  /** 插件技能命名空间（插件清单 name）；非插件层缺省 */
  namespace?: string;
  /** 插件技能的 `plugin:skill` 全名；非插件层缺省 */
  qualifiedName?: string;
  /** 生态层且含 COMPAT_MANAGED_MARKER：本应用安装，可在设置页删除 */
  managed?: boolean;
};

/** 设置页展示条目：加载产物 + 生效状态 */
export type SkillEntry = {
  name: string;
  /** 插件技能全名 `<plugin>:<skill>`；非插件层缺省 */
  qualifiedName?: string;
  /** 插件技能命名空间；非插件层缺省 */
  namespace?: string;
  description: string;
  scope: SkillScope;
  /** 开关（kv 决定；未记录 = 启用） */
  enabled: boolean;
  /** 被更高优先级同名技能遮蔽：enabled 但不生效 */
  shadowed: boolean;
  /** 生态目录：设置页只读（不可编辑/删除，只能开关）；市场安装可写入用户层 */
  editable: boolean;
  /** 生态层由本应用安装（含托管标记）：设置页允许删除（编辑仍关闭，避免丢附属文件） */
  managed?: boolean;
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

// ---------------------------------------------------------------------------
// 目录解析
// ---------------------------------------------------------------------------

/** 系统级技能目录（应用数据目录下，与 state.db / subagents 同族） */
export function systemSkillsDir(): string {
  if (process.env.PI_SKILLS_DIR) return process.env.PI_SKILLS_DIR;
  const db = process.env.PI_DB_PATH;
  if (db) return join(dirname(resolve(db)), "skills");
  return join(homedir(), ".kova", "skills");
}

/** 工作区级技能目录（本应用托管层） */
export function workspaceSkillsDir(cwd: string): string {
  return join(cwd, ".kova", "skills");
}

/** 生态·用户技能目录（agentskills.io 标准；市场「安装到生态目录」写这里，
 *  设置页仍只读；测试经 PI_COMPAT_SKILLS_DIR 钉住） */
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
export const MAX_PER_LAYER = 64;

/**
 * 嵌套目录场景的文件树签名：只看会改变发现结果的条目（目录、Markdown、
 * 忽略文件），并先列完当前层再下钻。
 *
 * 旧实现按深度优先遍历、全局 512 条封顶：技能包常带几十 MB 资产，第一个
 * 大技能包（如 design-taste-frontend）就能吃满预算，后面兄弟目录的增删改
 * 永远进不了签名——安装新技能不触发重载，表现为"技能文件明明在、清单里
 * 没有"。广度优先保证同层兄弟先全部入签名；图片/脚本等资产不计入签名，
 * Markdown 仍按 mtime 纳入（frontmatter 变更必须失效；正文顺带重扫，代价
 * 可忽略）。
 */
const SIGNATURE_MAX_ENTRIES = 512;
/** 与 vendor/pi-harness/skills.ts 的 IGNORE_FILE_NAMES 保持一致 */
const SIGNATURE_IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"]);

function dirSignature(dir: string): string {
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  const queue: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: "" }];
  while (queue.length > 0 && out.length <= SIGNATURE_MAX_ENTRIES) {
    const current = queue.shift();
    if (!current) break;
    let names: string[];
    try {
      names = readdirSync(current.abs).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const isIgnoreFile = SIGNATURE_IGNORE_FILES.has(name);
      if (name === "node_modules" || (name.startsWith(".") && !isIgnoreFile)) continue;
      const full = join(current.abs, name);
      const relPath = current.rel ? `${current.rel}/${name}` : name;
      try {
        const st = statSync(full);
        const isDir = st.isDirectory();
        // 目录用于感知增删/改名；Markdown 是技能定义与正文的落点；忽略文件
        // 决定哪些路径可见；agents/openai.yaml 携带 Codex 技能策略（隐式调用
        // 开关/依赖声明），内容变化必须让缓存失效。其余资产变化不影响发现，
        // 不计入签名，避免大技能包吃满预算把后面的兄弟目录挤出去。
        if (
          !isDir &&
          !isIgnoreFile &&
          !name.endsWith(".md") &&
          name !== "openai.yaml"
        ) {
          continue;
        }
        out.push(`${relPath}:${Math.round(st.mtimeMs)}:${isDir ? "d" : st.size}`);
        if (isDir) queue.push({ abs: full, rel: relPath });
        if (out.length > SIGNATURE_MAX_ENTRIES) break;
      } catch {
        // 并发删除的条目忽略：下次签名自然收敛
      }
    }
  }
  return out.join("|");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Codex 技能元数据 `agents/openai.yaml`（机器可读，不属于 SKILL.md）：
 * - `policy.allow_implicit_invocation: false` → 不进入模型目录，只能显式 `$skill`；
 *   本应用映射为 disableModelInvocation（设置页仍可见可开关）；
 * - `dependencies.tools` 当前只做诊断提示（M3 才考虑自动安装/MCP 依赖解析）。
 */
function applyOpenAiSkillMetadata(skill: Skill, diagnostics: string[]): void {
  const file = join(dirname(skill.filePath), "agents", "openai.yaml");
  if (!existsSync(file)) return;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    diagnostics.push(
      `${file}: 解析失败（${err instanceof Error ? err.message : String(err)}）`,
    );
    return;
  }
  if (!isPlainRecord(doc)) {
    diagnostics.push(`${file}: 顶层必须是对象`);
    return;
  }
  const policy = doc.policy;
  if (isPlainRecord(policy) && policy.allow_implicit_invocation === false) {
    skill.disableModelInvocation = true;
  }
  const dependencies = doc.dependencies;
  const tools =
    isPlainRecord(dependencies) && Array.isArray(dependencies.tools)
      ? dependencies.tools.filter(isPlainRecord)
      : [];
  if (tools.length > 0) {
    const names = tools
      .slice(0, 8)
      .map((tool) => {
        const value = typeof tool.value === "string" ? tool.value.trim() : "";
        const type = typeof tool.type === "string" ? tool.type.trim() : "";
        return value || type || "未命名";
      })
      .join("、");
    diagnostics.push(
      `${file}: 技能 "${skill.name}" 声明依赖工具 ${names}（当前仅提示，不自动安装）`,
    );
  }
}

async function loadSkillLayer(
  dir: string,
  scope: SkillScope,
  cwd: string | undefined,
  pluginId?: string,
): Promise<{ layers: LoadedSkill[]; diagnostics: string[] }> {
  const r = await loadSkills(dir);
  const diagnostics = r.diagnostics.map(
    (d) => `${dir}: ${d.message} (${d.path})`,
  );
  for (const skill of r.skills) applyOpenAiSkillMetadata(skill, diagnostics);
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
    ...(scope === "compat" &&
    existsSync(join(dirname(skill.filePath), COMPAT_MANAGED_MARKER))
      ? { managed: true }
      : {}),
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
/** 会话外部目录层按目录缓存（`.kova/skills` / `.agents/skills` / `.claude/skills` 合并） */
const externalCache = new Map<
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

/** 从缓存合并（无 IO）：同名遮蔽 [工作区, 外部目录, 系统, 生态·用户, 插件] 先见者胜。
 *  externalDirs 缺省 = 不并入外部层（设置页清单不应被某个会话的临时目录污染）。 */
function mergeLayers(cwd?: string, externalDirs?: readonly string[]): SkillsSnapshot {
  const globalEntry = globalCache.entry ?? { layers: [], diagnostics: [] };
  const wsEntry = (cwd ? workspaceCache.get(cwd)?.entry : undefined) ?? {
    layers: [],
    diagnostics: [],
  };
  const externalEntries = (externalDirs ?? [])
    .map((dir) => externalCache.get(dir)?.entry)
    .filter((entry): entry is { layers: LoadedSkill[]; diagnostics: string[] } => Boolean(entry));
  const pluginEntries = [...pluginCache.values()].map((c) => c.entry);
  const ordered = [
    ...wsEntry.layers,
    ...externalEntries.flatMap((e) => e.layers),
    ...globalEntry.layers,
    ...pluginEntries.flatMap((e) => e.layers),
  ];
  const diagnostics = [
    ...wsEntry.diagnostics,
    ...externalEntries.flatMap((e) => e.diagnostics),
    ...globalEntry.diagnostics,
    ...pluginEntries.flatMap((e) => e.diagnostics),
  ];

  // 身份键：普通技能用裸名互相遮蔽；插件技能带 pluginId 命名空间，跨插件同名
  // 技能共存（Codex 的 `plugin:skill` 语义）。普通技能与插件技能也不互相遮蔽，
  // 裸名解析时由 use_skill 优先普通技能。
  const identityOf = (loaded: LoadedSkill): string => {
    const bare = normalizeSkillName(loaded.skill.name);
    return loaded.scope === "plugin" && loaded.pluginId
      ? `plugin:${loaded.pluginId}:${bare}`
      : `bare:${bare}`;
  };
  const winners = new Map<string, LoadedSkill>();
  const shadowedKeys = new Set<string>();
  for (const loaded of ordered) {
    const identity = identityOf(loaded);
    const key = skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId);
    if (winners.has(identity)) {
      shadowedKeys.add(key);
      continue;
    }
    winners.set(identity, loaded);
  }

  const entries: SkillEntry[] = ordered.map((loaded) => {
    const key = skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId);
    return {
      name: loaded.skill.name,
      ...(loaded.qualifiedName ? { qualifiedName: loaded.qualifiedName } : {}),
      ...(loaded.namespace ? { namespace: loaded.namespace } : {}),
      description: loaded.skill.description,
      scope: loaded.scope,
      enabled: !isSkillDisabled(key),
      shadowed: shadowedKeys.has(key),
      editable: (loaded.scope === "system" || loaded.scope === "workspace") && !loaded.pluginId,
      ...(loaded.managed ? { managed: true } : {}),
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
        !isSkillDisabled(
          skillStateKey(loaded.scope, loaded.skill.name, loaded.cwd, loaded.pluginId),
        ),
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
 * 刷新缓存（幂等）：全局两层按签名、工作区两层按 cwd+签名、外部目录按目录签名。
 * resolveSession 组装提示词前必须 await 本函数预热，skillsPromptBlock 才有数可读。
 *
 * externalDirs 的 undefined 与 [] 语义不同：
 * - undefined = 本次调用不涉及外部目录（设置页清单等），不加载也不修剪外部缓存；
 * - [] / 具体清单 = 该会话的外部目录全集，按它加载并清掉不再引用的缓存。
 */
export async function ensureSkillsLoaded(
  cwd?: string,
  externalDirs?: readonly string[],
): Promise<void> {
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
  if (externalDirs !== undefined) {
    const seen = new Set<string>();
    for (const rawDir of externalDirs) {
      const dir = rawDir.trim();
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      const sig = externalSkillDirs(dir)
        .map((skillsDir) => `${skillsDir}|${dirSignature(skillsDir)}`)
        .join("|");
      const cached = externalCache.get(dir);
      if (cached && cached.sig === sig) continue;
      const layers = await Promise.all(
        externalSkillDirs(dir).map((skillsDir) =>
          loadSkillLayer(skillsDir, "external", dir),
        ),
      );
      externalCache.set(dir, {
        sig,
        entry: {
          layers: layers.flatMap((layer) => layer.layers),
          diagnostics: layers.flatMap((layer) => layer.diagnostics),
        },
      });
    }
    // 刻意不按本次清单修剪：externalCache 是进程级共享的，而每个 run 的清单
    // 不同（多个会话各自挂载不同目录）。按单次调用修剪会删掉别的会话仍需要的
    // 条目，表现为「切换一轮后外部技能从提示词里消失」。条目按目录去重，
    // 数量受每会话上限约束，留热缓存的代价远小于这个 bug。
  }
  // 插件层（全局，垫底）：逐启用插件加载其技能目录；签名含插件清单以感知安装/卸载/更新。
  // 生态清单支持多个 skills 根（Codex string array），逐个加载后按 pluginId 聚合。
  const pluginLayers = activePlugins()
    .map((plugin) => ({
      plugin,
      dirs: resolvePluginComponents(plugin.manifest, "skills").filter((dir) => existsSync(dir)),
    }))
    .filter((entry) => entry.dirs.length > 0);
  const liveIds = new Set(pluginLayers.map((entry) => entry.plugin.pluginId));
  for (const staleId of [...pluginCache.keys()].filter((id) => !liveIds.has(id))) {
    pluginCache.delete(staleId);
  }
  for (const { plugin, dirs } of pluginLayers) {
    const sig = `${dirs.map((dir) => dirSignature(dir)).join("|")}|${plugin.version}|${plugin.installedAt}`;
    const cached = pluginCache.get(plugin.pluginId);
    if (cached && cached.sig === sig) continue;
    const loaded = await Promise.all(
      dirs.map((dir) => loadSkillLayer(dir, "plugin", undefined, plugin.pluginId)),
    );
    const namespace = plugin.manifest.name;
    const layers = loaded.flatMap((layer) => layer.layers).map((layer) => {
      const qualifiedName = `${namespace}:${layer.skill.name}`;
      return {
        ...layer,
        namespace,
        qualifiedName,
        skill: { ...layer.skill, qualifiedName },
      };
    });
    pluginCache.set(plugin.pluginId, {
      sig,
      entry: {
        layers,
        diagnostics: loaded.flatMap((layer) => layer.diagnostics),
      },
    });
  }
}

/** 同步读缓存快照（供 skillsPromptBlock / settings 清单；未预热时返回空档） */
export function skillsSnapshot(
  cwd?: string,
  externalDirs?: readonly string[],
): SkillsSnapshot {
  return mergeLayers(
    cwd && cwd.trim() ? cwd.trim() : undefined,
    externalDirs,
  );
}

/** 库目录段的"读文件加载"指引 → 改指 use_skill 工具（专属回执带技能目录锚点，
 *  前端也能渲染成「调用技能」行）。按整句精确替换：库文案变了就替换不中，
 *  退化为旧的 read 语义（功能不受损，只是少了专属渲染），不报错。 */
const SKILL_READ_LINE = "Read the full skill file when the task matches its description.";
const SKILL_USE_LINE =
  "When the task matches a skill's description, call the use_skill tool with that skill's <name> to load its full instructions; do not read the skill file with the read tool.";

/** 系统提示词里技能目录段的总字节预算：技能再多也不能无限挤占上下文 */
const SKILLS_PROMPT_BYTE_BUDGET = 16_000;
/** 单条 description 的字符上限（与同类实现的目录段口径一致） */
export const SKILL_DESCRIPTION_MAX_CHARS = 250;
/** 插件技能 description 上限：Codex 技能常把触发场景写在长描述尾部 */
export const PLUGIN_SKILL_DESCRIPTION_MAX_CHARS = 400;
/** 省略名单最多展示多少个技能名（超出只报数量） */
const SKILL_OMITTED_NAMES_MAX = 64;
/** 插件技能在目录段的保底预算：普通技能再多也不能把插件层全部挤掉 */
const PLUGIN_SKILL_PROMPT_MIN_BYTES = 4_000;

/** 按 code point 截断：`slice` 以 UTF-16 单元计，会把 emoji 的代理对切半 */
function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * 目录段预算：先按字符截断 description（保留全部技能名），仍超预算则从尾部
 * （优先级最低的插件层）整条丢弃，返回省略名单供调用方告知模型仍可按名加载。
 *
 * 顺序由 mergeLayers 决定（工作区 → 外部 → 系统 → 插件），这里不再排序——
 * 排序规则若两处各写一份，遮蔽关系与展示顺序迟早会漂。
 */
export function budgetSkillsForPrompt(
  skills: readonly Skill[],
  budgetBytes: number = SKILLS_PROMPT_BYTE_BUDGET,
): { skills: Skill[]; omitted: string[] } {
  const truncated = skills.map((skill) => ({
    ...skill,
    description: truncateChars(
      skill.description,
      skill.qualifiedName ? PLUGIN_SKILL_DESCRIPTION_MAX_CHARS : SKILL_DESCRIPTION_MAX_CHARS,
    ),
  }));
  // 目录顺序是「普通层 → 插件层」。按尾部落条目时插件层会先被牺牲；这里先给
  // 插件层留出最多 4KB 的保底预算，普通技能只能在剩余预算里裁尾，避免大量
  // 工作区/系统技能把 Codex 插件技能全部挤掉。
  const pluginSkills = truncated.filter((skill) => Boolean(skill.qualifiedName));
  const regularSkills = truncated.filter((skill) => !skill.qualifiedName);
  const pluginBytes = Buffer.byteLength(
    formatSkillsForSystemPrompt(pluginSkills),
    "utf8",
  );
  const pluginReserve = Math.min(pluginBytes, PLUGIN_SKILL_PROMPT_MIN_BYTES);
  const regularBudget = Math.max(0, budgetBytes - pluginReserve);
  let keptRegular = regularSkills;
  while (
    keptRegular.length > 0 &&
    Buffer.byteLength(formatSkillsForSystemPrompt(keptRegular), "utf8") > regularBudget
  ) {
    keptRegular = keptRegular.slice(0, -1);
  }
  let keptPlugin = pluginSkills;
  while (
    keptPlugin.length > 0 &&
    Buffer.byteLength(
      formatSkillsForSystemPrompt([...keptRegular, ...keptPlugin]),
      "utf8",
    ) > budgetBytes
  ) {
    keptPlugin = keptPlugin.slice(0, -1);
  }
  const kept = [...keptRegular, ...keptPlugin];
  const keptSet = new Set(kept);
  return {
    skills: kept,
    // 只报"模型真能按名加载"的技能：disableModelInvocation 的条目本来就
    // 不在目录里、use_skill 也会拒绝，列进省略名单等于给模型一个假入口。
    omitted: truncated
      .filter((skill) => !keptSet.has(skill) && !skill.disableModelInvocation)
      .map((skill) => skill.qualifiedName ?? skill.name),
  };
}

/** 系统提示词的技能目录段：无生效技能返回空串（默认提示词字节级不变） */
export function skillsPromptBlock(
  cwd: string,
  externalDirs?: readonly string[],
): string {
  const active = skillsSnapshot(cwd, externalDirs).activeSkills;
  if (active.length === 0) return "";
  const { skills, omitted } = budgetSkillsForPrompt(active);
  const block = formatSkillsForSystemPrompt(skills);
  const omittedLine =
    omitted.length === 0
      ? ""
      : `(${omitted.length} more skills not listed: ${omitted
          .slice(0, SKILL_OMITTED_NAMES_MAX)
          .join(", ")}${omitted.length > SKILL_OMITTED_NAMES_MAX ? ", …" : ""}; they can still be loaded by name with use_skill)`;
  // 目录为空但存在被预算挤掉的技能（kept 恰好只剩不可模型调用的条目）时，
  // 至少要把省略名单给模型——否则它完全不知道这些技能存在。
  if (!block) return omittedLine;
  const body = block.split(SKILL_READ_LINE).join(SKILL_USE_LINE);
  return omittedLine ? `${body}\n\n${omittedLine}` : body;
}

/**
 * 插件技能组件清单（插件详情页用）：加载指定目录并叠加当前开关状态。
 * 与合并链共用 loadSkillLayer（同一校验/上限），scope 恒为 "plugin"。
 */
export async function listPluginSkillEntries(
  dir: string,
  pluginId: string,
  pluginName?: string,
): Promise<
  Array<{ name: string; qualifiedName: string; description: string; enabled: boolean; path: string }>
> {
  await initSkillsState();
  const { layers } = await loadSkillLayer(dir, "plugin", undefined, pluginId);
  const namespace = pluginName ?? pluginId.split("@")[0] ?? pluginId;
  return layers.map((l) => ({
    name: l.skill.name,
    qualifiedName: `${namespace}:${l.skill.name}`,
    description: l.skill.description,
    enabled: !isSkillDisabled(skillStateKey("plugin", l.skill.name, undefined, pluginId)),
    path: l.skill.filePath,
  }));
}

/** 缓存部分的重置（kv 状态的清理由 state.resetSkillsStateForTest 负责） */
export function clearSkillCaches(): void {
  globalCache.sig = "";
  globalCache.entry = undefined;
  workspaceCache.clear();
  pluginCache.clear();
  externalCache.clear();
}
