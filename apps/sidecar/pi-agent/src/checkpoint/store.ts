/**
 * 编辑检查点（条目所有权层）：把 write/edit 这类**结构化编辑**的每次边界录下来，
 * 回答桌面检查点卡回答不了的问题——"这个文件这一轮的改动是不是全属 agent？敢不敢
 * 只回滚它一个？"（所有权判据语义：prepared/after/diverged/exact/
 * undoable 五元组；本层只做条目层，回合整仓快照仍由影子仓库负责）。
 *
 * 与影子仓库检查点的分工（互不替代）：
 * - 影子仓库（Electron 侧）：轮开始前整仓快照、轮末 diff、整轮撤销走 patch --check。
 *   它不知道改动出自谁手（bash、用户手改、agent 编辑混在同一份 diff 里）。
 * - 本层（sidecar）：只包 write/edit 工具的 execute 前后，每轮每文件记"该轮首次编辑
 *   前"的基线与"该轮最近编辑后"的结果；undoable 的判据是**当前磁盘内容 === 该轮
 *   记录的 after**——第三方（用户/bash/其它会话）动过就拒绝，绝不部分覆盖。
 *   回滚目标 = 该轮首次编辑前的内容（含此前轮的 agent 结果），逐文件、保留其余改动。
 *   bash 等外部工具对本层天然不可见（诚实降级：卡片照常从整仓 diff 展示它们，
 *   只是没有逐文件回滚按钮）。
 *
 * 目录：PI_CHECKPOINT_DIR || ~/.kova/checkpoints/<sessionId>/
 *   manifest.json（原子写：旁写 tmp + rename）
 *   blobs/<turnKey>/<rel>         该轮 before 基线
 *   blobs/<turnKey>/a/<rel>       该轮 after 结果
 *
 * 纪律：
 * - 辅助设施不挡主路：门面函数吃掉一切异常（logErr），工具执行结果不受影响。
 * - 单会话串行：per-session promise 队列（同 subagent/memory.ts 的做法），
 *   prepare/capture/status/undo 严格互斥，manifest 读-改-写不跨 await 撕裂。
 * - cwd 变了整套作废重建（same_cwd 语义：相对路径归属随工作区失效）。
 * - 快照上限 2MiB/文件（超限 skipped = 永不可回滚，卡片仍展示整仓 diff 的行数）；
 *   每会话最多保留 24 轮记录（超出裁最老；卡片上限 20 与此对齐有余量）。
 * - 回滚拒绝含符号链接的路径（逐分量 lstat），不写穿链接。
 * - manifest 键统一正斜杠 rel（与 git diff 出参同形，桌面拿来做行匹配）。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { logErr } from "../log";

/* --------------------------------- 类型与常量 --------------------------------- */

/** 快照三态：内容 / 当时不存在 / 超限不录 */
export type SnapshotKind = "contents" | "missing" | "skipped";

export type TurnFileStatus = "added" | "modified";

/** 单文件该轮所有权记录；after=null = 本轮 prepare 了还没成功 capture */
type FileRecord = {
  /** 该轮首次 prepare 的基线；null = 没抓到边界（只有 capture 的遗留）→ 永不可回滚 */
  before: SnapshotKind | null;
  after: SnapshotKind | null;
  /** 本轮内两次编辑之间磁盘被第三方改过（行数归属含外力，exact=false 的来源） */
  ext: boolean;
};

type TurnRecord = {
  files: Record<string, FileRecord>;
  stats: Record<string, { additions: number; deletions: number }>;
  createdAt: number;
};

type Manifest = {
  version: 1;
  /** 建立时的规范化工作区根；不一致即整套作废 */
  cwd: string;
  turns: Record<string, TurnRecord>;
  turnOrder: string[];
};

/** 对外单文件行（checkpoint_status 应答） */
export type TurnEditFile = {
  rel: string;
  status: TurnFileStatus;
  additions: number;
  deletions: number;
  /** true = 本轮行数归属全来自登记的编辑（无第三方掺混） */
  exact: boolean;
  /** true = 可安全回滚到该轮基线（有边界、非 skipped、磁盘未被第三方移动、无符号链接） */
  undoable: boolean;
};

