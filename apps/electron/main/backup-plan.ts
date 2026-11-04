/**
 * 备份分区、信封解析与恢复换入的纯逻辑（不依赖 Electron，node 标准库除外，
 * 便于 bun test）：
 *
 * - `backupCollectPlan`：把「配置开关 + 数据目录 + 配置主目录」翻译成待收集的
 *   源路径清单。包内相对路径同时是恢复落点的身份。
 * - `parseHeaderFromPrefix` / `readEnvelopeHeader`：信封头解析。header 内含
 *   逐文件清单，随文件数线性增长（数万文件可达数 MB），**不能假定固定大小**
 *   ——`readEnvelopeHeader` 按块增长读到第二个换行为止。
 * - `collectDirFiles`：递归收集。根内符号链接按目标类型收集（链接安装的插件
 *   不再被静默丢掉），根外链接跳过；visiting 集合拦截链接环。
 * - `restoreTargets` / `planRestore`：包内所有可能的顶层条目与它们在本机的
 *   落点。恢复的驱动原则是「staging 里存在什么就换入什么」——旧包没有新分区、
 *   用户关掉某个开关，都不会移动或清空当前数据（旧实现无条件先移走当前目录，
 *   关闭「任务工作区」的备份恢复后会把现有产物移走且不补回）。
 * - `passphraseDecision`：备份口令判定。记住的口令解不开时必须报错，不能
 *   静默降级成不加密的包。
 *
 * 包内布局 v2（header.schemaVersion = 2，信封 formatVersion 仍为 1）：
 *   state.db / sessions/** / task-workspace/** / library/**   ← v1 原有分区
 *   home-kova/**  -> ~/.kova（身份文件 / 记忆 / MCP / 审批 / 检查点）
 *   app-data/**   -> <appData>（技能 / 子智能体 / 插件 / 宠物 / 站点权限 / 设计主题 / 检查点）
 * v1 包没有 home-kova、app-data 前缀，按 staging 存在性判断天然兼容。
 */

import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export type BackupSectionId = "core" | "workspace" | "library" | "personal" | "skills" | "checkpoints";

export interface BackupSectionFlags {
  includeWorkspace: boolean;
  includeLibrary: boolean;
  includePersonal: boolean;
  includeSkillsPlugins: boolean;
  includeCheckpoints: boolean;
}

/** 包内新增的两个顶层命名空间（避免和 v1 的四个目录名冲突） */
export const HOME_KOVA_PREFIX = "home-kova";
export const APP_DATA_PREFIX = "app-data";

export const DB_FILE = "state.db";
export const SESSIONS_DIR = "sessions";
export const TASK_WORKSPACE_DIR = "task-workspace";
export const LIBRARY_DIR = "library";

/** ~/.kova 下的单文件配置（存在才入包，缺失不报错）。
 *  刻意不含 mcp-oauth.json：那是纯 OAuth token，可重新登录取回，明文入包
 *  只会放大泄露面（mcp.json 里的 headers 可能也有明文 key，由 UI 在未设
 *  口令时弹确认兜底）。 */
export const PERSONAL_HOME_FILES = [
  "soul.md",
  "rules.md",
  "AGENTS.md",
  "mcp.json",
  "permissions.json",
] as const;

/** app-data 下的技能/子智能体目录（整体收集） */
export const SKILLS_PLUGINS_DIRS = ["skills", "subagents"] as const;

/** 插件目录只收这些部分：repos/（市场 git 克隆）与 catalogs/（目录缓存）
 *  都可重新拉取，不进包。 */
export const PLUGIN_PARTS: { name: string; kind: "file" | "dir" }[] = [
  { name: "marketplaces.json", kind: "file" },
  { name: "cache", kind: "dir" },
  { name: "dev-marketplace", kind: "dir" },
];

export interface CollectSource {
  /** 本机绝对源路径（文件或目录） */
  abs: string;
  /** 包内相对路径（tar 根下的顶层路径） */
  rel: string;
  section: BackupSectionId;
  kind: "file" | "dir";
}

export interface RestoreTarget {
  /** 包内相对路径（= 收集时的 rel） */
  rel: string;
  section: BackupSectionId;
  /** 本机恢复落点 */
  dest: string;
  kind: "file" | "dir";
}

export interface RestoreStep {
  target: RestoreTarget;
  /** staging 里有这个条目 → 换入 */
  moveIn: boolean;
  /** 换入前把当前数据移到 pre-restore-*（只有 moveIn 时才有意义） */
  moveAside: boolean;
}

