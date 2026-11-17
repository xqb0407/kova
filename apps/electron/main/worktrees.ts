/**
 * 受管 Git Worktree（docs/git-worktrees.md）：按任务隔离的并行工作树。
 *
 * 语义（对齐 Codex managed worktrees 的实用子集）：
 * - 创建：受信 git 仓库 + 基线（默认分支/指定分支/当前分支含未提交改动）→
 *   `git worktree add --detach`；未提交改动（tracked diff + untracked 拷贝）
 *   与 `.worktreeinclude`（ignored 拷贝）跟随进 worktree。
 * - 会话绑定：worktree 会话的 cwd 即 worktree；信任面（git/fs）以本模块
 *   注册表的精确路径放行（见 git.ts resolveWorkspace / fs-cmds resolveRoot）。
 * - 收尾：「创建分支」（kova/<slug>）固定成果；「删除」整目录进 trash 可恢复，
 *   trash 7 天自动清理。
 *
 * 安全约束：
 * - 信任判定只认注册表里的精确 realpath（及其子树），不做父目录推断；
 * - worktree 只由本模块创建，registry 是唯一事实源（原子写 + mtime 缓存）；
 * - 仓库清单（worktree_repos）只返回既有受信根（workspace / 项目 folders）。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gitRun } from "./git-exec";
import { appDataDir } from "./paths";
import { isTrustedRepoPath, trustedGitRepoRoots } from "./trusted-repos";
import { logWarn } from "./logging";

/* --------------------------------- 常量与类型 --------------------------------- */

const ROOT_KV_KEY = "worktrees.root";
const SETTINGS_KV_KEY = "worktrees.settings";
const REGISTRY_FILE = "registry.json";
const TRASH_DIR = ".trash";
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKTREEINCLUDE_FILE = ".worktreeinclude";
const AUTO_INCLUDE_FILES = ["AGENTS.override.md"];
const MAX_UNTRACKED_FILES = 500;
const MAX_INCLUDE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS_PER_WORKTREE = 20;
const BRANCH_PREFIX = "kova/";

/* ------------------------------ 设置（kv） ------------------------------ */

export type WorktreeSettings = {
  /** 创建前 fetch 上游（离线/无 remote 时仅告警不失败） */
  fetchBeforeCreate: boolean;
  /** 超过数量上限后自动把最旧的未绑定 worktree 移入 trash（可恢复） */
  autoCleanup: boolean;
  autoCleanupLimit: number;
};

const SETTINGS_DEFAULTS: WorktreeSettings = {
  fetchBeforeCreate: false,
  autoCleanup: true,
  autoCleanupLimit: 15,
};

function clampLimit(n: number): number {
  return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : SETTINGS_DEFAULTS.autoCleanupLimit;
}

