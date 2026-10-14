/**
 * 密钥库（设置 → 密钥）：加密存储的密钥 + 执行时按需注入 bash 的绑定策略。
 * 设计：docs/secrets-env-design.md。
 *
 * 本模块只处理**名字**与策略，从不持有明文：
 * - 值的写入（save_secret）与清单读取（list_secrets）都经 hostdb 转 Rust，
 *   加密/解密/掩码全在 Rust 侧完成，明文不跨 RPC 边界。
 * - 本模块产出的是"这次 bash 该注入哪些名字"（resolveSecretEnv），Rust 拿到名字
 *   后自己查库解密注入，并在输出回程前脱敏。
 *
 * 绑定声明权在用户：技能 frontmatter 不能声明自己要密钥（社区技能/插件装上
 * 即失窃的风险），只能由用户在设置页勾选把哪个密钥授给哪个技能。
 * 默认拒绝：没列进 bindings 的密钥永不注入；空技能列表 = 不注入，"*" = 任意
 * bash 调用可用。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { normalizeSkillName } from "../skills/skills";
import { logErr } from "../log";

export const SECRETS_KV_KEY = "pi.secrets";

/** 作用域层级：global = 所有工作区；workspace = 仅当前工作区（展开为 workspace:<cwd>） */
export type SecretScopeLevel = "global" | "workspace";

/** 一条绑定：把某个密钥授给哪些技能 */
export type SecretBinding = {
  name: string;
  /**
   * v1 设置页只写 "global"；"workspace" 由配置手写启用（解析已支持，
   * 展开成 workspace:<cwd>，Rust 侧同名时工作区行覆盖全局行）。
   */
  scope: SecretScopeLevel;
  /** 技能名（按 normalizeSkillName 归一比较）；["*"] = 任意 bash 调用 */
  skills: string[];
};

export type SecretsConfig = {
  /** 总开关：关闭时任何 bash 调用都不注入（紧急刹车） */
  enabled: boolean;
  bindings: SecretBinding[];
};

export const DEFAULT_SECRETS_CONFIG: SecretsConfig = {
  enabled: true,
  bindings: [],
};

/** 单条绑定的技能白名单上限（防失控配置） */
const MAX_BINDINGS = 64;
const MAX_SKILLS_PER_BINDING = 32;

/** 密钥名规则：与 Rust data.rs is_valid_secret_name / MCP ENV_KEY_RE 同款 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && SECRET_NAME_RE.test(name);
}

/** 工作区作用域的展开形式（Rust 表的 scope 列原样存这个串） */
export function workspaceScope(cwd: string): string {
  return `workspace:${cwd}`;
}

/** 任意来源（kv JSON / 协议消息）的宽松规整：坏条目剔除，不整体失败 */
export function normalizeSecretsConfig(raw: unknown): SecretsConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bindings: SecretBinding[] = [];
  const list = Array.isArray(r.bindings) ? r.bindings : [];
  for (const item of list.slice(0, MAX_BINDINGS)) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!isValidSecretName(name)) continue;
    const skills = (Array.isArray(b.skills) ? b.skills : [])
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, MAX_SKILLS_PER_BINDING)
      .map((s) => (s.trim() === "*" ? "*" : normalizeSkillName(s)));
    bindings.push({
      name,
      scope: b.scope === "workspace" ? "workspace" : "global",
      skills,
    });
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_SECRETS_CONFIG.enabled,
    bindings,
  };
}

let current: SecretsConfig = { ...DEFAULT_SECRETS_CONFIG };

export function getSecretsConfig(): SecretsConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initSecretsConfig(): Promise<void> {
  try {
    const row = await kvGet(SECRETS_KV_KEY);
    if (row?.value) current = normalizeSecretsConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("secrets: config load failed:", err);
  }
}

/** 应用新配置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applySecretsConfig(raw: unknown): Promise<SecretsConfig> {
  const next = normalizeSecretsConfig(raw);
  current = next;
  try {
    await kvSet(SECRETS_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("secrets: config persist failed:", err);
  }
  return next;
}

/** 测试辅助：仅清内存不落 kv */
export function resetSecretsForTest(): void {
  current = { ...DEFAULT_SECRETS_CONFIG };
  loadedSkillsByThread.clear();
}

/* ------------------------ 已加载技能台账（按线程） ------------------------ */

/**
 * 会话内"模型加载过哪些技能"。注入判定的另一半：绑定把密钥授给技能，
 * 这里记的是"当前上下文里真的出现了那个技能"。
 *
 * 为什么按线程累积而不是按轮清空：技能跨轮生效（第 1 轮 use_skill 拿到指令，
 * 第 2 轮才跑它写的脚本）。清空时机与 todo 同款——线程被驱逐/删除时
 * （registry.forgetThreadStates），进程内的 Map 不随会话数无界增长。
 */
const loadedSkillsByThread = new Map<string, Set<string>>();

/** use_skill 加载成功后登记（幂等；名字按 normalizeSkillName 归一） */
export function noteSkillLoaded(threadId: string, skillName: string): void {
  if (!threadId) return;
  const norm = normalizeSkillName(skillName);
  if (!norm) return;
  const set = loadedSkillsByThread.get(threadId);
  if (set) set.add(norm);
  else loadedSkillsByThread.set(threadId, new Set([norm]));
}

/** 该线程已加载的技能名（归一形式） */
export function loadedSkills(threadId: string): string[] {
  return [...(loadedSkillsByThread.get(threadId) ?? [])];
}

/** 线程级状态清理（驱逐/删除时调用，与 clearTodoState 同款） */
export function clearLoadedSkills(threadId: string): void {
  loadedSkillsByThread.delete(threadId);
}

/* ------------------------------ 注入解析 ------------------------------ */

export type SecretRequest = { name: string; scope: string };

/**
 * 解析本次 bash 调用该注入哪些密钥（**只有名字与作用域串，无值**）。
 *
 * 命中规则：总开关开 且 绑定列的技能里有 "*" 或该线程已加载的技能之一。
 * 空技能列表 = 不注入（默认拒绝）。同名的多条绑定按第一条命中为准。
 *
 * 返回值交给 host 信封的 secretEnv；Rust 侧按 (name, scope) 查库解密
 * （scope 未命中时回落 global），注入派生进程并在输出回程前脱敏。
 */
export function resolveSecretEnv(cwd: string, threadId: string): SecretRequest[] {
  if (!current.enabled) return [];
  const bindings = current.bindings;
  if (bindings.length === 0) return [];
  const loaded = new Set(loadedSkills(threadId));
  const out: SecretRequest[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (binding.skills.length === 0) continue;
    const granted =
      binding.skills.includes("*") || binding.skills.some((s) => loaded.has(s));
    if (!granted) continue;
    if (seen.has(binding.name)) continue;
    seen.add(binding.name);
    out.push({
      name: binding.name,
      scope: binding.scope === "workspace" ? workspaceScope(cwd) : "global",
    });
  }
  return out;
}
