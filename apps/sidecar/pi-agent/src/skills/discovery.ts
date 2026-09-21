/**
 * 技能来源分层发现与合并：工作区 > 生态·工作区 > 系统 > 生态·用户 > 插件，
 * 同名前层遮蔽后层。加载走 pi-agent-core 的 loadSkills（NodeExecutionEnv），
 * 缓存按目录树签名（frontmatter 改动失效；正文改动不影响提示词）。
 * 启用开关判定见 state.ts，文档写路径见 docs.ts。
 */
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { activePlugins, resolvePluginComponent } from "../plugins/plugins";
import {
  initSkillsState,
  isSkillDisabled,
  normalizeSkillName,
  skillStateKey,
  type SkillScope,
} from "./state";

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
export const MAX_PER_LAYER = 64;

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
      enabled: !isSkillDisabled(key),
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
}