/** 备份收集/恢复使用的配置主目录（默认 ~/.kova）。
 *  仅作用于备份与恢复，sidecar 运行时仍读真实 ~/.kova；主要给 e2e 沙箱用。 */
export function kovaHomeDir(): string {
  const override = process.env.KOVA_BACKUP_HOME_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".kova");
}

/** 打包收集计划：数据库快照由调用方单独加入，不在这里出现。
 *  `taskRoot` 是任务产物的实际根（用户可在设置 → 通用 → 任务产物位置改到
 *  别的盘）；缺省仍取 `<dataDir>/task-workspace`，包内 rel 保持
 *  `task-workspace/**` 不变——换机恢复不依赖绝对路径。 */
export function backupCollectPlan(
  flags: BackupSectionFlags,
  dataDir: string,
  homeDir: string,
  taskRoot?: string,
): CollectSource[] {
  const out: CollectSource[] = [];
  const push = (abs: string, rel: string, section: BackupSectionId, kind: "file" | "dir") => {
    out.push({ abs, rel, section, kind });
  };
  const taskWorkspaceAbs =
    taskRoot && taskRoot.trim().length > 0 ? taskRoot.trim() : join(dataDir, TASK_WORKSPACE_DIR);

  // core：会话转录/索引目录；state.db 由 packBackup 单独入包
  push(join(dataDir, SESSIONS_DIR), SESSIONS_DIR, "core", "dir");

  if (flags.includeWorkspace) {
    push(taskWorkspaceAbs, TASK_WORKSPACE_DIR, "workspace", "dir");
  }
  if (flags.includeLibrary) {
    push(join(dataDir, LIBRARY_DIR), LIBRARY_DIR, "library", "dir");
  }
  if (flags.includePersonal) {
    for (const name of PERSONAL_HOME_FILES) {
      push(join(homeDir, name), `${HOME_KOVA_PREFIX}/${name}`, "personal", "file");
    }
    push(join(homeDir, "memory"), `${HOME_KOVA_PREFIX}/memory`, "personal", "dir");
    push(join(dataDir, "pets"), `${APP_DATA_PREFIX}/pets`, "personal", "dir");
    push(
      join(dataDir, "browser-site-permissions.json"),
      `${APP_DATA_PREFIX}/browser-site-permissions.json`,
      "personal",
      "file",
    );
    // 只收用户主题；design-md/builtin 随应用分发，重装即可
    push(join(dataDir, "design-md", "user"), `${APP_DATA_PREFIX}/design-md/user`, "personal", "dir");
  }
  if (flags.includeSkillsPlugins) {
    for (const name of SKILLS_PLUGINS_DIRS) {
      push(join(dataDir, name), `${APP_DATA_PREFIX}/${name}`, "skills", "dir");
    }
    for (const part of PLUGIN_PARTS) {
      push(
        join(dataDir, "plugins", part.name),
        `${APP_DATA_PREFIX}/plugins/${part.name}`,
        "skills",
        part.kind,
      );
    }
  }
  if (flags.includeCheckpoints) {
    push(join(dataDir, "checkpoints"), `${APP_DATA_PREFIX}/checkpoints`, "checkpoints", "dir");
    push(join(homeDir, "checkpoints"), `${HOME_KOVA_PREFIX}/checkpoints`, "checkpoints", "dir");
  }
  return out;
}

/**
 * 包内所有可能的条目与落点（与备份时的开关无关）：恢复只看 staging 里实际
 * 存在什么，这样同一张表既能恢复新包，也能恢复没有新分区的旧包。
 */
