/**
 * Git 集成（对齐 git.rs 全契约）：CLI 包装（系统 git），porcelain v2 / name-status
 * 机器格式解析；影子 git-dir 检查点（不碰用户仓库 refs/index/stash）。
 * 安全约束同款：-C <cwd> --no-optional-locks 固定前缀、参数数组传递不拼 shell、
 * cwd 必须与 kv "workspace" canonicalize 一致、写命令按 cwd 串行化。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, isAbsolute, normalize } from "node:path";
import { guardStreamErrors } from "./child-stream";
import { appDataDir } from "./paths";
import { kvGet } from "./store";
import { emitToWindows } from "./ipc";

const MAX_DIFF_FILE_BYTES = 256 * 1024;
const MAX_DIFF_TOTAL_BYTES = 1024 * 1024;
const MAX_DIFF_FILES = 200;
const MAX_SHOW_BYTES = 1024 * 1024;
const CHECKPOINT_REF_PREFIX = "refs/kova";
const CHECKPOINT_KEEP = 20;
const SHADOW_EXCLUDE_MARKER = "# kova-checkpoint-excludes";
const SHADOW_EXCLUDES =
  "node_modules/\n.next/\nnuxt/\ndist/\nbuild/\nout/\ntarget/\n__pycache__/\nvendor/\n";
const MAX_PATCH_FILE_BYTES = 32 * 1024 * 1024;

/* ------------------------------ 进程执行 ------------------------------ */

interface GitOut {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

function gitRun(args: string[], opts: { stdin?: Buffer; env?: Record<string, string> } = {}): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...(opts.env ?? {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    // git 可能在读完 stdin 前退出（apply --check 冲突、非仓库、hook 失败等），
    // 随后写 stdin 会异步失败；没有 'error' 监听就升级成主进程 uncaughtException
    //（win32 上即 "write EOF"）。成败以 close 的退出码/stderr 为准。
    guardStreamErrors(child.stdin);
    guardStreamErrors(child.stdout);
    guardStreamErrors(child.stderr);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => reject(new Error(`failed to run git: ${e.message}`)));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8").trim(),
      });
    });
    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

function userGit(cwd: string, rest: string[]): string[] {
  return ["-C", cwd, "--no-optional-locks", ...rest];
}
function shadowGit(dir: string, work: string, rest: string[]): string[] {
  return ["--git-dir", dir, "--work-tree", work, "--no-optional-locks", ...rest];
}

/* ------------------------------ 探测与校验 ------------------------------ */

let gitVersionCache: string | null | undefined;
async function gitVersion(): Promise<string | null> {
  if (gitVersionCache !== undefined) return gitVersionCache;
  try {
    const o = await gitRun(["--version"]);
    gitVersionCache = o.ok ? o.stdout.toString("utf8").trim() : null;
  } catch {
    gitVersionCache = null;
  }
  return gitVersionCache;
}

async function ensureGit(): Promise<void> {
  if ((await gitVersion()) === null) throw new Error("no-git");
}

async function ensureRepo(cwd: string): Promise<void> {
  const o = await gitRun(userGit(cwd, ["rev-parse", "--is-inside-work-tree"]));
  if (!(o.ok && o.stdout.toString("utf8").trim() === "true")) throw new Error("not-repo");
}

interface Resolved {
  run: string;
  key: string;
}

function tryRealpath(p: string): string | null {
  try {
    return require("node:fs").realpathSync(p);
  } catch {
    return null;
  }
}

async function resolveWorkspace(cwd: string): Promise<Resolved> {
  await ensureGit();
  const stored = kvGet("workspace");
  const want = stored && stored.length > 0 ? stored : null;
  if (!want) {
    throw new Error(`cwd-not-allowed: ${cwd}（kv workspace 为空）`);
  }

  // 目录不存在（会话绑定的目录被删/移走）与"无权访问"分开报：读命令可以按
  // 无仓库静默处理，写命令仍拿到明确原因；渲染层也据此显示"工作目录不存在"。
  const exists = existsSync(cwd);
  const a = exists ? tryRealpath(cwd) : null;
  if (!a) {
    throw new Error(`cwd-missing: ${cwd}${exists ? "（不可解析）" : ""}`);
  }
  const b = tryRealpath(want);
  if (!b) throw new Error(`workspace-missing: ${want}（不可解析）`);

  if (a !== b) throw new Error(`cwd-not-allowed: ${cwd} != ${want}`);
  return { run: cwd, key: a };
}

