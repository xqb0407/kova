/**
 * 任务产物目录（task-workspace）的根位置事实源。
 *
 * 缺省 `<appData>/task-workspace`——「我的文件」页与无目录任务的 agent 产物
 * 都落在这里；用户可在设置 → 通用 → 任务产物位置改到任意文件夹（kv
 * "task.workspace.root"）。Windows 上常把它从 C 盘挪到数据盘。
 *
 * 切换位置支持两种语义：
 * - 仅切换：只改落点，旧文件留在原地（与「资料库位置」一致）；
 * - 迁移并切换：把旧根全部内容搬到新根后再切。
 *
 * 迁移的崩溃安全模型（强退/断电可承受）：
 *   1. 全程只读旧根，先复制到新根内的 `.migrate-*` 暂存目录；
 *   2. 逐文件校验（相对路径集合 + 大小）通过后才进入收尾；
 *   3. 收尾把暂存条目 rename 就位（同盘瞬间完成，幂等可续跑）；
 *   4. 最后才原子切换 kv 指向新根，并记下旧根清理标记；
 *   5. 旧根删除失败不影响已生效的切换，下次启动按标记重试。
 * 任何崩溃点只会落在「旧根完好」或「新根已校验」两种状态之一，不会出现
 * 活动目录缺文件。同盘且目标不存在时整目录 rename（原子、零拷贝），同样
 * 先写 renaming 标记，崩溃后按「目标在、源不在」恢复切换。
 *
 * 依赖约定：本模块只引 node 标准库与 ./paths（惰性 electron），store 走
 * 惰性 require——bun test 可直接导入纯逻辑做单测。
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appDataDir } from "./paths";

export const TASK_WORKSPACE_DIR = "task-workspace";
export const TASK_WORKSPACE_ROOT_KEY = "task.workspace.root";
export const TASK_WORKSPACE_MIGRATE_KEY = "task.workspace.migrate";
export const TASK_WORKSPACE_CLEANUP_KEY = "task.workspace.cleanup";
export const TASK_WORKSPACE_PROGRESS_EVENT = "task:migrate-progress";

/** 新根内的迁移暂存目录前缀（收尾时逐条 rename 到根下） */
const STAGING_PREFIX = ".migrate-";

/* ------------------------------------------------------------------ kv 惰性访问 */

interface StoreLike {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  kvDelete(key: string): void;
}

function store(): StoreLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./store") as StoreLike;
}

/* ------------------------------------------------------------------ 根解析 */

function envOverride(): string {
  const v = process.env.KOVA_TASK_WORKSPACE_DIR;
  return v && v.trim().length > 0 ? v.trim() : "";
}

/** 缺省任务产物根：<appData>/task-workspace */
export function defaultTaskWorkspaceRoot(): string {
  return join(appDataDir(), TASK_WORKSPACE_DIR);
}

/** 当前任务产物根（环境变量 > kv 配置 > 缺省）；db 未就绪时回退缺省值 */
export function taskWorkspaceRoot(): string {
  const env = envOverride();
  if (env) return env;
  try {
    const raw = store().kvGet(TASK_WORKSPACE_ROOT_KEY);
    const p = typeof raw === "string" ? raw.trim() : "";
    if (p.length > 0) return p;
  } catch {
    /* store 未初始化：按缺省值走 */
  }
  return defaultTaskWorkspaceRoot();
}

export function isDefaultTaskWorkspaceRoot(root: string = taskWorkspaceRoot()): boolean {
  return canonicalPath(root) === canonicalPath(defaultTaskWorkspaceRoot());
}

/** 设置页展示用根信息（含缺省值与存在性） */
export function taskWorkspaceRootInfo(): {
  root: string;
  defaultRoot: string;
  isDefault: boolean;
  exists: boolean;
} {
  const root = taskWorkspaceRoot();
  return {
    root,
    defaultRoot: defaultTaskWorkspaceRoot(),
    isDefault: isDefaultTaskWorkspaceRoot(root),
    exists: existsSync(root),
  };
}

/* ------------------------------------------------------------------ 校验 */

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 归一：存在的部分取 realpath，不存在的水尾原样拼回（macOS /var→/private/var
 *  这类符号链接在前缀里时，纯 resolve 比较会让「祖先/后代」判断失效） */
function canonicalPath(p: string): string {
  const real = tryRealpath(p);
  if (real) return real;
  const parent = dirname(p);
  if (parent === p) return resolve(p);
  return join(canonicalPath(parent), basename(p));
}

