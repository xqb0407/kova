/**
 * 访问加速设置（设置 → 系统 → 访问加速）。整包存 SQLite kv（key = KV_KEY），
 * 前端经协议 get/set_mirror 访问；工具侧每次调用实时读配置，改完即生效
 * （与 browser-config 同款机制，不按开关增删工具——工具表变更会破坏
 * Anthropic tools 块缓存）。
 *
 * 默认开：这条能力的全部意义就是「用户丢个 GitHub 地址过来，不该因为网络不通
 * 而失败」，默认关等于没做。边界写在 url-mirror.ts：只改写 GitHub 的
 * raw/发行包/源码包路径，带凭据的链接与 git push 一律不动。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";
import {
  DEFAULT_GITHUB_PREFIX,
  gitAccelEnv,
  normalizeMirrorPrefix,
  shouldAccelerateGit,
  type MirrorPolicy,
} from "./url-mirror";

export const MIRROR_KV_KEY = "pi.mirror";

export type MirrorRuleConfig = {
  /** 匹配的 URL 前缀 */
  from: string;
  /** 替换前缀 */
  to: string;
};

/** 访问加速设置整包（kv 与协议共用同一形状） */
export type MirrorConfig = {
  /** 总开关：关闭时 WebFetch 不与镜像、bash 不注入 git 加速 */
  enabled: boolean;
  /** GitHub 加速前缀（ghproxy 系）。空串 = 不改写 GitHub，只用自定义规则 */
  githubPrefix: string;
  /** bash 里 git clone/fetch 走镜像（insteadOf 环境变量）；push 始终不受影响 */
  gitInsteadOf: boolean;
  /** 自定义 from→to 规则，优先于内建 GitHub 规则 */
  customRules: MirrorRuleConfig[];
};

export const DEFAULT_MIRROR_CONFIG: MirrorConfig = {
  enabled: true,
  githubPrefix: DEFAULT_GITHUB_PREFIX,
  gitInsteadOf: true,
  customRules: [],
};

/**
 * 任意来源（kv JSON / 协议消息）的宽松规整。
 * 前缀字段分三种情况，便于设置页表达「不加速 GitHub」：缺字段 → 默认值；
 * 显式空串 → 空（只留自定义规则）；非法 → 回落默认（打错一个字不该静默失效）。
 * 自定义规则反其道而行：原样保留（见下方注释），只在改写时判定能不能用。
 */
export function normalizeMirrorConfig(raw: unknown): MirrorConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawPrefix = typeof r.githubPrefix === "string" ? r.githubPrefix.trim() : undefined;
  const githubPrefix =
    rawPrefix === undefined
      ? DEFAULT_MIRROR_CONFIG.githubPrefix
      : rawPrefix === ""
        ? ""
        : normalizeMirrorPrefix(rawPrefix) || DEFAULT_MIRROR_CONFIG.githubPrefix;

  const customRules: MirrorRuleConfig[] = [];
  if (Array.isArray(r.customRules)) {
    for (const item of r.customRules) {
      const it = (item ?? {}) as Record<string, unknown>;
      // 原样收下（只校验两侧都是字符串，不做改写意义上的合法性判断）：
      // 设置页是「所见即所存」，用户填一半的行也得存下来——否则它会在失焦或
      // 重载后凭空消失，用户只会觉得输入被吃了。能不能用是使用侧的事：
      // policyRules 逐条过 normalizeMirrorPrefix，两侧不完整的那条自然不参与改写
      // （且主机精确相等的匹配语义决定了半截前缀永远匹配不到真实地址）。
      if (typeof it.from === "string" && typeof it.to === "string") {
        customRules.push({ from: it.from, to: it.to });
      }
    }
  }

  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_MIRROR_CONFIG.enabled,
    githubPrefix,
    gitInsteadOf:
      typeof r.gitInsteadOf === "boolean" ? r.gitInsteadOf : DEFAULT_MIRROR_CONFIG.gitInsteadOf,
    customRules,
  };
}

let current: MirrorConfig = { ...DEFAULT_MIRROR_CONFIG };

export function getMirrorConfig(): MirrorConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initMirrorConfig(): Promise<void> {
  try {
    const row = await kvGet(MIRROR_KV_KEY);
    if (row?.value) current = normalizeMirrorConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("mirror-config: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv */
export function resetMirrorConfigForTest(): void {
  current = { ...DEFAULT_MIRROR_CONFIG };
}

/** 测试辅助：只改内存不落 kv（理由同 browser-config） */
export function setMirrorConfigForTest(cfg: Partial<MirrorConfig>): void {
  current = normalizeMirrorConfig({ ...current, ...cfg });
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyMirrorConfig(raw: unknown): Promise<MirrorConfig> {
  const next = normalizeMirrorConfig(raw);
  current = next;
  try {
    await kvSet(MIRROR_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("mirror-config: persist failed:", err);
  }
  return next;
}

/** 当前生效的改写策略；总开关关闭时返回 null（调用方据此跳过整个改写路径） */
export function activeMirrorPolicy(): MirrorPolicy | null {
  if (!current.enabled) return null;
  return { githubPrefix: current.githubPrefix, customRules: current.customRules };
}

/** bash 加速环境：总开关与 git 子开关都开、且命令不是写操作时才有值 */
export function activeGitAccelEnv(command: unknown): Record<string, string> | null {
  if (!current.enabled || !current.gitInsteadOf) return null;
  if (!shouldAccelerateGit(command)) return null;
  return gitAccelEnv(current);
}