export function restoreTargets(dataDir: string, homeDir: string, taskRoot?: string): RestoreTarget[] {
  const out: RestoreTarget[] = [];
  const push = (rel: string, section: BackupSectionId, dest: string, kind: "file" | "dir") => {
    out.push({ rel, section, dest, kind });
  };
  const taskWorkspaceDest =
    taskRoot && taskRoot.trim().length > 0 ? taskRoot.trim() : join(dataDir, TASK_WORKSPACE_DIR);

  push(DB_FILE, "core", join(dataDir, DB_FILE), "file");
  push(SESSIONS_DIR, "core", join(dataDir, SESSIONS_DIR), "dir");
  push(TASK_WORKSPACE_DIR, "workspace", taskWorkspaceDest, "dir");
  push(LIBRARY_DIR, "library", join(dataDir, LIBRARY_DIR), "dir");

  for (const name of PERSONAL_HOME_FILES) {
    push(`${HOME_KOVA_PREFIX}/${name}`, "personal", join(homeDir, name), "file");
  }
  push(`${HOME_KOVA_PREFIX}/memory`, "personal", join(homeDir, "memory"), "dir");
  push(`${APP_DATA_PREFIX}/pets`, "personal", join(dataDir, "pets"), "dir");
  push(
    `${APP_DATA_PREFIX}/browser-site-permissions.json`,
    "personal",
    join(dataDir, "browser-site-permissions.json"),
    "file",
  );
  push(`${APP_DATA_PREFIX}/design-md/user`, "personal", join(dataDir, "design-md", "user"), "dir");

  for (const name of SKILLS_PLUGINS_DIRS) {
    push(`${APP_DATA_PREFIX}/${name}`, "skills", join(dataDir, name), "dir");
  }
  for (const part of PLUGIN_PARTS) {
    push(
      `${APP_DATA_PREFIX}/plugins/${part.name}`,
      "skills",
      join(dataDir, "plugins", part.name),
      part.kind,
    );
  }

  push(`${APP_DATA_PREFIX}/checkpoints`, "checkpoints", join(dataDir, "checkpoints"), "dir");
  push(`${HOME_KOVA_PREFIX}/checkpoints`, "checkpoints", join(homeDir, "checkpoints"), "dir");

  return out;
}

/**
 * 换入计划：staging 有才换入；换入前才需要移走当前数据。
 * 两个谓词由调用方注入（便于单测，也避免纯逻辑依赖 fs）。
 */
export function planRestore(
  targets: RestoreTarget[],
  currentExists: (target: RestoreTarget) => boolean,
  stagedExists: (target: RestoreTarget) => boolean,
): RestoreStep[] {
  return targets.map((target) => {
    const moveIn = stagedExists(target);
    return { target, moveIn, moveAside: moveIn && currentExists(target) };
  });
}

export type PassphraseDecision =
  | { kind: "explicit"; passphrase: string }
  | { kind: "stored" }
  | { kind: "none" }
  | { kind: "stored-unreadable" };

/**
 * 口令来源判定（不碰加密实现）：
 * - 显式输入优先；
 * - 勾了「记住口令」且库里存有口令 → 由调用方解密使用；
 * - 存了口令但解不开 → stored-unreadable（备份时必须报错，恢复时按包是否加密决定）。
 */
export function passphraseDecision(
  explicit: string | null | undefined,
  remember: boolean,
  hasStored: boolean,
  storedDecryptable: boolean,
): PassphraseDecision {
  const e = typeof explicit === "string" ? explicit : "";
  if (e.length > 0) return { kind: "explicit", passphrase: e };
  if (remember && hasStored) {
    return storedDecryptable ? { kind: "stored" } : { kind: "stored-unreadable" };
  }
  return { kind: "none" };
}

/* ------------------------------------------------------------------ 信封 */

export const MAGIC = Buffer.from("PIABK1\n", "utf8");
const MAGIC_TEXT = "PIABK1";

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface KdfParams {
  algo: string;
  salt: string;
  iterations: number;
  nonce: string;
}

export interface BackupHeader {
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  device: string;
  appVersion: string;
  encrypted: boolean;
  kdf?: KdfParams;
  files: FileEntry[];
  payloadSha256: string;
  payloadSize: number;
  /** v2：实际入包的分区（旧包没有这个字段，恢复按 staging 存在性判断） */
  sections?: BackupSectionId[];
}

export interface BackupHeaderSummary {
  createdAt: string;
  device: string;
  appVersion: string;
  encrypted: boolean;
  fileCount: number;
}

export function headerSummary(h: BackupHeader): BackupHeaderSummary {
  return {
    createdAt: h.createdAt,
    device: h.device,
    appVersion: h.appVersion,
    encrypted: h.encrypted,
    fileCount: (h.files ?? []).length,
  };
}

/** 从信封前若干字节解析 header（远端列表用；本地文件请走 readEnvelopeHeader） */
export function parseHeaderFromPrefix(prefix: Buffer): BackupHeader {
  const first = prefix.indexOf(0x0a);
  if (first < 0) throw new Error("不是有效的备份包（缺 magic 换行）");
  const magic = prefix.subarray(0, first).toString("utf8");
  if (magic !== MAGIC_TEXT) {
    throw new Error("不是有效的备份包（magic 不匹配）");
  }
  const rest = prefix.subarray(first + 1);
  const second = rest.indexOf(0x0a);
  if (second < 0) throw new Error("不是有效的备份包（header 未完整）");
  try {
    return JSON.parse(rest.subarray(0, second).toString("utf8"));
  } catch (e: unknown) {
    throw new Error(`解析 header 失败: ${e instanceof Error ? e.message : e}`);
  }
}