/** a 是 b 的祖先或本身（canonical 优先，比较前各自归一） */
function isAncestorOrSame(a: string, b: string): boolean {
  const ra = canonicalPath(a);
  const rb = canonicalPath(b);
  return (
    rb === ra ||
    rb.startsWith(ra + "/") ||
    (process.platform === "win32" && rb.startsWith(ra + "\\"))
  );
}

function normalizeRoot(dir: string): string {
  return dir.trim().replace(/[\\/]+$/, "");
}

/**
 * 校验候选任务产物根：通过返回 null，拒绝返回错误短码。
 * 与「资料库位置」同一套边界（非绝对路径 / 盘根与文件系统根 / 家目录本体 /
 * appDataDir 及其祖先 / appDataDir 内部非缺省 task-workspace 目录）。
 */
export function validateTaskWorkspaceRoot(
  dir: string,
  opts: { appDataDir?: string; homeDir?: string } = {},
): string | null {
  const data = opts.appDataDir ?? appDataDir();
  const home = opts.homeDir ?? homedir();
  const raw = normalizeRoot(dir);
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return "bad-path";
  if (raw === "/" || /^[a-zA-Z]:$/.test(raw)) return "bad-path";
  if (canonicalPath(raw) === canonicalPath(home)) return "home-not-allowed";
  if (isAncestorOrSame(raw, data)) return "app-data-not-allowed";
  if (
    isAncestorOrSame(data, raw) &&
    canonicalPath(raw) !== canonicalPath(join(data, TASK_WORKSPACE_DIR))
  ) {
    return "app-data-not-allowed";
  }
  return null;
}

/* ------------------------------------------------------------------ 迁移标记 */

export type TaskWorkspaceMigratePhase = "renaming" | "copying" | "verify" | "finalizing" | "cleanup";

export interface TaskWorkspaceMigrateMarker {
  from: string;
  to: string;
  /** 复制路径的暂存目录（renaming 模式为空串） */
  staging: string;
  phase: TaskWorkspaceMigratePhase;
  startedAt: string;
}

export interface TaskWorkspaceCleanupMarker {
  oldRoot: string;
  startedAt: string;
}

export interface TaskWorkspaceProgress {
  phase: TaskWorkspaceMigratePhase;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message: string;
}