/* ------------------------------ 写命令串行化 ------------------------------ */

const cwdLocks = new Map<string, Promise<unknown>>();
function withCwdLock<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = cwdLocks.get(key) ?? Promise.resolve();
  const next = prev.then(f, f); // 前一个任务失败不阻塞下一个
  cwdLocks.set(key, next.catch(() => undefined));
  return next as Promise<T>;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function emitChanged(cwd: string): void {
  emitToWindows("git-changed", { cwd });
}

/* ------------------------------ porcelain v2 解析 ------------------------------ */

export interface StatusFile {
  path: string;
  oldPath: string | null;
  kind: string;
  staged: boolean;
}

interface ParsedStatus {
  oid: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
}

function classify(path: string, oldPath: string | null, xy: string): StatusFile {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  const untracked = xy === "??";
  const staged = !untracked && x !== "." && x !== " ";
  let kind: string;
  if (untracked) kind = "?";
  else if (x === "D" || y === "D") kind = "D";
  else if (x === "R" || y === "R" || x === "C" || y === "C") kind = "R";
  else if (x === "A") kind = "A";
  else kind = "M";
  return { path, oldPath, kind, staged };
}

export function parseStatusV2(raw: Buffer): ParsedStatus {
  const recs = raw.toString("utf8").split("\0");
  const out: ParsedStatus = { oid: "", head: "", upstream: null, ahead: 0, behind: 0, files: [] };
  let i = 0;
  while (i < recs.length) {
    const rec = recs[i++];
    if (!rec) continue;
    if (rec.startsWith("# branch.oid ")) out.oid = rec.slice("# branch.oid ".length);
    else if (rec.startsWith("# branch.head ")) out.head = rec.slice("# branch.head ".length);
    else if (rec.startsWith("# branch.upstream ")) out.upstream = rec.slice("# branch.upstream ".length);
    else if (rec.startsWith("# branch.ab ")) {
      const parts = rec.slice("# branch.ab ".length).split(" ");
      out.ahead = parseInt(parts[0]?.replace("+", "") ?? "0", 10) || 0;
      out.behind = parseInt(parts[1]?.replace("-", "") ?? "0", 10) || 0;
    } else if (rec.startsWith("1 ")) {
      const parts = rec.slice(2).split(" ", 8);
      if (parts.length < 8) continue;
      out.files.push(classify(parts[7], null, parts[0]));
    } else if (rec.startsWith("2 ")) {
      const parts = rec.slice(2).split(" ", 9);
      if (parts.length < 9) continue;
      let old: string | null = null;
      if (i < recs.length) {
        old = recs[i++];
      }
      out.files.push(classify(parts[8], old, parts[0]));
    } else if (rec.startsWith("u ")) {
      const parts = rec.slice(2).split(" ", 11);
      if (parts.length < 11) continue;
      out.files.push(classify(parts[10], null, parts[0]));
    } else if (rec.startsWith("? ")) {
      out.files.push(classify(rec.slice(2), null, "??"));
    }
  }
  return out;
}

function statusFileJson(f: StatusFile): any {
  return { path: f.path, oldPath: f.oldPath, status: f.kind, staged: f.staged };
}

const UNIT_SEP = "\u001f";
const RECORD_SEP = "\u001e";

async function lastCommitJson(cwd: string): Promise<any> {
  const o = await gitRun(userGit(cwd, ["log", "-1", "--pretty=format:%H%x1f%h%x1f%ct%x1f%s"]));
  if (!o.ok) return null;
  const parts = o.stdout.toString("utf8").split(UNIT_SEP);
  if (parts.length < 4) return null;
  return {
    hash: parts[0],
    short: parts[1],
    time: (parseInt(parts[2], 10) || 0) * 1000,
    subject: parts[3],
  };
}

async function statusImpl(cwd: string): Promise<any> {
  const o = await gitRun(userGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]));
  if (!o.ok) {
    if (o.stderr.includes("not a git repository")) throw new Error("not-repo");
    throw new Error(`git-status-failed: ${o.stderr}`);
  }
  const p = parseStatusV2(o.stdout);
  const detached = p.head.startsWith("(detached");
  const unborn = p.head.startsWith("(unborn");
  const branch = detached ? p.oid.slice(0, 7) : unborn ? "" : p.head;
  return {
    branch,
    detached,
    unborn,
    upstream: p.upstream,
    ahead: p.ahead,
    behind: p.behind,
    files: p.files.map(statusFileJson),
    dirty: p.files.length,
    lastCommit: await lastCommitJson(cwd),
  };
}