/** header 理论上限：数万文件的清单约几 MB，64MB 之外一定是坏包 */
const HEADER_MAX_BYTES = 64 * 1024 * 1024;

/** 在 buf[0, filled) 里找第二个换行（header 行结尾）；没有返回 -1 */
function secondNewlineIndex(buf: Buffer, filled: number): number {
  let first = -1;
  for (let i = 0; i < filled; i++) {
    if (buf[i] === 0x0a) {
      if (first < 0) first = i;
      else return i;
    }
  }
  return -1;
}

/**
 * 流式读取本地信封的 header：按块增长直到第二个换行。
 * header 内含逐文件清单，随文件数线性增长，固定大小前缀会把真实备份全部
 * 误判成「header 未完整」。
 */
export function readEnvelopeHeader(path: string): BackupHeader {
  const fd = openSync(path, "r");
  try {
    let buf = Buffer.alloc(256 * 1024);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buf, filled, buf.length - filled, filled);
      if (n > 0) filled += n;
      const second = secondNewlineIndex(buf, filled);
      if (second >= 0) return parseHeaderFromPrefix(buf.subarray(0, second + 1));
      if (n <= 0) throw new Error("不是有效的备份包（header 未完整）");
      if (filled === buf.length) {
        if (buf.length >= HEADER_MAX_BYTES) throw new Error("备份包 header 超过大小上限");
        const grown = Buffer.alloc(Math.min(buf.length * 2, HEADER_MAX_BYTES));
        buf.copy(grown, 0, 0, filled);
        buf = grown;
      }
    }
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ 收集 */

export interface CollectStats {
  skippedLinks: number;
  /** 被跳过的链接（最多记 20 条，日志用） */
  skippedLinksPaths: string[];
}

function isInsideDir(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * 递归收集目录内文件。
 * - 根内符号链接按目标类型收集（链接安装的插件不再被静默丢掉），文件内容
 *   照常快照，目录递归；visiting 集合按 realpath 拦截链接环。
 * - 指向根外的链接跳过并记录（内容不归本应用管，跟进还可能把仓库外/家目录
 *   外的东西打进包）。
 * - 跳过 macOS 的 .DS_Store 噪音。
 */
export function collectDirFiles(dir: string, relBase: string, out: [string, string][], stats: CollectStats): void {
  const rootReal = (() => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  const visiting = new Set<string>();

  const walk = (walkDir: string, walkRelBase: string): void => {
    const key = (() => {
      try {
        return realpathSync(walkDir);
      } catch {
        return walkDir;
      }
    })();
    if (visiting.has(key)) return;
    visiting.add(key);
    try {
      let names: string[];
      try {
        names = readdirSync(walkDir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(walkDir, name);
        const rel = `${walkRelBase}/${name}`;
        let st;
        try {
          st = lstatSync(path);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          const targetReal = (() => {
            try {
              return realpathSync(path);
            } catch {
              return null;
            }
          })();
          if (!targetReal || !isInsideDir(rootReal, targetReal)) {
            stats.skippedLinks += 1;
            if (stats.skippedLinksPaths.length < 20) stats.skippedLinksPaths.push(rel);
            continue;
          }
          let stTarget;
          try {
            stTarget = statSync(path);
          } catch {
            // stat 失败（如 a→b→a 链接环触发 ELOOP）：同样按不可收集的链接记录
            stats.skippedLinks += 1;
            if (stats.skippedLinksPaths.length < 20) stats.skippedLinksPaths.push(rel);
            continue;
          }
          if (stTarget.isDirectory()) walk(path, rel);
          else if (name !== ".DS_Store") out.push([path, rel]);
          continue;
        }
        if (st.isDirectory()) walk(path, rel);
        else if (name !== ".DS_Store") out.push([path, rel]);
      }
    } finally {
      visiting.delete(key);
    }
  };

  walk(dir, relBase);
}

/** 单文件入口（个人配置里的小文件）；不存在静默跳过 */
export function collectFileIfExists(abs: string, rel: string, out: [string, string][]): void {
  try {
    if (!lstatSync(abs).isFile()) return;
  } catch {
    return;
  }
  out.push([abs, rel]);
}