function readMigrateMarker(): TaskWorkspaceMigrateMarker | null {
  try {
    const raw = store().kvGet(TASK_WORKSPACE_MIGRATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TaskWorkspaceMigrateMarker;
    return typeof parsed?.to === "string" && typeof parsed?.from === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeMigrateMarker(marker: TaskWorkspaceMigrateMarker): void {
  store().kvSet(TASK_WORKSPACE_MIGRATE_KEY, JSON.stringify(marker));
}

function clearMigrateMarker(): void {
  try {
    store().kvDelete(TASK_WORKSPACE_MIGRATE_KEY);
  } catch {
    /* db 未就绪 */
  }
}

function readCleanupMarker(): TaskWorkspaceCleanupMarker | null {
  try {
    const raw = store().kvGet(TASK_WORKSPACE_CLEANUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TaskWorkspaceCleanupMarker;
    return typeof parsed?.oldRoot === "string" && parsed.oldRoot.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCleanupMarker(oldRoot: string): void {
  store().kvSet(
    TASK_WORKSPACE_CLEANUP_KEY,
    JSON.stringify({ oldRoot, startedAt: new Date().toISOString() } satisfies TaskWorkspaceCleanupMarker),
  );
}

function clearCleanupMarker(): void {
  try {
    store().kvDelete(TASK_WORKSPACE_CLEANUP_KEY);
  } catch {
    /* db 未就绪 */
  }
}

/** 诊断日志（惰性引入：logging 依赖 paths，测试环境不加载） */
function logTaskWorkspaceWarn(message: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logWarn } = require("./logging") as typeof import("./logging");
    logWarn(message);
  } catch {
    /* 日志未就绪/测试环境：忽略 */
  }
}

/* ------------------------------------------------------------------ 迁移引擎（纯 fs） */

interface TreeMeasure {
  files: number;
  bytes: number;
}

/** 统计目录内文件数与总字节（符号链接按文件计、字节 0） */
export async function measureTree(root: string): Promise<TreeMeasure> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (!entry.isFile()) continue; // socket/fifo 等非产物
      try {
        const st = await fsp.stat(path);
        files += 1;
        bytes += st.size;
      } catch {
        /* 竞态删除：跳过 */
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

/** 相对路径 → 大小（符号链接记 -1），用于复制校验 */
async function treeMap(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (dir: string, relBase: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, rel);
        continue;
      }
      if (entry.isSymbolicLink()) {
        out.set(rel, -1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = await fsp.stat(path);
        out.set(rel, st.size);
      } catch {
        /* 竞态：交由校验判定缺失 */
      }
    }
  };
  await walk(root, "");
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 目标名被占用时按 Finder 习惯加「 (2)」「 (3)」…（与 fs-cmds uniqueTarget 同形） */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const parent = dirname(path);
  const name = path.slice(parent.length + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = join(parent, `${base} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(parent, `${base}-${randomUUID()}${ext}`);
}

function sameVolume(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(nearestExistingDir(b)).dev;
  } catch {
    return false;
  }
}

function nearestExistingDir(p: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 目标盘剩余空间需覆盖旧根大小（+5% 与 64MB 余量）；查询不可用时跳过 */
function assertTargetSpace(to: string, neededBytes: number): void {
  try {
    const st = statfsSync(nearestExistingDir(to));
    const free = Number(st.bsize) * Number(st.bavail);
    if (neededBytes > 0 && free < neededBytes * 1.05 + 64 * 1024 * 1024) {
      throw new Error(`目标磁盘空间不足：需要约 ${humanBytes(neededBytes)}，可用 ${humanBytes(free)}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("目标磁盘空间不足")) throw e;
    /* statfs 不可用：交给复制失败兜底（源数据不受影响） */
  }
}

/** 复制源树到暂存目录（逐文件流式进度；符号链接保持为链接） */
async function copyTree(
  from: string,
  to: string,
  total: TreeMeasure,
  onProgress?: (p: TaskWorkspaceProgress) => void,
): Promise<void> {
  let done = 0;
  let bytesDone = 0;
  const report = (message: string) => {
    onProgress?.({
      phase: "copying",
      done,
      total: total.files,
      bytesDone,
      bytesTotal: total.bytes,
      message,
    });
  };
  const walk = async (srcDir: string, dstDir: string): Promise<void> => {
    await fsp.mkdir(dstDir, { recursive: true });
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = join(srcDir, entry.name);
      const dst = join(dstDir, entry.name);
      if (entry.isDirectory()) {
        await walk(src, dst);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(src);
        // Windows 需要显式类型（默认按文件链接处理目录链接会打不开）
        let type: "file" | "dir" | undefined;
        if (process.platform === "win32") {
          try {
            type = statSync(src).isDirectory() ? "dir" : "file";
          } catch {
            type = "file";
          }
        }
        await fsp.symlink(target, dst, type);
        done += 1;
        report(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      await fsp.copyFile(src, dst);
      // 保留修改时间：产物列表按 mtime 展示，迁移后不应全部跳成迁移时刻
      try {
        const st = await fsp.stat(src);
        await fsp.utimes(dst, st.atime, st.mtime);
      } catch {
        /* 时间戳保留失败不影响内容 */
      }
      done += 1;
      try {
        const st = await fsp.stat(dst);
        bytesDone += st.size;
      } catch {
        /* 竞态：字节数只影响进度显示 */
      }
      report(entry.name);
    }
  };
  await walk(from, to);
}

/** 校验暂存副本与源逐项一致（相对路径集合 + 大小；符号链接只核对存在） */
async function verifyCopied(from: string, staging: string): Promise<void> {
  const src = await treeMap(from);
  const dst = await treeMap(staging);
  for (const [rel, size] of src) {
    const got = dst.get(rel);
    if (got === undefined) throw new Error(`校验失败：目标缺少 ${rel}`);
    if (size >= 0 && got !== size) throw new Error(`校验失败：大小不一致 ${rel}`);
  }
  for (const rel of dst.keys()) {
    if (!src.has(rel)) throw new Error(`校验失败：目标多出 ${rel}`);
  }
}

/** 暂存条目逐个 rename 到新根（幂等：已就位的不在暂存里了） */
async function finalizeStaging(staging: string, to: string): Promise<number> {
  await fsp.mkdir(to, { recursive: true });
  let names: string[];
  try {
    names = await fsp.readdir(staging);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw e;
  }
  let moved = 0;
  for (const name of names) {
    const src = join(staging, name);
    const dst = uniquePath(join(to, name));
    try {
      await fsp.rename(src, dst);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EXDEV") throw e;
      // 暂存理应与 to 同盘；极端挂载变化下退化为复制后删除
      const measure = await measureTree(src);
      await copyTree(src, dst, measure);
      await fsp.rm(src, { recursive: true, force: true });
    }
    moved += 1;
  }
  await fsp.rm(staging, { recursive: true, force: true });
  return moved;
}

export interface MigrateEngineOptions {
  /** 调用方预先算出的暂存目录（写进迁移标记，崩溃恢复用） */
  staging: string;
  onPhase?: (phase: TaskWorkspaceMigratePhase) => void;
  onProgress?: (p: TaskWorkspaceProgress) => void;
  /** 测试用：跳过整目录 rename 快路径 */
  forceCopy?: boolean;
}

export interface MigrateEngineResult {
  movedFiles: number;
  movedBytes: number;
  usedRename: boolean;
}

/**
 * 把 from 的全部内容迁移到 to（可 to 已存在，按顶层条目合并、同名加序号）。
 * 不做 kv 读写——标记阶段切换由调用方通过 onPhase 持久化，成功与否由
 * 调用方决定是否切根。
 */
export async function migrateTaskWorkspaceDir(
  from: string,
  to: string,
  options: MigrateEngineOptions,
): Promise<MigrateEngineResult> {
  const sourceExists = existsSync(from);
  const toExists = existsSync(to);
  const measure = sourceExists ? await measureTree(from) : { files: 0, bytes: 0 };
  if (!sourceExists || measure.files === 0) {
    await fsp.mkdir(to, { recursive: true });
    if (sourceExists) {
      // 空目录：直接删掉（内容为空，无可迁移）
      await fsp.rm(from, { recursive: true, force: true });
    }
    return { movedFiles: 0, movedBytes: 0, usedRename: false };
  }

  // 同盘且目标不存在：整目录 rename（原子、零拷贝）
  if (!options.forceCopy && !toExists && sameVolume(from, to)) {
    await fsp.mkdir(dirname(to), { recursive: true });
    options.onPhase?.("renaming");
    try {
      await fsp.rename(from, to);
      return { movedFiles: measure.files, movedBytes: measure.bytes, usedRename: true };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
      /* 跨盘/占用：退回复制路径 */
    }
  }
  await fsp.mkdir(to, { recursive: true });
  assertTargetSpace(to, measure.bytes);

  const staging = options.staging;
  await fsp.rm(staging, { recursive: true, force: true });
  options.onPhase?.("copying");
  await copyTree(from, staging, measure, options.onProgress);

  options.onPhase?.("verify");
  options.onProgress?.({
    phase: "verify",
    done: measure.files,
    total: measure.files,
    bytesDone: measure.bytes,
    bytesTotal: measure.bytes,
    message: "校验副本…",
  });
  await verifyCopied(from, staging);

  options.onPhase?.("finalizing");
  await finalizeStaging(staging, to);
  return { movedFiles: measure.files, movedBytes: measure.bytes, usedRename: false };
}

/* ------------------------------------------------------------------ 启动恢复 */

export type MigrateRecoveryAction = "flip" | "resume-finalize" | "discard" | "none";

/**
 * 崩溃恢复判定（纯逻辑，便于单测）：
 * - renaming：目标在、源不在 → 切换已发生，补切 kv；否则 rename 未执行，丢弃标记；
 * - copying：复制未完成，丢弃暂存，保持旧根；
 * - verify：复制已完成才进入该阶段，暂存完整——与 finalizing 同路（续跑收尾）；
 * - finalizing：暂存还在就续跑收尾；否则视为收尾已完成，但目标也丢了（被手动
 *   删除/盘未挂载）时不能切过去，直接丢弃。
 */
export function decideMigrateRecovery(
  marker: TaskWorkspaceMigrateMarker,
  exists: (path: string) => boolean,
): MigrateRecoveryAction {
  if (marker.phase === "renaming") {
    return exists(marker.to) && !exists(marker.from) ? "flip" : "discard";
  }
  if (marker.phase === "copying") return "discard";
  if (marker.staging && exists(marker.staging)) return "resume-finalize";
  return exists(marker.to) ? "flip" : "discard";
}

/** 旧根清理（失败保留标记，下次启动重试；绝不删当前活动根） */
async function cleanupOldRoot(oldRoot: string): Promise<void> {
  try {
    if (canonicalPath(oldRoot) === canonicalPath(taskWorkspaceRoot())) {
      clearCleanupMarker();
      return;
    }
  } catch {
    /* store 未就绪：照常尝试删除（调用点都在 store 就绪后） */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.rm(oldRoot, { recursive: true, force: true });
      clearCleanupMarker();
      return;
    } catch {
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
  }
  // 删不掉（文件被占用/只读）：保留清理标记，下次启动再试
  logTaskWorkspaceWarn(`[task-workspace] old root cleanup deferred (locked?): ${oldRoot}`);
}

let migrating = false;

/** 渲染层/命令层判断迁移是否在进行（fs 命令据此返回 busy） */
export function isTaskWorkspaceMigrating(): boolean {
  return migrating;
}

/**
 * 启动恢复：store 就绪后尽早调用。
 * 处理上次中断的迁移（复制中/收尾中/rename 后未切根）与旧根清理标记。
 */
export async function recoverTaskWorkspaceMigrate(): Promise<void> {
  const marker = readMigrateMarker();
  if (marker) {
    migrating = true;
    try {
      const action = decideMigrateRecovery(marker, existsSync);
      if (action === "discard") {
        if (marker.staging) {
          try {
            await fsp.rm(marker.staging, { recursive: true, force: true });
          } catch {
            /* 残留暂存最多占空间，不影响数据 */
          }
        }
      } else if (action === "resume-finalize") {
        await finalizeStaging(marker.staging, marker.to);
      }
      if (action === "flip" || action === "resume-finalize") {
        store().kvSet(TASK_WORKSPACE_ROOT_KEY, marker.to);
        writeCleanupMarker(marker.from);
      }
      clearMigrateMarker();
    } catch (e) {
      // 恢复失败：保留标记下次再试；当前根未动，数据安全
      const msg = e instanceof Error ? e.message : String(e);
      logTaskWorkspaceWarn(
        `[task-workspace] migrate recovery failed (phase=${marker.phase}, to=${marker.to}): ${msg}`,
      );
    } finally {
      migrating = false;
    }
  }

  const cleanup = readCleanupMarker();
  if (cleanup) {
    // 清理旧根不影响活动根，不置 migrating（否则启动后的「我的文件」会短暂忙）
    await cleanupOldRoot(cleanup.oldRoot);
  }
}

/** 启动时确保当前根存在；建不出来（只读盘/权限）由页面呈现为空目录态 */
export function ensureTaskWorkspaceRoot(): string {
  const root = taskWorkspaceRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* 页面侧以读取失败呈现 */
  }
  return root;
}

/* ------------------------------------------------------------------ 切换入口 */

export interface SetTaskWorkspaceRootOptions {
  migrate: boolean;
  /** 返回非空字符串 = 有会话/工具在跑，拒绝切换（短码 busy） */
  busyReason?: () => string | null;
  /** 迁移前停写入者（返回之前是否在跑，供恢复） */
  stopWriters?: () => Promise<boolean>;
  resumeWriters?: (wasRunning: boolean) => void;
  onProgress?: (p: TaskWorkspaceProgress) => void;
}

export interface SetTaskWorkspaceRootResult {
  root: string;
  migrated: boolean;
  movedFiles: number;
  movedBytes: number;
}

function probeWritable(to: string): void {
  // 目标不存在时在父目录探测（不提前建出 to，保证同盘 rename 快路径可用）
  const dir = existsSync(to) ? to : dirname(to);
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.kova-probe-${randomUUID()}`);
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`目标位置不可写：${msg}`);
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 设置任务产物根。migrate=true 时迁移旧根全部内容；任何失败都保持：
 * kv 未切换、旧根未改动（复制路径），错误信息带原因。
 *
 * 并发门闩同步置位：两个切换请求同时到达时，后者立即 busy，避免两份标记/
 * 两次迁移互相覆盖。
 */
const switching = { active: false };

export async function setTaskWorkspaceRoot(
  dir: string,
  options: SetTaskWorkspaceRootOptions,
): Promise<SetTaskWorkspaceRootResult> {
  if (switching.active || migrating) throw new Error("busy");
  switching.active = true;
  try {
    return await setTaskWorkspaceRootInner(dir, options);
  } finally {
    switching.active = false;
  }
}

async function setTaskWorkspaceRootInner(
  dir: string,
  options: SetTaskWorkspaceRootOptions,
): Promise<SetTaskWorkspaceRootResult> {
  const to = normalizeRoot(dir);
  const code = validateTaskWorkspaceRoot(to);
  if (code) throw new Error(code);
  const from = taskWorkspaceRoot();
  if (canonicalPath(from) === canonicalPath(to)) {
    return { root: from, migrated: false, movedFiles: 0, movedBytes: 0 };
  }
  if (isAncestorOrSame(to, from) || isAncestorOrSame(from, to)) {
    throw new Error("overlap");
  }
  if (options.busyReason?.()) throw new Error("busy");
  if (process.platform === "win32" && to.length > 240) throw new Error("path-too-long");

  probeWritable(to);

  if (!options.migrate) {
    mkdirSync(to, { recursive: true });
    const wasRunning = options.stopWriters ? await options.stopWriters() : false;
    try {
      store().kvSet(TASK_WORKSPACE_ROOT_KEY, to);
    } catch (e) {
      options.resumeWriters?.(wasRunning);
      throw e;
    }
    options.resumeWriters?.(wasRunning);
    return { root: to, migrated: false, movedFiles: 0, movedBytes: 0 };
  }

  const sourceExists = existsSync(from);
  const measure = sourceExists ? await measureTree(from) : { files: 0, bytes: 0 };
  if (!sourceExists || measure.files === 0) {
    mkdirSync(to, { recursive: true });
    const wasRunning = options.stopWriters ? await options.stopWriters() : false;
    try {
      store().kvSet(TASK_WORKSPACE_ROOT_KEY, to);
    } catch (e) {
      options.resumeWriters?.(wasRunning);
      throw e;
    }
    if (sourceExists) {
      // 空目录直接清掉（内容为空，数据无风险）
      try {
        rmSync(from, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    options.resumeWriters?.(wasRunning);
    return { root: to, migrated: false, movedFiles: 0, movedBytes: 0 };
  }

  // 迁移前预检（空间/可写）在停写入者之前完成：失败零改动
  if (existsSync(to) || !sameVolume(from, to)) {
    assertTargetSpace(to, measure.bytes);
  }

  const staging = join(to, `${STAGING_PREFIX}${stamp()}`);
  const marker: TaskWorkspaceMigrateMarker = {
    from,
    to,
    staging,
    phase: "copying",
    startedAt: new Date().toISOString(),
  };
  writeMigrateMarker(marker);
  migrating = true;

  const wasRunning = options.stopWriters ? await options.stopWriters() : false;
  let committed = false;
  try {
    const result = await migrateTaskWorkspaceDir(from, to, {
      staging,
      onPhase: (phase) => writeMigrateMarker({ ...marker, phase }),
      onProgress: options.onProgress,
    });

    store().kvSet(TASK_WORKSPACE_ROOT_KEY, to);
    writeCleanupMarker(from);
    clearMigrateMarker();
    committed = true;
    options.resumeWriters?.(wasRunning);
    if (result.movedFiles > 0) {
      void cleanupOldRoot(from);
    }
    options.onProgress?.({
      phase: "cleanup",
      done: result.movedFiles,
      total: result.movedFiles,
      bytesDone: result.movedBytes,
      bytesTotal: result.movedBytes,
      message: "迁移完成",
    });
    return {
      root: to,
      migrated: true,
      movedFiles: result.movedFiles,
      movedBytes: result.movedBytes,
    };
  } catch (e) {
    // 源在复制路径下始终未动；以下两种情况保留标记交给启动恢复补切根：
    // - 整目录 rename 已成功；
    // - 副本已校验并完成收尾（staging 已清），只有最后的 kv 写失败。
    let movedOrFinalized = false;
    if (!committed) {
      const current = readMigrateMarker();
      const finalized =
        current?.phase === "finalizing" &&
        (!current.staging || !existsSync(current.staging)) &&
        existsSync(to);
      const renamed = !existsSync(from) && existsSync(to);
      movedOrFinalized = finalized || renamed;
      if (!movedOrFinalized) {
        try {
          await fsp.rm(staging, { recursive: true, force: true });
        } catch {
          /* 残留暂存最多占空间 */
        }
        clearMigrateMarker();
      }
    }
    options.resumeWriters?.(wasRunning);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      movedOrFinalized
        ? `切换未生效：${msg}（数据已就位，重启后自动完成切换）`
        : `迁移失败：${msg}（原位置未改动）`,
    );
  } finally {
    migrating = false;
  }
}