export function getWorktreeSettings(): WorktreeSettings {
  if (settingsOverride) return { ...settingsOverride };
  try {
    const raw = store()?.kvGet(SETTINGS_KV_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const doc = JSON.parse(raw) as Record<string, unknown>;
    return {
      fetchBeforeCreate: doc.fetchBeforeCreate === true,
      autoCleanup: doc.autoCleanup !== false,
      autoCleanupLimit: clampLimit(Number(doc.autoCleanupLimit)),
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

let settingsOverride: WorktreeSettings | null = null;

export function setWorktreeSettings(patch: Partial<WorktreeSettings>): WorktreeSettings {
  const next = {
    ...getWorktreeSettings(),
    ...patch,
    ...(patch.autoCleanupLimit !== undefined ? { autoCleanupLimit: clampLimit(patch.autoCleanupLimit) } : {}),
  };
  try {
    store()?.kvSet(SETTINGS_KV_KEY, JSON.stringify(next));
  } catch (err) {
    warn(`worktree settings save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 无 kv（bun test）时用内存覆盖，保证 get/set 语义一致
  settingsOverride = next;
  return next;
}

export type WorktreeStatus = "active" | "trashed";

export type WorktreeRecord = {
  id: string;
  /** 主仓库 canonical 路径 */
  repoRoot: string;
  /** worktree 目录 canonical 路径 */
  path: string;
  /** 用户可读名（缺省取 id） */
  name?: string;
  base: string;
  baseCommit: string;
  branch?: string;
  includeUncommitted: boolean;
  createdAt: number;
  sessionIds: string[];
  status: WorktreeStatus;
  trashPath?: string;
  trashedAt?: number;
};

export type WorktreeRepo = {
  path: string;
  name: string;
  isGit: boolean;
  currentBranch?: string;
};

type Registry = { version: 1; worktrees: WorktreeRecord[] };

/* --------------------------------- 根与注册表 --------------------------------- */

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

interface StoreLike {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  getDb?: () => {
    prepare(sql: string): { all(...args: unknown[]): unknown };
  };
}

function store(): StoreLike | null {
  try {
    // 惰性 require（与 task-workspace-root 同款）：bun test 下无 electron 状态。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("./store") as StoreLike) ?? null;
  } catch {
    return null;
  }
}

/** 受管根：env（测试）→ kv `worktrees.root`（设置可改）→ appData/worktrees */
export function worktreesRoot(): string {
  const env = process.env.KOVA_WORKTREES_DIR?.trim();
  if (env) return resolve(env);
  const stored = store()?.kvGet(ROOT_KV_KEY)?.trim();
  if (stored) return resolve(stored);
  return join(appDataDir(), "worktrees");
}

let registryCache: { sig: string; data: Registry } | null = null;

function registryPath(): string {
  return join(worktreesRoot(), REGISTRY_FILE);
}

function registrySig(): string {
  const p = registryPath();
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function emptyRegistry(): Registry {
  return { version: 1, worktrees: [] };
}

function loadRegistry(): Registry {
  const sig = registrySig();
  if (registryCache && registryCache.sig === sig) return registryCache.data;
  const p = registryPath();
  let data: Registry = emptyRegistry();
  try {
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { version?: unknown }).version === 1 &&
        Array.isArray((parsed as { worktrees?: unknown }).worktrees)
      ) {
        const worktrees = (parsed as { worktrees: unknown[] }).worktrees.filter(
          (raw): raw is WorktreeRecord => normalizeRecord(raw) !== null,
        );
        data = { version: 1, worktrees };
      }
    }
  } catch {
    // 坏文件视为空表（原子写使其极难发生）；下次保存会覆盖。
    data = emptyRegistry();
  }
  registryCache = { sig, data };
  return data;
}

/** 坏条目丢弃；路径必须绝对（创建时已 canonical） */
function normalizeRecord(raw: unknown): WorktreeRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
  const repoRoot = typeof r.repoRoot === "string" && isAbsolute(r.repoRoot) ? r.repoRoot : "";
  const path = typeof r.path === "string" && isAbsolute(r.path) ? r.path : "";
  const base = typeof r.base === "string" && r.base.trim() ? r.base.trim() : "";
  const baseCommit = typeof r.baseCommit === "string" && /^[0-9a-f]{7,64}$/i.test(r.baseCommit) ? r.baseCommit : "";
  if (!id || !repoRoot || !path || !base || !baseCommit) return null;
  const status = r.status === "trashed" ? "trashed" : "active";
  return {
    id,
    repoRoot,
    path,
    ...(typeof r.name === "string" && r.name.trim() ? { name: r.name.trim().slice(0, 80) } : {}),
    base,
    baseCommit,
    ...(typeof r.branch === "string" && r.branch.trim() ? { branch: r.branch.trim() } : {}),
    includeUncommitted: r.includeUncommitted === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    sessionIds: Array.isArray(r.sessionIds)
      ? r.sessionIds.filter((v): v is string => typeof v === "string").slice(0, MAX_SESSIONS_PER_WORKTREE)
      : [],
    status,
    ...(typeof r.trashPath === "string" && isAbsolute(r.trashPath) ? { trashPath: r.trashPath } : {}),
    ...(typeof r.trashedAt === "number" ? { trashedAt: r.trashedAt } : {}),
  };
}

let writeQueue: Promise<void> = Promise.resolve();

function saveRegistry(next: Registry): Promise<void> {
  const run = writeQueue.then(() => {
    const root = worktreesRoot();
    mkdirSync(root, { recursive: true });
    const p = registryPath();
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, p);
    registryCache = { sig: registrySig(), data: next };
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

/** 注册表变更加锁走写队列；fn 同步完成（读-改-写不跨 await） */
function mutate(fn: (registry: Registry) => Registry): Promise<void> {
  return saveRegistry(fn(loadRegistry()));
}

/* --------------------------------- 小工具 --------------------------------- */

function gitIn(cwd: string, rest: string[]): string[] {
  return ["-C", cwd, "--no-optional-locks", ...rest];
}

function warn(text: string): void {
  logWarn(text);
}

function within(child: string, root: string): boolean {
  return (
    child === root ||
    child.startsWith(root + "/") ||
    (process.platform === "win32" && child.startsWith(root + "\\"))
  );
}

function slugify(name: string): string {
  const s = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "task";
}

/* --------------------------------- 信任面 --------------------------------- */

/** cwd（canonical）所在受管 worktree 的根；不在任何受管 worktree 时 null */
export function managedWorktreeRootFor(realPath: string): string | null {
  for (const wt of loadRegistry().worktrees) {
    if (wt.status !== "active") continue;
    if (within(realPath, wt.path)) return wt.path;
  }
  return null;
}

export function isManagedWorktreePath(realPath: string): boolean {
  return managedWorktreeRootFor(realPath) !== null;
}

/* --------------------------------- 仓库清单 --------------------------------- */

/** worktree 可用的受信根：kv workspace + 项目 folders（均已 realpath） */
function trustedWorktreeRoots(): string[] {
  const out = new Set<string>();
  try {
    const ws = store()?.kvGet("workspace")?.trim();
    if (ws) {
      const real = tryRealpath(ws);
      if (real) out.add(real);
    }
  } catch {
    /* 库未就绪：仅项目根 */
  }
  let projectRoots: string[] = [];
  try {
    projectRoots = trustedGitRepoRoots();
  } catch {
    /* 库未就绪：无项目根 */
  }
  for (const r of projectRoots) out.add(r);
  return [...out];
}

const MAX_NESTED_REPOS = 50;

export async function listCandidateRepos(): Promise<WorktreeRepo[]> {
  const out: WorktreeRepo[] = [];
  const seen = new Set<string>();

  const add = async (dir: string): Promise<void> => {
    const real = tryRealpath(dir);
    if (!real || seen.has(real) || !existsSync(join(real, ".git"))) return;
    seen.add(real);
    const o = await gitRun(["-C", real, "symbolic-ref", "--short", "-q", "HEAD"]);
    const current = o.ok ? o.stdout.toString("utf8").trim() : undefined;
    out.push({
      path: real,
      name: basename(real),
      isGit: true,
      ...(current ? { currentBranch: current } : {}),
    });
  };

  for (const root of trustedWorktreeRoots()) {
    const real = tryRealpath(root);
    if (!real || !existsSync(real)) continue;
    // 根本身是仓库：直接收录；否则向下扫一层——多仓库工作区（父目录含多个
    // repo）的常见形态。信任面仍收在一层以内（isTrustedRepoPath 同口径）。
    if (existsSync(join(real, ".git"))) {
      await add(real);
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(real, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort()
        .slice(0, MAX_NESTED_REPOS);
    } catch {
      continue;
    }
    for (const name of entries) await add(join(real, name));
  }
  return out;
}

/* --------------------------------- 创建 --------------------------------- */

export type CreateWorktreeInput = {
  repoRoot: string;
  base: string;
  includeUncommitted?: boolean;
  name?: string;
};

export type CreateWorktreeResult = {
  record: WorktreeRecord;
  warnings: string[];
};

async function applyUncommitted(
  repoRoot: string,
  wtPath: string,
  warnings: string[],
): Promise<void> {
  // tracked（含 staged）：binary diff → apply。失败即整体失败（调用方清理）。
  const diff = await gitRun(gitIn(repoRoot, ["diff", "HEAD", "--binary"]));
  if (!diff.ok) throw new Error(`worktree-diff-failed: ${diff.stderr}`);
  if (diff.stdout.length > 0) {
    const ap = await gitRun(gitIn(wtPath, ["apply", "--whitespace=nowarn"]), { stdin: diff.stdout });
    if (!ap.ok) throw new Error(`worktree-apply-failed: ${ap.stderr}`);
  }

  // untracked（非 ignored）：逐文件拷贝；symlink 跳过；数量上限兜底。
  const others = await gitRun(gitIn(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  if (!others.ok) throw new Error(`worktree-list-untracked-failed: ${others.stderr}`);
  const files = others.stdout.toString("utf8").split("\0").filter(Boolean);
  let copied = 0;
  for (const rel of files) {
    if (copied >= MAX_UNTRACKED_FILES) {
      warnings.push(`未跟踪文件超过 ${MAX_UNTRACKED_FILES} 个，其余未拷贝`);
      break;
    }
    const src = join(repoRoot, rel);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      warnings.push(`跳过符号链接：${rel}`);
      continue;
    }
    if (!st.isFile()) continue;
    const dst = join(wtPath, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied += 1;
  }
  if (copied > 0) warnings.push(`已拷贝 ${copied} 个未跟踪文件`);
}

/** `.worktreeinclude`（仓库根）：ignored 文件按行拷入；AGENTS.override.md 恒含 */
async function copyWorktreeInclude(
  repoRoot: string,
  wtPath: string,
  warnings: string[],
): Promise<void> {
  const includePath = join(repoRoot, WORKTREEINCLUDE_FILE);
  let patterns: string[] = [];
  try {
    if (existsSync(includePath)) {
      const lines = readFileSync(includePath, "utf8")
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !line.startsWith("#"));
      patterns = [...new Set(lines)];
    }
  } catch (err) {
    warnings.push(`.worktreeinclude 读取失败：${err instanceof Error ? err.message : String(err)}`);
  }
  patterns = patterns.filter((p) => !p.startsWith("-") && !p.startsWith(":"));

  const copyOne = (src: string, rel: string): boolean => {
    const dst = join(wtPath, rel);
    if (existsSync(dst)) return false; // 不覆盖已存在
    let st;
    try {
      st = lstatSync(src);
    } catch {
      return false;
    }
    if (st.isSymbolicLink() || !st.isFile()) return false; // symlink 跳过
    if (st.size > MAX_INCLUDE_FILE_BYTES) {
      warnings.push(`跳过超大文件（>${Math.floor(MAX_INCLUDE_FILE_BYTES / 1024 / 1024)}MB）：${rel}`);
      return false;
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return true;
  };

  // 恒含文件：直接存在性拷贝（untracked 或 tracked 都带，如 AGENTS.override.md）
  for (const name of AUTO_INCLUDE_FILES) {
    const src = join(repoRoot, name);
    if (existsSync(src)) copyOne(src, name);
  }

  // include 模式：ignored 未跟踪文件按 git pathspec 列举后拷入
  for (const pattern of patterns) {
    const o = await gitRun(
      gitIn(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", pattern]),
    );
    if (!o.ok) continue;
    for (const rel of o.stdout.toString("utf8").split("\0").filter(Boolean)) {
      copyOne(join(repoRoot, rel), rel);
    }
  }
}

let createChain: Promise<unknown> = Promise.resolve();

export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<CreateWorktreeResult> {
  // 串行化：id/目录唯一性检查在 add 之前，两个并发 create 会竞态撞名。
  // 链条吞掉上一次的 rejection（reset 为 fulfilled），否则一次失败会让
  // 后续所有 create 都收到旧错误。
  const run = createChain.then(() => createWorktreeInner(input));
  createChain = run.catch(() => undefined);
  return run;
}

async function createWorktreeInner(
  input: CreateWorktreeInput,
): Promise<CreateWorktreeResult> {
  const warnings: string[] = [];
  const repoRoot = tryRealpath(resolve(input.repoRoot));
  if (!repoRoot) throw new Error("worktree-create-failed: repo 不存在");
  if (isManagedWorktreePath(repoRoot)) {
    throw new Error("worktree-create-failed: 不支持在受管 worktree 里再建 worktree");
  }

  const base = input.base.trim();
  if (!base) throw new Error("worktree-create-failed: base is required");

  // 设置「创建前获取上游更新」：在解析基线之前 fetch（失败仅告警——
  // 离线/无 remote/私有仓不阻断本地创建）。
  const settings = getWorktreeSettings();
  if (settings.fetchBeforeCreate) {
    const fetch = await gitRun(gitIn(repoRoot, ["fetch", "--all", "--prune"]));
    if (!fetch.ok) warnings.push(`fetch 失败（忽略）：${fetch.stderr.slice(0, 200)}`);
  }

  const head = await gitRun(gitIn(repoRoot, ["rev-parse", "--verify", `${base}^{commit}`]));
  if (!head.ok) throw new Error(`worktree-create-failed: 基线不存在：${base}（${head.stderr}）`);
  const baseCommit = head.stdout.toString("utf8").trim();

  const registry = loadRegistry();
  let id = `wt-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const root = worktreesRoot();
  let path = join(root, id);
  while (existsSync(path) || registry.worktrees.some((w) => w.path === path)) {
    id = `wt-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    path = join(root, id);
  }

  const add = await gitRun(gitIn(repoRoot, ["worktree", "add", "--detach", path, baseCommit]));
  if (!add.ok) {
    throw new Error(`worktree-add-failed: ${add.stderr}`);
  }

  const record: WorktreeRecord = {
    id,
    repoRoot,
    path: tryRealpath(path) ?? path,
    ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}),
    base,
    baseCommit,
    includeUncommitted: input.includeUncommitted === true,
    createdAt: Date.now(),
    sessionIds: [],
    status: "active",
  };

  try {
    if (record.includeUncommitted) {
      await applyUncommitted(repoRoot, record.path, warnings);
    }
    await copyWorktreeInclude(repoRoot, record.path, warnings);
  } catch (err) {
    // 半成品清理：目录与注册表都不留
    try {
      rmSyncForce(record.path);
      await gitRun(gitIn(repoRoot, ["worktree", "prune"]));
    } catch {
      /* 清理失败仅记录 */
    }
    throw err;
  }

  await mutate((reg) => ({ ...reg, worktrees: [...reg.worktrees, record] }));
  void sweepActiveBeyondLimit();
  return { record, warnings };
}

function rmSyncForce(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/* --------------------------------- 查询 / 收尾 --------------------------------- */

export type WorktreeListItem = WorktreeRecord & {
  exists: boolean;
  /** 是否受保护：绑定的会话中至少一个仍存在且未归档（归档/已删除会话不保护） */
  protected: boolean;
};

/** 测试缝：注入"仍存活（未归档未删除）的会话 id"；null = 走真实 DB */
let liveSessionsOverride: Set<string> | null = null;

export function __setLiveSessionsForTest(ids: string[] | null): void {
  liveSessionsOverride = ids === null ? null : new Set(ids);
}

/**
 * 存活会话集合：sessions 表中存在且未归档。库不可用（bun test/启动早期）
 * 时保守地把全部绑定会话视为存活——宁可少清，不可误删。
 */
function liveSessionIdsFor(ids: readonly string[]): Set<string> {
  if (liveSessionsOverride) return liveSessionsOverride;
  if (ids.length === 0) return new Set();
  const db = store()?.getDb?.();
  if (!db) return new Set(ids);
  try {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const rows = db
      .prepare(`SELECT id FROM sessions WHERE archived = 0 AND id IN (${placeholders})`)
      .all(...ids) as { id?: unknown }[];
    return new Set(rows.map((r) => String(r.id ?? "")).filter(Boolean));
  } catch {
    return new Set(ids);
  }
}

export function listWorktrees(): WorktreeListItem[] {
  const base = loadRegistry().worktrees;
  const live = liveSessionIdsFor(
    base
      .filter((w) => w.status === "active")
      .flatMap((w) => w.sessionIds),
  );
  return base.map((wt) => ({
    ...wt,
    exists: wt.status === "active" ? existsSync(join(wt.path, ".git")) : existsSync(wt.trashPath ?? ""),
    protected: wt.status === "active" && wt.sessionIds.some((id) => live.has(id)),
  }));
}

export async function createBranch(id: string, name?: string): Promise<WorktreeRecord> {
  const registry = loadRegistry();
  const wt = registry.worktrees.find((w) => w.id === id && w.status === "active");
  if (!wt) throw new Error(`worktree-branch-failed: not found: ${id}`);
  const slug = slugify(name?.trim() || wt.name?.trim() || `task-${id.slice(3)}`);
  const branch = `${BRANCH_PREFIX}${slug}`;
  const o = await gitRun(gitIn(wt.path, ["checkout", "-q", "-b", branch]));
  if (!o.ok) throw new Error(`worktree-branch-failed: ${o.stderr}`);
  wt.branch = branch;
  await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.map((w) => (w.id === id ? wt : w)) }));
  return wt;
}

export async function bindSession(id: string, sessionId: string): Promise<WorktreeRecord> {
  const registry = loadRegistry();
  const wt = registry.worktrees.find((w) => w.id === id && w.status === "active");
  if (!wt) throw new Error(`worktree-bind-failed: not found: ${id}`);
  if (!wt.sessionIds.includes(sessionId)) {
    wt.sessionIds = [...wt.sessionIds, sessionId].slice(-MAX_SESSIONS_PER_WORKTREE);
    await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.map((w) => (w.id === id ? wt : w)) }));
  }
  return wt;
}

export async function removeWorktree(id: string): Promise<WorktreeRecord> {
  const registry = loadRegistry();
  const wt = registry.worktrees.find((w) => w.id === id && w.status === "active");
  if (!wt) throw new Error(`worktree-remove-failed: not found: ${id}`);
  // 目录已被外部删除（用户手动 rm）：不再 rename，仅登记为 trashed，
  // 让设置页的「删除」对死记录也能闭环。
  const trashRoot = join(worktreesRoot(), TRASH_DIR);
  if (existsSync(wt.path)) {
    mkdirSync(trashRoot, { recursive: true });
    const trashPath = join(trashRoot, `${id}-${Date.now()}`);
    renameSync(wt.path, trashPath);
    wt.trashPath = trashPath;
  }
  // 注意：这里不能 prune 主仓库的 worktree 元数据—— trash 里的目录还挂着
  // `.git` 指针，「恢复」要靠它继续可用；元数据在 purge 时才清。
  wt.status = "trashed";
  wt.trashedAt = Date.now();
  await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.map((w) => (w.id === id ? wt : w)) }));
  void sweepTrash();
  return wt;
}

export async function restoreWorktree(id: string): Promise<WorktreeRecord> {
  const registry = loadRegistry();
  const wt = registry.worktrees.find((w) => w.id === id && w.status === "trashed");
  if (!wt || !wt.trashPath) throw new Error(`worktree-restore-failed: not found: ${id}`);
  if (!existsSync(wt.trashPath)) throw new Error(`worktree-restore-failed: trash 已被清理`);
  if (existsSync(wt.path)) throw new Error(`worktree-restore-failed: 目标已存在：${wt.path}`);
  mkdirSync(dirname(wt.path), { recursive: true });
  renameSync(wt.trashPath, wt.path);
  wt.status = "active";
  delete (wt as Partial<WorktreeRecord>).trashPath;
  delete (wt as Partial<WorktreeRecord>).trashedAt;
  await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.map((w) => (w.id === id ? wt : w)) }));
  return wt;
}

export async function purgeWorktree(id: string): Promise<void> {
  const registry = loadRegistry();
  const wt = registry.worktrees.find((w) => w.id === id && w.status === "trashed");
  if (!wt) throw new Error(`worktree-purge-failed: not found: ${id}`);
  if (wt.trashPath) rmSyncForce(wt.trashPath);
  // 彻底删除才清主仓库的 worktree 元数据（remove 阶段保留以支持恢复）
  try {
    await gitRun(gitIn(wt.repoRoot, ["worktree", "prune"]));
  } catch {
    /* 主仓库不可达：悬空登记由后续 git worktree prune 自清 */
  }
  await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.filter((w) => w.id !== id) }));
}

/** trash 过期清理（启动与每次删除后调用）；retention 可注入供测试。返回清理条数 */
export async function sweepTrash(retentionMs: number = TRASH_RETENTION_MS): Promise<number> {
  const registry = loadRegistry();
  const now = Date.now();
  const expired = registry.worktrees.filter(
    (w) =>
      w.status === "trashed" &&
      typeof w.trashedAt === "number" &&
      now - w.trashedAt >= retentionMs,
  );
  let removed = 0;
  for (const wt of expired) {
    if (wt.trashPath) {
      try {
        rmSyncForce(wt.trashPath);
        removed += 1;
      } catch (err) {
        warn(`worktree trash cleanup failed (${wt.id}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.filter((w) => w.id !== wt.id) }));
  }
  return removed;
}

/** 启动清扫（index ready 调用）：清 trash + 剔除目录已物理消失的死记录 + 数量上限清理 */
export async function worktreesStartupSweep(): Promise<void> {
  await sweepTrash();
  const registry = loadRegistry();
  const dead = registry.worktrees.filter((w) => w.status === "active" && !existsSync(w.path));
  for (const wt of dead) {
    warn(`worktree missing on disk, dropping record: ${wt.id} (${wt.path})`);
    await mutate((reg) => ({ ...reg, worktrees: reg.worktrees.filter((w) => w.id !== wt.id) }));
  }
  await sweepActiveBeyondLimit();
}

/**
 * 数量上限清理（设置「自动删除旧 Worktree」）：**活跃总数**超过上限时，从
 * 最旧的**可清理**（无存活会话）的 worktree 开始移入 trash（可恢复）。
 * 保护口径对齐主流：只有仍存在且未归档的会话保护 worktree；会话归档/删除后
 * 不再阻止清理（进 trash 仍有 7 天恢复窗口）。
 */
export async function sweepActiveBeyondLimit(): Promise<number> {
  const settings = getWorktreeSettings();
  if (!settings.autoCleanup) return 0;
  const registry = loadRegistry();
  const activeAll = registry.worktrees
    .filter((w) => w.status === "active" && existsSync(w.path))
    .sort((a, b) => a.createdAt - b.createdAt);
  const over = activeAll.length - settings.autoCleanupLimit;
  if (over <= 0) return 0;
  const live = liveSessionIdsFor(activeAll.flatMap((w) => w.sessionIds));
  const cleanable = activeAll.filter((w) => !w.sessionIds.some((id) => live.has(id)));
  let removed = 0;
  for (const wt of cleanable.slice(0, over)) {
    try {
      await removeWorktree(wt.id);
      removed += 1;
    } catch (err) {
      warn(`worktree auto-cleanup failed (${wt.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}

/** 「一键移除」：把所有**可清理**（无存活会话）的 worktree 移入 trash（可恢复） */
export async function removeAllUnbound(): Promise<number> {
  const registry = loadRegistry();
  const actives = registry.worktrees.filter((w) => w.status === "active" && existsSync(w.path));
  const live = liveSessionIdsFor(actives.flatMap((w) => w.sessionIds));
  const targets = actives.filter((w) => !w.sessionIds.some((id) => live.has(id)));
  let removed = 0;
  for (const wt of targets) {
    try {
      await removeWorktree(wt.id);
      removed += 1;
    } catch (err) {
      warn(`worktree bulk remove failed (${wt.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}

/* --------------------------------- 命令注册 --------------------------------- */

export function setupWorktreeCommands(
  register: (name: string, fn: (args: any) => any) => void,
): void {
  const requireTrustedRepo = (repoRoot: string): string => {
    const real = tryRealpath(resolve(repoRoot));
    if (!real) throw new Error("worktree-create-failed: repo 不存在");
    if (isManagedWorktreePath(real)) {
      throw new Error("worktree-create-failed: 不支持在受管 worktree 里再建 worktree");
    }
    if (!isTrustedRepoPath(real, trustedWorktreeRoots())) {
      throw new Error(`worktree-create-failed: repo 不在受信根内：${repoRoot}`);
    }
    return real;
  };

  register("worktree_repos", async () => ({ repos: await listCandidateRepos() }));

  register("worktree_list", async () => ({ worktrees: listWorktrees() }));

  register("worktree_create", async (a: any) => {
    const repoRoot = requireTrustedRepo(String(a.repoRoot ?? ""));
    const { record, warnings } = await createWorktree({
      repoRoot,
      base: String(a.base ?? "").trim(),
      includeUncommitted: a.includeUncommitted === true,
      ...(typeof a.name === "string" && a.name.trim() ? { name: a.name.trim() } : {}),
    });
    return { worktree: record, warnings };
  });

  register("worktree_remove", async (a: any) => ({
    worktree: await removeWorktree(String(a.id ?? "")),
  }));

  register("worktree_restore", async (a: any) => ({
    worktree: await restoreWorktree(String(a.id ?? "")),
  }));

  register("worktree_purge", async (a: any) => {
    await purgeWorktree(String(a.id ?? ""));
    return { ok: true };
  });

  register("worktree_branch", async (a: any) => ({
    worktree: await createBranch(String(a.id ?? ""), typeof a.name === "string" ? a.name : undefined),
  }));

  register("worktree_bind_session", async (a: any) => ({
    worktree: await bindSession(String(a.id ?? ""), String(a.sessionId ?? "")),
  }));

  register("worktree_settings_get", async () => getWorktreeSettings());

  register("worktree_settings_set", async (a: any) => {
    const next = setWorktreeSettings({
      ...(typeof a.fetchBeforeCreate === "boolean" ? { fetchBeforeCreate: a.fetchBeforeCreate } : {}),
      ...(typeof a.autoCleanup === "boolean" ? { autoCleanup: a.autoCleanup } : {}),
      ...(a.autoCleanupLimit !== undefined ? { autoCleanupLimit: Number(a.autoCleanupLimit) } : {}),
    });
    // 调低上限/重新开启自动删除：立即生效并**等待清理完成**再应答，
    // 前端随后刷新看到的就是收敛后的清单（不等 30s/下次创建）。
    if (a.autoCleanup !== undefined || a.autoCleanupLimit !== undefined) {
      await sweepActiveBeyondLimit();
    }
    return next;
  });

  register("worktree_remove_unbound", async () => ({ removed: await removeAllUnbound() }));
}

/* --------------------------------- 测试缝 --------------------------------- */

/** 测试缝：清注册表缓存、设置覆盖与存活会话注入（文件由测试自管） */
export function resetWorktreesForTest(): void {
  registryCache = null;
  settingsOverride = null;
  liveSessionsOverride = null;
}