export type TurnFileDiff = {
  rel: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
  exact: boolean;
};

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_TEXT_MAX_BYTES = 512 * 1024;
const MAX_TURNS = 24;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/* --------------------------------- 目录与校验 --------------------------------- */

export function checkpointRoot(): string {
  if (process.env.PI_CHECKPOINT_DIR) return resolve(process.env.PI_CHECKPOINT_DIR);
  return join(homedir(), ".kova", "checkpoints");
}

/** 会话 id / 轮 id 都按安全名单收；不合规的轮 id 落到摘要名（只影响目录名不影响语义） */
function validId(value: string): boolean {
  return ID_RE.test(value) && !value.includes("..");
}
const turnKey = (turnId: string): string =>
  validId(turnId) ? turnId : `h-${createHash("sha1").update(turnId).digest("hex").slice(0, 16)}`;

/** 与宿主 tool-exec.ts resolvePath 同规则的绝对化（盘符/斜杠开头视为绝对） */
function resolveAsHost(cwd: string, p: string): string {
  return /^([a-zA-Z]:[\\/]|\/)/.test(p) ? p : join(cwd, p);
}

/** 归一化路径 → 清单键（正斜杠 rel，与 git diff 出参同形）；越界/非法返回 null */
function toRelKey(root: string, absPath: string): string | null {
  let abs: string;
  try {
    abs = resolve(absPath);
  } catch {
    return null;
  }
  const relp = relative(resolve(root), abs);
  if (!relp || relp.startsWith("..") || isAbsolute(relp)) return null;
  const key = relp.split(sep).join("/");
  if (!key || key.split("/").some((c) => !c || c === "." || c === "..")) return null;
  return key;
}

/** blob 落盘路径（清单键逐段拼接；before 直挂、after 在 a/ 子树下） */
function blobPath(dir: string, turnId: string, rel: string, after: boolean): string {
  const segs = rel.split("/");
  return join(dir, "blobs", turnKey(turnId), ...(after ? ["a"] : []), ...segs);
}

/** 路径分量里是否出现符号链接（回滚写安全门）；分量不存在 = 无链接可言 */
function containsSymlink(root: string, rel: string): boolean {
  let cur = resolve(root);
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

const normalizeCwd = (cwd: string): string => resolve(cwd);
const sessionDir = (sessionId: string): string => join(checkpointRoot(), sessionId);
const emptyManifest = (cwd: string): Manifest => ({
  version: 1,
  cwd: normalizeCwd(cwd),
  turns: {},
  turnOrder: [],
});

/* --------------------------------- 快照读写 --------------------------------- */

type FileState =
  | { kind: "contents"; bytes: Buffer; mode: number }
  | { kind: "missing" }
  | { kind: "skipped" };

/** 读磁盘状态；不存在=missing；>2MiB 或非普通文件=skipped（内容都不录，永不可回滚） */
async function readState(abs: string): Promise<FileState> {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return { kind: "skipped" };
    const bytes = await readFile(abs);
    return { kind: "contents", bytes, mode: st.mode & 0o777 };
  } catch {
    return { kind: "missing" };
  }
}

/** 把状态存成 blob 并返回其清单 kind */
async function storeSnapshot(
  dir: string,
  turnId: string,
  rel: string,
  after: boolean,
  state: FileState,
): Promise<SnapshotKind> {
  if (state.kind !== "contents") return state.kind;
  const target = blobPath(dir, turnId, rel, after);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, state.bytes);
  return "contents";
}

/** 读回 kind 对应的 blob；missing/skipped 无内容；blob 丢失按 skipped 保守处理 */
async function loadBlob(
  dir: string,
  turnId: string,
  rel: string,
  after: boolean,
  kind: SnapshotKind,
): Promise<Buffer | null> {
  if (kind !== "contents") return null;
  try {
    return await readFile(blobPath(dir, turnId, rel, after));
  } catch {
    return null;
  }
}

async function dropBlob(
  dir: string,
  turnId: string,
  rel: string,
  after: boolean,
  kind: SnapshotKind | null,
): Promise<void> {
  if (kind !== "contents") return;
  await unlink(blobPath(dir, turnId, rel, after)).catch(() => {});
}

