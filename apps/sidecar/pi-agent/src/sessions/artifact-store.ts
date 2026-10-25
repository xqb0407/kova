/**
 * 工具输出外置落盘：把超限文本写到 `<sessionsDir>/artifacts/<sessionId>/`，
 * 返回绝对路径供模型用 read/grep 按需取回。
 *
 * 安全与生命周期：
 * - 路径段白名单清洗，目录经 realpath 校验必须仍在 artifacts 根内；
 * - 同目录临时文件 + rename，rename 替换符号链接本身而不是跟随它；
 * - 单文件 8MB 上限；每会话按文件数与总字节数淘汰最旧；
 * - 会话删除时可整目录清理。
 */
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { logErr } from "../log";
import { sessionsDirRoot } from "../storage/storage";

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_MAX_FILES_PER_SESSION = 200;
export const ARTIFACT_MAX_TOTAL_BYTES_PER_SESSION = 200 * 1024 * 1024;

export type ToolArtifactInput = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
};

export type ToolArtifact = {
  readonly reference: string;
  readonly bytes: number;
  readonly truncated: boolean;
};

export type ArtifactStoreOptions = {
  readonly root?: string;
  readonly maxFilesPerSession?: number;
  readonly maxTotalBytesPerSession?: number;
};

function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "unknown";
}

/**
 * 按字节区间切 UTF-8：切点落在多字节序列中间时对齐到序列边界，避免解码出
 * 替换字符。起点撞续字节前进到下一个序列头；终点撞续字节回退到该序列头之前
 * （不完整的序列整段丢弃，宁可少一个字也不出 �）。
 */
export function sliceUtf8(buffer: Buffer, start: number, end: number): string {
  let from = Math.max(0, Math.min(start, buffer.length));
  let to = Math.max(from, Math.min(end, buffer.length));
  while (from < to && (buffer[from] & 0xc0) === 0x80) from += 1;
  while (to > from && to < buffer.length && (buffer[to] & 0xc0) === 0x80) to -= 1;
  return buffer.subarray(from, to).toString("utf8");
}

function artifactRoot(options: ArtifactStoreOptions): string {
  // 事实源是 storage 初始化时传入的会话根（生产/host 模式与 local 模式都走它）；
  // 未初始化的裸环境（单测直调）才回落环境变量，避免两套来源写出两个目录。
  // 注意 sessionsDirRoot() 未初始化时返回空串，?? 跳不过空串——这里必须用 ||
  // 串联，否则环境变量分支永远走不到，artifact 会落进 process.cwd()。
  const fromStorage = sessionsDirRoot();
  return resolve(
    options.root ?? (fromStorage || process.env.PI_SESSIONS_DIR || "./sessions"),
  );
}

function artifactsRoot(options: ArtifactStoreOptions): string {
  return join(artifactRoot(options), "artifacts");
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

async function pruneSessionDirectory(
  directory: string,
  maxFiles: number,
  maxTotalBytes: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const files: { path: string; mtimeMs: number; size: number }[] = [];
  for (const entry of entries) {
    // 只处理普通文件：符号链接/子目录不在这里淘汰，避免误删或跟随。
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // 文件在扫描窗口内消失：忽略。
    }
  }

  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let count = files.length;
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (count <= maxFiles && total <= maxTotalBytes) break;
    try {
      await unlink(file.path);
      count -= 1;
      total -= file.size;
    } catch {
      // 淘汰是尽力而为，不影响本次写入。
    }
  }
}

export async function writeToolArtifact(
  input: ToolArtifactInput,
  options: ArtifactStoreOptions = {},
): Promise<ToolArtifact> {
  const root = artifactsRoot(options);
  await mkdir(root, { recursive: true, mode: 0o700 });

  const directory = join(root, safeSegment(input.sessionId));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // 目录可能是符号链接：解析后必须仍在 artifacts 根内，否则拒绝写入。
  let realRoot: string;
  let realDirectory: string;
  try {
    realRoot = await realpath(root);
    realDirectory = await realpath(directory);
  } catch (error) {
    throw new Error(`artifact directory is unavailable: ${String(error)}`);
  }
  if (!isWithin(realRoot, realDirectory)) {
    throw new Error("artifact directory escapes the artifacts root");
  }

  const fileName =
    `${safeSegment(input.turnId)}-${safeSegment(input.toolCallId)}-` +
    `${safeSegment(input.toolName)}.txt`;
  const target = join(realDirectory, fileName);

  const raw = Buffer.from(input.text, "utf8");
  const truncated = raw.byteLength > ARTIFACT_MAX_BYTES;
  const body = truncated
    ? `${sliceUtf8(raw, 0, ARTIFACT_MAX_BYTES)}\n…[artifact truncated at ${ARTIFACT_MAX_BYTES} bytes]\n`
    : input.text;

  // 临时文件 + rename：rename 替换目标（包括目标是符号链接时替换链接本身），
  // 既避免半截文件，也避免跟随符号链接写到根外。
  const temp = join(
    realDirectory,
    `.${fileName}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  const maxFiles = Math.max(
    1,
    options.maxFilesPerSession ?? ARTIFACT_MAX_FILES_PER_SESSION,
  );
  const maxTotalBytes = Math.max(
    1,
    options.maxTotalBytesPerSession ?? ARTIFACT_MAX_TOTAL_BYTES_PER_SESSION,
  );
  await pruneSessionDirectory(realDirectory, maxFiles, maxTotalBytes).catch(
    (error) => logErr("artifact-store: prune failed:", error),
  );

  return { reference: target, bytes: Buffer.byteLength(body, "utf8"), truncated };
}

/** 会话删除时清掉它的 artifact 目录；符号链接只删链接本身。 */
export async function removeSessionArtifacts(
  sessionId: string,
  options: ArtifactStoreOptions = {},
): Promise<void> {
  const root = artifactsRoot(options);
  const directory = join(root, safeSegment(sessionId));
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      await unlink(directory);
      return;
    }
    if (!info.isDirectory()) return;
  } catch {
    return;
  }

  try {
    const realRoot = await realpath(root);
    const realDirectory = await realpath(directory);
    if (!isWithin(realRoot, realDirectory)) return;
    await rm(realDirectory, { recursive: true, force: true });
  } catch (error) {
    logErr("artifact-store: remove session artifacts failed:", error);
  }
}
