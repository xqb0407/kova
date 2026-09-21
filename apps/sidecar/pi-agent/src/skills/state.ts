/**
 * 技能运行时状态（启用开关）：整包存 SQLite kv（key = SKILLS_STATE_KV_KEY），
 * 与子智能体/MCP 同款链路。开关是"本机的运行时决定"，不写进技能文件
 * （工作区文件在 git 里）。发现合并见 discovery.ts，文档写路径见 docs.ts。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

/** 开关状态键：生态·用户/系统按 scope:name；工作区两层按 cwd 隔离；插件层按 pluginId 命名空间 */
export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

export type SkillScope = "workspace" | "compat-workspace" | "system" | "compat" | "plugin";

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

/** 合并链的开关判定（state 本体不外泄，读写都走本模块） */
export function isSkillDisabled(key: string): boolean {
  return state.disabled[key] === true;
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

/** 状态部分的重置（目录缓存的清理由 discovery.clearSkillCaches 负责） */
export function resetSkillsStateForTest(): void {
  state = emptyState();
  stateLoad = undefined;
}