/** 目录缺失时的空状态：形状与正常 status 一致，额外带 missing 供 UI 区分
 *  "不是仓库" 与 "目录不存在"。 */
function missingStatus(missing: "cwd" | "workspace") {
  return {
    branch: "",
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    dirty: 0,
    lastCommit: null,
    missing,
  };
}

/* ------------------------------ diff ------------------------------ */

export function patchStats(patch: string): [number, number, boolean] {
  let added = 0;
  let removed = 0;
  let binary = false;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("copy ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return [added, removed, binary];
}

function capPatchChars(s: string): [string, boolean] {
  if (Buffer.byteLength(s, "utf8") <= MAX_DIFF_FILE_BYTES) return [s, false];
  const buf = Buffer.from(s, "utf8").subarray(0, MAX_DIFF_FILE_BYTES);
  return [buf.toString("utf8"), true];
}

function untrackedDiffEntry(cwd: string, path: string, staged: boolean): any {
  const abs = join(cwd, path);
  let raw: Buffer = Buffer.alloc(0);
  try {
    raw = readFileSync(abs);
  } catch {
    raw = Buffer.alloc(0);
  }
  if (raw.includes(0)) {
    return { path, status: "?", staged, added: 0, removed: 0, binary: true, patch: "" };
  }
  const [text, capped] = capPatchChars(raw.toString("utf8"));
  const all = text.split("\n");
  const lines = all.length > 0 && all[all.length - 1] === "" ? all.slice(0, -1) : all;
  const patch =
    `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") + "\n";
  return { path, status: "?", staged, added: lines.length, removed: 0, binary: false, patch, truncated: capped };
}

function diffFileJson(f: StatusFile, patch: string, added: number, removed: number, binary: boolean): any {
  return {
    path: f.path,
    oldPath: f.oldPath,
    status: f.kind,
    staged: f.staged,
    added,
    removed,
    binary,
    patch,
  };
}

async function diffHeadImpl(cwd: string): Promise<any> {
  await ensureRepo(cwd);
  const o = await gitRun(userGit(cwd, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]));
  if (!o.ok) throw new Error(`git-status-failed: ${o.stderr}`);
  const p = parseStatusV2(o.stdout);
  const files: any[] = [];
  let total = 0;
  let truncated = false;
  for (const f of p.files) {
    if (files.length >= MAX_DIFF_FILES || total > MAX_DIFF_TOTAL_BYTES) {
      truncated = true;
      files.push(diffFileJson(f, "", 0, 0, false));
      continue;
    }
    if (f.kind === "?") {
      const e = untrackedDiffEntry(cwd, f.path, f.staged);
      total += Buffer.byteLength(e.patch ?? "", "utf8");
      files.push(e);
      continue;
    }
    const rest = ["diff", "HEAD", "--no-color", "--unified=3", "--no-ext-diff", "--", `:(literal)${f.path}`];
    if (f.oldPath) rest.push(`:(literal)${f.oldPath}`);
    const d = await gitRun(userGit(cwd, rest));
    if (!d.ok) {
      files.push(diffFileJson(f, "", 0, 0, false));
      continue;
    }
    const [patch, capped] = capPatchChars(d.stdout.toString("utf8"));
    const [added, removed, binary] = patchStats(patch);
    total += Buffer.byteLength(patch, "utf8");
    truncated ||= capped;
    files.push(diffFileJson(f, patch, added, removed, binary));
  }
  return { files, truncated };
}

/* ------------------------------ show / worktree / log ------------------------------ */

function checkReference(r: string): void {
  const ok =
    r.length > 0 &&
    r.length <= 100 &&
    !r.startsWith("-") &&
    /^[A-Za-z0-9..^~_/@-]+$/.test(r);
  if (!ok) throw new Error("bad-reference");
}

function checkHash(h: string): void {
  if (!(h.length >= 7 && h.length <= 64 && /^[0-9a-fA-F]+$/.test(h))) throw new Error("bad-hash");
}

function capShow(s: string): [string, boolean] {
  if (Buffer.byteLength(s, "utf8") <= MAX_SHOW_BYTES) return [s, false];
  const buf = Buffer.from(s, "utf8").subarray(0, MAX_SHOW_BYTES);
  return [buf.toString("utf8"), true];
}

async function showImpl(cwd: string, reference: string, path: string): Promise<any> {
  await ensureRepo(cwd);
  checkReference(reference);
  const o = await gitRun(userGit(cwd, ["show", `${reference}:${path}`]));
  if (!o.ok) throw new Error(`git-show-failed: ${o.stderr}`);
  const binary = o.stdout.includes(0);
  const [content, truncated] = binary ? ["", false] : capShow(o.stdout.toString("utf8"));
  return { content, truncated, binary };
}

async function worktreeReadImpl(cwd: string, path: string): Promise<any> {
  await ensureRepo(cwd);
  const rel = normalize(path);
  if (isAbsolute(path) || rel.startsWith("..") || rel.includes("/../") || rel.includes("\\..\\") || rel.split(/[\\/]/).includes("..")) {
    throw new Error("bad-path");
  }
  const t = await gitRun(userGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!t.ok) throw new Error("not-repo");
  const root = t.stdout.toString("utf8").trimEnd();
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, rel));
  } catch {
    throw new Error("read-failed");
  }
  const binary = bytes.includes(0);
  const [content, truncated] = binary ? ["", false] : capShow(bytes.toString("utf8"));
  return { content, truncated, binary };
}

async function logImpl(cwd: string, limit: number): Promise<any> {
  await ensureRepo(cwd);
  const n = String(Math.max(1, Math.min(200, limit)));
  const o = await gitRun(userGit(cwd, ["log", "-n", n, "--no-color", "--pretty=format:%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1e"]));
  if (!o.ok) return []; // unborn HEAD：空历史而非报错
  return o.stdout
    .toString("utf8")
    .split(RECORD_SEP)
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const clean = rec.replace(/^[\r\n]+/, "");
      const parts = clean.split(UNIT_SEP);
      if (parts.length < 5) return null;
      return {
        hash: parts[0],
        short: parts[1],
        time: (parseInt(parts[2], 10) || 0) * 1000,
        author: parts[3],
        subject: parts[4],
      };
    })
    .filter(Boolean);
}

function parseRefs(decor: string): any[] {
  let raw = decor.trim();
  if (raw.startsWith("(") && raw.endsWith(")")) raw = raw.slice(1, -1);
  if (!raw) return [];
  const out: any[] = [];
  for (const partRaw of raw.split(", ")) {
    const part = partRaw.trim();
    let name: string;
    let kind: string;
    if (part.startsWith("tag: ")) {
      const t = part.slice(5);
      name = t.startsWith("refs/tags/") ? t.slice("refs/tags/".length) : t;
      kind = "tag";
    } else if (part.startsWith("HEAD -> ")) {
      out.push({ name: "HEAD", kind: "head" });
      const t = part.slice(8);
      name = t.startsWith("refs/heads/") ? t.slice("refs/heads/".length) : t;
      kind = "branch";
    } else if (part === "HEAD" || part.startsWith("HEAD ")) {
      name = "HEAD";
      kind = "head";
    } else if (part.startsWith("refs/heads/")) {
      name = part.slice("refs/heads/".length);
      kind = "branch";
    } else if (part.startsWith("refs/remotes/")) {
      name = part.slice("refs/remotes/".length);
      kind = "remote";
    } else if (part.startsWith("refs/tags/")) {
      name = part.slice("refs/tags/".length);
      kind = "tag";
    } else {
      continue;
    }
    out.push({ name, kind });
  }
  return out;
}

async function logGraphImpl(cwd: string, limit: number): Promise<any> {
  await ensureRepo(cwd);
  const n = String(Math.max(1, Math.min(300, limit)));
  const o = await gitRun(
    userGit(cwd, [
      "log",
      "--topo-order",
      "-n",
      n,
      "--branches",
      "--remotes",
      "--no-color",
      "--decorate=full",
      "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ct%x1f%s%x1e",
    ]),
  );
  if (!o.ok) return [];
  return o.stdout
    .toString("utf8")
    .split(RECORD_SEP)
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const clean = rec.replace(/^[\r\n]+/, "");
      const parts = clean.split(UNIT_SEP);
      if (parts.length < 6) return null;
      return {
        hash: parts[0],
        parents: parts[1].split(/\s+/).filter(Boolean),
        refs: parseRefs(parts[2]),
        author: parts[3],
        time: (parseInt(parts[4], 10) || 0) * 1000,
        subject: parts[5],
      };
    })
    .filter(Boolean);
}

/* ------------------------------ 影子仓库检查点 ------------------------------ */

/** FNV-1a 64 位十六进制（影子仓库目录名，与 Rust 版同算法同结果） */
export function fnv1aHex(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(s, "utf8")) {
    h ^= BigInt(byte);
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, "0");
}

function shadowDirFor(canonCwd: string): string {
  return join(appDataDir(), "checkpoints", fnv1aHex(canonCwd));
}

async function ensureShadow(gitDir: string): Promise<void> {
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true });
    const o = await gitRun(["init", "-q", "--bare", gitDir]);
    if (!o.ok) throw new Error(`shadow-init-failed: ${o.stderr}`);
    for (const args of [
      ["--git-dir", gitDir, "config", "core.bare", "false"],
      ["--git-dir", gitDir, "symbolic-ref", "HEAD", "refs/heads/main"],
    ]) {
      const r = await gitRun(args);
      if (!r.ok) throw new Error(`shadow-init-failed: ${r.stderr}`);
    }
  }
  // init --bare 自带模板 info/exclude：以 marker 幂等追加（老影子仓库补齐）
  const info = join(gitDir, "info");
  mkdirSync(info, { recursive: true });
  const exclude = join(info, "exclude");
  let existing = "";
  try {
    existing = readFileSync(exclude, "utf8");
  } catch {
    existing = "";
  }
  if (!existing.includes(SHADOW_EXCLUDE_MARKER)) {
    let body = existing;
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += SHADOW_EXCLUDE_MARKER + "\n" + SHADOW_EXCLUDES;
    writeFileSync(exclude, body);
  }
}

function sanitizeTag(tag: string): string {
  let s = tag.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  if (s.length > 40) s = s.slice(0, 40).replace(/^-+/, "").replace(/-+$/, "");
  return s.length > 0 ? s : "run";
}

async function listCheckpointRefs(dir: string, work: string): Promise<[string, string][]> {
  const o = await gitRun(shadowGit(dir, work, ["for-each-ref", "--format=%(refname)\t%(objectname)", CHECKPOINT_REF_PREFIX]));
  if (!o.ok) return [];
  return o.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf("\t");
      if (idx < 0) return null;
      return [line.slice(0, idx), line.slice(idx + 1).trim()] as [string, string];
    })
    .filter((x): x is [string, string] => x !== null);
}

async function shadowAdd(dir: string, work: string): Promise<void> {
  const add = await gitRun(shadowGit(dir, work, ["add", "-A"]));
  if (add.ok) return;
  const retry = await gitRun(shadowGit(dir, work, ["add", "-A", "--ignore-errors"]));
  if (retry.ok) return;
  const staged = await gitRun(shadowGit(dir, work, ["diff", "--cached", "--name-only"]));
  if (staged.stdout.length === 0) throw new Error(add.stderr);
}

async function commitCheckpointTree(dir: string, work: string, tree: string, tag: string, parent: string | null): Promise<string> {
  const args = ["commit-tree", tree, "-m", tag];
  if (parent) args.push("-p", parent);
  const commit = await gitRun(shadowGit(dir, work, args), {
    env: {
      GIT_AUTHOR_NAME: "Kova Checkpoints",
      GIT_AUTHOR_EMAIL: "checkpoints@kova.local",
      GIT_COMMITTER_NAME: "Kova Checkpoints",
      GIT_COMMITTER_EMAIL: "checkpoints@kova.local",
    },
  });
  if (!commit.ok) throw new Error(`snapshot-commit-failed: ${commit.stderr}`);
  return commit.stdout.toString("utf8").trim();
}

function patchFilePath(dir: string, hash: string): string {
  return join(dir, "kova-patches", `${hash}.patch`);
}

async function pruneCheckpoints(dir: string, keepRef: string, entries: [string, string][]): Promise<void> {
  if (entries.length + 1 <= CHECKPOINT_KEEP) return;
  let doomed = entries.length + 1 - CHECKPOINT_KEEP;
  for (const [r, h] of entries) {
    if (doomed === 0) break;
    if (r === keepRef) continue;
    doomed -= 1;
    await gitRun(shadowGit(dir, ".", ["update-ref", "-d", r]));
    try {
      rmSync(patchFilePath(dir, h), { force: true });
    } catch {
      /* ignore */
    }
  }
  await gitRun(shadowGit(dir, ".", ["gc", "--auto", "--quiet"]));
}

async function snapshotImpl(dir: string, work: string, tag: string): Promise<string> {
  try {
    await shadowAdd(dir, work);
  } catch (e: any) {
    throw new Error(`snapshot-add-failed: ${e?.message ?? e}`);
  }
  const treeOut = await gitRun(shadowGit(dir, work, ["write-tree"]));
  if (!treeOut.ok) throw new Error(`snapshot-tree-failed: ${treeOut.stderr}`);
  const tree = treeOut.stdout.toString("utf8").trim();
  const refsBefore = await listCheckpointRefs(dir, work);
  let parent: string | null = null;
  for (let i = refsBefore.length - 1; i >= 0; i--) {
    try {
      checkHash(refsBefore[i][1]);
      parent = refsBefore[i][1];
      break;
    } catch {
      /* 非法 hash 跳过 */
    }
  }
  let hash: string;
  if (parent) {
    const pt = await gitRun(shadowGit(dir, work, ["rev-parse", `${parent}^{tree}`]));
    const parentTree = pt.ok ? pt.stdout.toString("utf8").trim() : "";
    hash = tree.length > 0 && parentTree === tree ? parent : await commitCheckpointTree(dir, work, tree, tag, parent);
  } else {
    hash = await commitCheckpointTree(dir, work, tree, tag, null);
  }
  if (parent !== hash) checkHash(hash);
  const refname = `${CHECKPOINT_REF_PREFIX}/${String(nowSecs()).padStart(11, "0")}-${sanitizeTag(tag)}`;
  const ur = await gitRun(shadowGit(dir, work, ["update-ref", refname, hash]));
  if (!ur.ok) throw new Error(`snapshot-ref-failed: ${ur.stderr}`);
  await pruneCheckpoints(dir, refname, refsBefore);
  return hash;
}

function parseNameStatusZ(raw: Buffer): [string, string | null, string][] {
  const recs = raw.toString("utf8").split("\0");
  const out: [string, string | null, string][] = [];
  let i = 0;
  while (i < recs.length) {
    const status = recs[i++];
    if (!status) continue;
    const c = status[0] ?? "M";
    if (c === "R" || c === "C") {
      if (i + 1 >= recs.length) break;
      const oldP = recs[i];
      const newP = recs[i + 1];
      i += 2;
      out.push([c, oldP, newP]);
    } else if (i < recs.length) {
      out.push([c, null, recs[i++]]);
    }
  }
  return out;
}

async function checkpointFilesImpl(dir: string, work: string, hash: string): Promise<any> {
  try {
    await shadowAdd(dir, work);
  } catch (e: any) {
    throw new Error(`snapshot-stage-failed: ${e?.message ?? e}`);
  }
  // 顺带持久化"当前时刻"的全量 binary diff（restore 的回放依据）
  try {
    const d = await gitRun(shadowGit(dir, work, ["diff", hash, "--binary", "--no-color", "--no-ext-diff"]));
    if (d.ok && d.stdout.length <= MAX_PATCH_FILE_BYTES) {
      const pf = patchFilePath(dir, hash);
      mkdirSync(join(dir, "kova-patches"), { recursive: true });
      writeFileSync(pf, d.stdout);
    }
  } catch {
    /* 存档失败降级为实时 diff */
  }
  const ns = await gitRun(shadowGit(dir, work, ["diff", hash, "--name-status", "-z"]));
  if (!ns.ok) throw new Error(`snapshot-diff-failed: ${ns.stderr}`);
  const list = parseNameStatusZ(ns.stdout);
  const files: any[] = [];
  let total = 0;
  let truncated = false;
  for (const [status, old, path] of list) {
    if (files.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    const entry = (patch: string, added: number, removed: number, binary: boolean) => ({
      path,
      oldPath: old,
      status,
      staged: false,
      added,
      removed,
      binary,
      patch,
    });
    if (total > MAX_DIFF_TOTAL_BYTES) {
      truncated = true;
      files.push(entry("", 0, 0, false));
      continue;
    }
    const rest = ["diff", hash, "--no-color", "--unified=3", "--no-ext-diff", "--", `:(literal)${path}`];
    if (old) rest.push(`:(literal)${old}`);
    const d = await gitRun(shadowGit(dir, work, rest));
    if (!d.ok) {
      files.push(entry("", 0, 0, false));
      continue;
    }
    const [patch, capped] = capPatchChars(d.stdout.toString("utf8"));
    const [added, removed, binary] = patchStats(patch);
    total += Buffer.byteLength(patch, "utf8");
    truncated ||= capped;
    files.push(entry(patch, added, removed, binary));
  }
  return { files, truncated };
}

/**
 * 产物发现专用：只回本轮改动文件名/状态，不算 patch。
 * 产物页签会一次看多个检查点，走完整 checkpointFilesImpl 会把每个 diff 的
 * 补丁都读一遍（还被 3 行上下文放大），这里只做 name-status。
 */
async function checkpointNameStatusImpl(
  dir: string,
  work: string,
  hash: string,
): Promise<{
  files: { path: string; oldPath: string | null; status: string }[];
}> {
  try {
    await shadowAdd(dir, work);
  } catch (e: any) {
    throw new Error(`snapshot-stage-failed: ${e?.message ?? e}`);
  }
  const ns = await gitRun(
    shadowGit(dir, work, ["diff", hash, "--name-status", "-z"]),
  );
  if (!ns.ok) throw new Error(`snapshot-diff-failed: ${ns.stderr}`);
  return {
    files: parseNameStatusZ(ns.stdout).map(([status, oldPath, path]) => ({
      path,
      oldPath,
      status,
    })),
  };
}

async function restoreImpl(dir: string, work: string, hash: string): Promise<void> {
  const pf = patchFilePath(dir, hash);
  let patch: Buffer;
  try {
    patch = readFileSync(pf);
  } catch {
    try {
      await shadowAdd(dir, work);
    } catch (e: any) {
      throw new Error(`snapshot-stage-failed: ${e?.message ?? e}`);
    }
    const d = await gitRun(shadowGit(dir, work, ["diff", hash, "--binary", "--no-color", "--no-ext-diff"]));
    if (!d.ok) throw new Error(`snapshot-diff-failed: ${d.stderr}`);
    patch = d.stdout;
  }
  if (patch.length === 0) {
    try {
      rmSync(pf, { force: true });
    } catch {
      /* ignore */
    }
    return; // 快照后无任何改动
  }
  const check = await gitRun(userGit(work, ["apply", "-R", "--check", "--binary", "--allow-empty"]), { stdin: patch });
  if (!check.ok) throw new Error(`apply-conflict: ${check.stderr}`);
  const ap = await gitRun(userGit(work, ["apply", "-R", "--binary", "--allow-empty"]), { stdin: patch });
  if (!ap.ok) throw new Error(`apply-failed: ${ap.stderr}`);
  try {
    rmSync(pf, { force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------ stage / commit / branch ------------------------------ */

function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

async function stageImpl(cwd: string, paths: string[], on: boolean): Promise<void> {
  await ensureRepo(cwd);
  const rest =
    paths.length === 0
      ? on
        ? ["add", "-A"]
        : ["reset", "-q"]
      : on
        ? ["add", "--", ...literalPathspecs(paths)]
        : ["reset", "-q", "--", ...literalPathspecs(paths)];
  const o = await gitRun(userGit(cwd, rest));
  if (!o.ok) throw new Error(`git-stage-failed: ${o.stderr}`);
}

async function commitImpl(cwd: string, message: string): Promise<any> {
  await ensureRepo(cwd);
  if (!message.trim()) throw new Error("empty-message");
  const o = await gitRun(userGit(cwd, ["commit", "-q", "--no-verify", "-F", "-"]), {
    stdin: Buffer.from(message, "utf8"),
  });
  if (!o.ok) throw new Error(`git-commit-failed: ${o.stderr}`);
  const h = await gitRun(userGit(cwd, ["rev-parse", "HEAD"]));
  return { hash: h.stdout.toString("utf8").trim() };
}

function validateBranchName(name: string): void {
  const ok =
    name.length > 0 &&
    name.length <= 100 &&
    !name.startsWith("-") &&
    !name.startsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("@{") &&
    /^[A-Za-z0-9._/-]+$/.test(name);
  if (!ok) throw new Error("bad-branch-name");
}

async function branchesImpl(cwd: string): Promise<any> {
  await ensureRepo(cwd);
  const sym = await gitRun(userGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
  const current = sym.ok ? sym.stdout.toString("utf8").trim() : null;
  const o = await gitRun(userGit(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)%1f%(upstream:short)"]));
  if (!o.ok) throw new Error(`git-branch-failed: ${o.stderr}`);
  const branches = o.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream] = line.split(UNIT_SEP);
      if (!name) return null;
      return { name, current: name === current, upstream: upstream && upstream.length > 0 ? upstream : null };
    })
    .filter(Boolean);
  return { current, detached: current === null, branches };
}

async function checkoutImpl(cwd: string, name: string, create: boolean): Promise<void> {
  await ensureRepo(cwd);
  validateBranchName(name);
  const rest = ["checkout", "-q"];
  if (create) rest.push("-b");
  rest.push(name);
  const o = await gitRun(userGit(cwd, rest));
  if (!o.ok) throw new Error(`git-checkout-failed: ${o.stderr}`);
}

/* ------------------------------ 命令注册 ------------------------------ */

export function setupGitCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("git_probe", async () => {
    const v = await gitVersion();
    return { available: v !== null, version: v };
  });

  register("git_status", async (a) => {
    const cwd = String(a.cwd);
    try {
      const r = await resolveWorkspace(cwd);
      return await statusImpl(r.run);
    } catch (err) {
      // 目录缺失是终端用户状态，不是系统错误：返回带 missing 的空状态，
      // 渲染层据此显示"工作目录不存在"，也避免每次 focus 都记一条 ERROR。
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("cwd-missing")) return missingStatus("cwd");
      if (msg.startsWith("workspace-missing")) return missingStatus("workspace");
      throw err;
    }
  });

  register("git_diff", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    await ensureRepo(r.run);
    const checkpoint = typeof a.checkpoint === "string" && a.checkpoint ? a.checkpoint : null;
    if (!checkpoint) return diffHeadImpl(r.run);
    checkHash(checkpoint);
    const sd = shadowDirFor(r.key);
    if (!existsSync(join(sd, "HEAD"))) throw new Error("no-checkpoint");
    const e = await gitRun(["--git-dir", sd, "cat-file", "-e", `${checkpoint}^{commit}`]);
    if (!e.ok) throw new Error("no-checkpoint");
    return checkpointFilesImpl(sd, r.run, checkpoint);
  });

  // 产物发现：只回本轮改动文件清单，不传 patch。
  register("git_checkpoint_files", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    const hash = String(a.hash ?? "");
    checkHash(hash);
    const sd = shadowDirFor(r.key);
    if (!existsSync(join(sd, "HEAD"))) throw new Error("no-checkpoint");
    const e = await gitRun(["--git-dir", sd, "cat-file", "-e", `${hash}^{commit}`]);
    if (!e.ok) throw new Error("no-checkpoint");
    return checkpointNameStatusImpl(sd, r.run, hash);
  });

  register("git_show", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    return showImpl(r.run, String(a.reference), String(a.path));
  });

  register("git_worktree_read", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    return worktreeReadImpl(r.run, String(a.path));
  });

  register("git_log", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    return logImpl(r.run, Number.isFinite(Number(a.limit)) ? Number(a.limit) : 50);
  });

  register("git_log_graph", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    return logGraphImpl(r.run, Number.isFinite(Number(a.limit)) ? Number(a.limit) : 200);
  });

  register("git_checkpoint_create", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    await ensureRepo(r.run);
    const sd = shadowDirFor(r.key);
    const hash = await withCwdLock(r.key, async () => {
      await ensureShadow(sd);
      return snapshotImpl(sd, r.run, String(a.tag ?? ""));
    });
    emitChanged(r.run);
    return { hash };
  });

  register("git_checkpoint_restore", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    await ensureRepo(r.run);
    const hash = String(a.hash);
    checkHash(hash);
    const sd = shadowDirFor(r.key);
    if (!existsSync(join(sd, "HEAD"))) throw new Error("no-checkpoint");
    await withCwdLock(r.key, () => restoreImpl(sd, r.run, hash));
    emitChanged(r.run);
    return { restored: true };
  });

  register("git_stage", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
    await withCwdLock(r.key, () => stageImpl(r.run, paths, Boolean(a.on)));
    emitChanged(r.run);
    return { ok: true };
  });

  register("git_commit", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    const res = await withCwdLock(r.key, () => commitImpl(r.run, String(a.message ?? "")));
    emitChanged(r.run);
    return res;
  });

  register("git_branches", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    return branchesImpl(r.run);
  });

  register("git_checkout", async (a) => {
    const r = await resolveWorkspace(String(a.cwd));
    await withCwdLock(r.key, () => checkoutImpl(r.run, String(a.name), Boolean(a.create)));
    emitChanged(r.run);
    return { ok: true };
  });
}