/** 磁盘现内容是否与记录的 after 一致（undoable 的核心判据） */
async function afterMatchesWorktree(
  dir: string,
  root: string,
  turnId: string,
  rel: string,
  after: SnapshotKind,
): Promise<boolean> {
  const current = await readState(resolveAsHost(root, rel));
  if (after === "skipped" || current.kind === "skipped") return current.kind === after;
  if (after !== current.kind) return false;
  if (after === "missing") return true;
  const blob = await loadBlob(dir, turnId, rel, true, "contents");
  const now = current.kind === "contents" ? current.bytes : null;
  return blob !== null && now !== null && blob.equals(now);
}

/* --------------------------------- 行数统计 --------------------------------- */

/** 二进制判定：前 8KiB 含 NUL（git 同法） */
function looksBinary(buf: Buffer): boolean {
  const head = Math.min(buf.length, 8192);
  for (let i = 0; i < head; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 行数增量：公共前后缀裁剪 + 中段 LCS（两行滚动 DP，单侧 ≤4000 行，超限退化为
 * 全量集合差计数）。口径 = 相对该轮 before 基线（会话级统计，非 HEAD 对比）。
 * -1 = 无法判定（二进制/坏编码），前端不显示数字。
 */
function lineStats(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  if (looksBinary(a) || looksBinary(b)) return { additions: -1, deletions: -1 };
  const al = textLines(a);
  const bl = textLines(b);
  if (al === null || bl === null) return { additions: -1, deletions: -1 };
  let p = 0;
  while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
  let sa = al.length - 1;
  let sb = bl.length - 1;
  while (sa >= p && sb >= p && al[sa] === bl[sb]) {
    sa--;
    sb--;
  }
  const midA = al.slice(p, sa + 1);
  const midB = bl.slice(p, sb + 1);
  if (midA.length > 4000 || midB.length > 4000) {
    return { additions: midB.length, deletions: midA.length };
  }
  const same = lcsLength(midA, midB);
  return { additions: midB.length - same, deletions: midA.length - same };
}

function textLines(buf: Buffer): string[] | null {
  if (buf.length === 0) return [];
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).split("\n");
  } catch {
    return null;
  }
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/* --------------------------------- manifest IO --------------------------------- */

const MANIFEST = "manifest.json";

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest;
    if (parsed?.version !== 1 || typeof parsed.cwd !== "string") return null;
    return {
      version: 1,
      cwd: parsed.cwd,
      turns: parsed.turns && typeof parsed.turns === "object" ? parsed.turns : {},
      turnOrder: Array.isArray(parsed.turnOrder) ? parsed.turnOrder : [],
    };
  } catch {
    return null;
  }
}

/** 原子写：旁写 tmp 再 rename（automation/json-file.ts 同款纪律） */
async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${MANIFEST}.tmp-${Date.now()}`);
  await writeFile(tmp, JSON.stringify(manifest), "utf8");
  await rename(tmp, join(dir, MANIFEST));
}

/** 取或建本轮记录；cwd 不一致整套作废重建；超过 MAX_TURNS 裁最老 */
async function ensureTurn(
  dir: string,
  manifest: Manifest | null,
  cwd: string,
  turnId: string,
): Promise<Manifest> {
  const root = normalizeCwd(cwd);
  let current = manifest;
  if (current && normalizeCwd(current.cwd) !== root) {
    // 换工作区：旧轮次相对路径的归属已无意义，整套清零（same_cwd 语义）
    await rm(dir, { recursive: true, force: true });
    current = null;
  }
  if (!current) current = emptyManifest(root);
  const key = turnKey(turnId);
  if (!current.turns[key]) {
    current.turns[key] = { files: {}, stats: {}, createdAt: Date.now() };
    current.turnOrder.push(key);
    while (current.turnOrder.length > MAX_TURNS) {
      const oldest = current.turnOrder.shift();
      if (oldest) {
        delete current.turns[oldest];
        await rm(join(dir, "blobs", oldest), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return current;
}

/** 载入并匹配 cwd 的 manifest（status/diff/undo 只读查询用；cwd 不符视作无数据） */
async function loadMatching(
  dir: string,
  cwd: string,
): Promise<{ manifest: Manifest; turn: TurnRecord | null; root: string } | null> {
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  const root = normalizeCwd(cwd);
  if (normalizeCwd(manifest.cwd) !== root) return null;
  return { manifest, turn: null, root };
}

/* --------------------------------- 每会话串行队列 --------------------------------- */

const queues = new Map<string, Promise<void>>();

function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
}

/* --------------------------------- 核心操作 --------------------------------- */

/**
 * 编辑开始前：为本轮尚无基线的路径抓 before。
 * 首次 prepare 的所有权边界不随后续编辑移动——本轮首个编辑事件拥有
 * 安全回滚边界。
 */
async function opPrepare(
  sessionId: string,
  cwd: string,
  turnId: string,
  paths: readonly string[],
): Promise<void> {
  const dir = sessionDir(sessionId);
  const manifest = await ensureTurn(dir, await readManifest(dir), cwd, turnId);
  const root = normalizeCwd(cwd);
  const turn = manifest.turns[turnKey(turnId)];
  let dirty = true;
  for (const p of paths) {
    const rel = toRelKey(root, resolveAsHost(root, p));
    if (!rel) continue;
    const rec = turn.files[rel];
    if (rec && rec.before !== null) {
      // 本轮再次编辑同一文件：动手前磁盘必须还停在我们上次录的 after 上，
      // 否则两次 agent 编辑之间第三方写过——行数归属掺外力（diverged→ext）。
      // 检测放 prepare 侧（agent 写入前）：capture 侧比对会把 agent 自己的
      // 第二次写入误判为第三方改动。
      if (
        rec.after !== null &&
        !(await afterMatchesWorktree(dir, root, turnId, rel, rec.after))
      ) {
        rec.ext = true;
      }
      continue;
    }
    const state = await readState(resolveAsHost(root, rel));
    const kind = await storeSnapshot(dir, turnId, rel, false, state);
    turn.files[rel] = { before: kind, after: rec?.after ?? null, ext: rec?.ext ?? false };
  }
  if (dirty) await writeManifest(dir, manifest);
}

/**
 * 编辑成功后：刷 after + 相对 before 的行数统计。
 * 本轮内检测到磁盘现内容 ≠ 上一版 after 且 ≠ 即将写入的新 after 的窗口无法在此
 * 判定（写与快照之间第三方插入）——保守做法：capture 时若当前值与记录的旧 after
 * 不同（说明本轮两次 capture 之间被动过），置 ext（exact=false）。
 */
async function opCapture(
  sessionId: string,
  cwd: string,
  turnId: string,
  paths: readonly string[],
): Promise<void> {
  const dir = sessionDir(sessionId);
  const manifest = await ensureTurn(dir, await readManifest(dir), cwd, turnId);
  const root = normalizeCwd(cwd);
  const turn = manifest.turns[turnKey(turnId)];
  for (const p of paths) {
    const rel = toRelKey(root, resolveAsHost(root, p));
    if (!rel) continue;
    let rec = turn.files[rel];
    if (!rec) {
      // capture 没有配对的 prepare（旧数据/异常路径）：为 review 保留记录，
      // before 记当前态但标 null 边界？——保守不录 before，
      // 该文件永不可 undoable。after 正常记。
      rec = { before: null, after: null, ext: false };
      turn.files[rel] = rec;
    }
    const state = await readState(resolveAsHost(root, rel));
    rec.after = await storeSnapshot(dir, turnId, rel, true, state);
    const beforeBlob =
      rec.before === "contents" ? await loadBlob(dir, turnId, rel, false, "contents") : null;
    const afterBlob =
      rec.after === "contents" ? await loadBlob(dir, turnId, rel, true, "contents") : null;
    if (beforeBlob && afterBlob) {
      turn.stats[rel] = lineStats(beforeBlob, afterBlob);
    } else if (rec.before === "missing" && afterBlob) {
      turn.stats[rel] = { additions: textLines(afterBlob)?.length ?? -1, deletions: 0 };
    } else {
      delete turn.stats[rel];
    }
  }
  await writeManifest(dir, manifest);
}

/** 一轮的所有权清单（卡片数据源；含逐行 undoable/exact 现算） */
async function opStatus(
  sessionId: string,
  cwd: string,
  turnId: string,
): Promise<TurnEditFile[]> {
  const dir = sessionDir(sessionId);
  const loaded = await loadMatching(dir, cwd);
  if (!loaded) return [];
  const turn = loaded.manifest.turns[turnKey(turnId)];
  if (!turn) return [];
  const out: TurnEditFile[] = [];
  for (const rel of Object.keys(turn.files).sort()) {
    const rec = turn.files[rel];
    if (rec.after === null) continue; // prepare 了但编辑没成功：不算改动
    const undoable =
      rec.before !== null &&
      rec.before !== "skipped" &&
      rec.after !== "skipped" &&
      !containsSymlink(loaded.root, rel) &&
      (await afterMatchesWorktree(dir, loaded.root, turnId, rel, rec.after));
    const stats = turn.stats[rel];
    out.push({
      rel,
      status: rec.before === "missing" ? "added" : "modified",
      additions: stats?.additions ?? -1,
      deletions: stats?.deletions ?? -1,
      exact: !rec.ext && undoable && (rec.before === "missing" || rec.before === "contents"),
      undoable,
    });
  }
  return out;
}

/** 单文件审阅：original = 该轮基线，current = 磁盘现值（各 512KiB 封顶） */
async function opDiff(
  sessionId: string,
  cwd: string,
  turnId: string,
  path: string,
): Promise<TurnFileDiff | null> {
  const dir = sessionDir(sessionId);
  const loaded = await loadMatching(dir, cwd);
  if (!loaded) return null;
  const rel = toRelKey(loaded.root, resolveAsHost(loaded.root, path));
  if (!rel) return null;
  const turn = loaded.manifest.turns[turnKey(turnId)];
  const rec = turn?.files[rel];
  if (!rec || rec.before === null || rec.before === "skipped") return null;
  const beforeBlob =
    rec.before === "contents" ? await loadBlob(dir, turnId, rel, false, "contents") : null;
  if (rec.before === "contents" && beforeBlob === null) return null;
  const current = await readState(resolveAsHost(loaded.root, rel));
  const currentBlob =
    current.kind === "contents" ? current.bytes : current.kind === "missing" ? Buffer.alloc(0) : null;
  if (currentBlob === null) {
    return { rel, original: "(过大或不可读)", current: "", binary: false, tooLarge: true, exact: !rec.ext };
  }
  const original = beforeBlob ?? Buffer.alloc(0);
  const binary = looksBinary(original) || looksBinary(currentBlob);
  const tooLarge =
    original.length > DIFF_TEXT_MAX_BYTES || currentBlob.length > DIFF_TEXT_MAX_BYTES;
  return {
    rel,
    original: decodeCapped(original),
    current: decodeCapped(currentBlob),
    binary,
    tooLarge,
    exact: !rec.ext,
  };
}

function decodeCapped(buf: Buffer): string {
  if (buf.length <= DIFF_TEXT_MAX_BYTES) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return "";
    }
  }
  return new TextDecoder("utf-8").decode(buf.subarray(0, DIFF_TEXT_MAX_BYTES));
}

/**
 * 回滚单文件到该轮基线。资格与 status 同一判据并现场复核：
 * before 有边界 ∧ after == 磁盘现值 ∧ 无符号链接。恢复后清掉该文件的记录与 blob——
 * 磁盘状态回到"本轮 agent 动手之前"，归属重置，下次编辑会立新基线。
 */
async function opUndo(
  sessionId: string,
  cwd: string,
  turnId: string,
  path: string,
): Promise<{ rel: string } | { error: string }> {
  const dir = sessionDir(sessionId);
  const loaded = await loadMatching(dir, cwd);
  if (!loaded) return { error: "no-checkpoint" };
  const rel = toRelKey(loaded.root, resolveAsHost(loaded.root, path));
  if (!rel) return { error: "bad-path" };
  const turnKeyNow = turnKey(turnId);
  const turn = loaded.manifest.turns[turnKeyNow];
  const rec = turn?.files[rel];
  if (!rec || rec.before === null) return { error: "no-boundary" };
  if (rec.before === "skipped" || rec.after === "skipped" || rec.after === null) {
    return { error: "skipped" };
  }
  if (containsSymlink(loaded.root, rel)) return { error: "symlink" };
  const abs = resolveAsHost(loaded.root, rel);
  if (!(await afterMatchesWorktree(dir, loaded.root, turnId, rel, rec.after))) {
    return { error: "changed-after" }; // 第三方动过：宁可不给回滚
  }
  if (rec.before === "missing") {
    try {
      const st = await stat(abs);
      if (st.isFile()) await unlink(abs);
    } catch {
      /* 已不存在：目标态已达成 */
    }
  } else {
    const blob = await loadBlob(dir, turnId, rel, false, "contents");
    if (blob === null) return { error: "snapshot-lost" };
    let mode: number | undefined;
    try {
      mode = (await stat(abs)).mode & 0o777;
    } catch {
      /* 目标不存在（被外力删了）：以默认权限重建 */
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, blob);
    if (mode !== undefined) await chmodQuiet(abs, mode);
  }
  delete turn.files[rel];
  delete turn.stats[rel];
  await dropBlob(dir, turnId, rel, false, rec.before);
  await dropBlob(dir, turnId, rel, true, rec.after);
  await writeManifest(dir, loaded.manifest);
  return { rel };
}

async function chmodQuiet(path: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  } catch {
    /* 权限尽力恢复，失败不阻断 */
  }
}

/** 会话删除随葬（delete_session 挂账点） */
async function opForget(sessionId: string): Promise<void> {
  if (!validId(sessionId)) return;
  await rm(sessionDir(sessionId), { recursive: true, force: true });
}

/* --------------------------------- 公共门面 --------------------------------- */

/** 工具路径入口：吃掉一切异常，绝不影响工具结果（旁路降级纪律） */
export function checkpointPrepare(
  sessionId: string,
  cwd: string,
  turnId: string,
  paths: readonly string[],
): Promise<void> {
  if (!sessionId || !validId(sessionId) || !turnId || paths.length === 0) {
    return Promise.resolve();
  }
  return enqueue(sessionId, () => opPrepare(sessionId, cwd, turnId, paths)).catch((err) => {
    logErr("checkpoint: prepare failed:", err);
  });
}

export function checkpointCapture(
  sessionId: string,
  cwd: string,
  turnId: string,
  paths: readonly string[],
): Promise<void> {
  if (!sessionId || !validId(sessionId) || !turnId || paths.length === 0) {
    return Promise.resolve();
  }
  return enqueue(sessionId, () => opCapture(sessionId, cwd, turnId, paths)).catch((err) => {
    logErr("checkpoint: capture failed:", err);
  });
}

export function checkpointStatus(
  sessionId: string,
  cwd: string,
  turnId: string,
): Promise<TurnEditFile[]> {
  if (!sessionId || !validId(sessionId)) return Promise.resolve([]);
  return enqueue(sessionId, () => opStatus(sessionId, cwd, turnId)).catch((err) => {
    logErr("checkpoint: status failed:", err);
    return [];
  });
}

export function checkpointDiff(
  sessionId: string,
  cwd: string,
  turnId: string,
  path: string,
): Promise<TurnFileDiff | null> {
  if (!sessionId || !validId(sessionId)) return Promise.resolve(null);
  return enqueue(sessionId, () => opDiff(sessionId, cwd, turnId, path)).catch((err) => {
    logErr("checkpoint: diff failed:", err);
    return null;
  });
}

export function checkpointUndo(
  sessionId: string,
  cwd: string,
  turnId: string,
  path: string,
): Promise<{ rel: string } | { error: string }> {
  if (!sessionId || !validId(sessionId)) return Promise.resolve({ error: "no-checkpoint" });
  return enqueue(sessionId, () => opUndo(sessionId, cwd, turnId, path)).catch((err) => {
    logErr("checkpoint: undo failed:", err);
    return { error: String(err) };
  });
}

export function checkpointForget(sessionId: string): void {
  if (!sessionId) return;
  void enqueue(sessionId, () => opForget(sessionId)).catch((err) => {
    logErr("checkpoint: forget failed:", err);
  });
}

/** 测试辅助：确认某会话目录是否存在（不属运行时 API） */
export function checkpointSessionExists(sessionId: string): boolean {
  return existsSync(join(sessionDir(sessionId), MANIFEST));
}
