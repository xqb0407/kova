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
  chmod,
  copyFile,
  link,
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
import { basename, dirname, join, resolve, sep } from "node:path";
import { logErr } from "../log";
import { sessionsDirRoot } from "../storage/storage";

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_MAX_FILES_PER_SESSION = 200;
export const ARTIFACT_MAX_TOTAL_BYTES_PER_SESSION = 200 * 1024 * 1024;

/**
 * 回执行里 artifact 路径行的前缀（tool-budget 的 buildReceipt 写入，
 * fork 收养时按它收集引用）。放这里做单源：格式变更不会漂移。
 */
export const ARTIFACT_RECEIPT_LINE_PREFIX = "Artifact: ";

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
  /** 测试注入：模拟不支持硬链的文件系统（默认 fs.link） */
  readonly linkFile?: (existingPath: string, newPath: string) => Promise<void>;
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

/**
 * 从任意 JSON 值里收集回执引用的 artifact 路径（fork 复制前调用）。
 * 只做提取、不做信任判断——adoptSessionArtifacts 会逐条校验来源目录。
 */
export function collectArtifactReferences(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const line of node.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(ARTIFACT_RECEIPT_LINE_PREFIX)) continue;
        const reference = trimmed
          .slice(ARTIFACT_RECEIPT_LINE_PREFIX.length)
          .trim();
        if (reference) into.add(reference);
      }
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    for (const entry of Object.values(node as Record<string, unknown>)) {
      walk(entry);
    }
  };
  walk(value);
  return into;
}

export type AdoptArtifactsInput = {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly references: Iterable<string>;
  readonly options?: ArtifactStoreOptions;
};

/**
 * fork 收养：把源会话 artifact 硬链到目标会话目录（跨卷/不支持时回退复制），
 * 返回 `旧引用字符串 → 新路径` 映射供调用方改写转录。
 *
 * 安全边界：引用必须 `realpath(dirname) === 源会话目录 realpath` 且是普通文件；
 * 其余一律忽略——转录可能被手改，不能让它把任意文件链进来。
 * 布局约束：当前 artifact 是会话目录下的平铺文件；若将来改为嵌套目录，
 * 需同步调整这里的 dirname 判定（否则只会跳过，不会误链）。
 */
export async function adoptSessionArtifacts(
  input: AdoptArtifactsInput,
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  const references = [...new Set(input.references)];
  if (references.length === 0) return mapping;

  const root = artifactsRoot(input.options ?? {});
  const sourceSegment = safeSegment(input.sourceSessionId);
  const sourceDir = join(root, sourceSegment);
  let realSource: string;
  let realRoot: string;
  try {
    realSource = await realpath(sourceDir);
    realRoot = await realpath(root);
  } catch {
    // 源会话没有 artifact 目录（从未外置/已整体清理）：无事可做
    return mapping;
  }
  // 必须是 canonical 的会话目录本身：目录被替换成符号链接（无论指向根内还是
  // 根外）一律拒绝——否则"dirname === 源目录"的校验会把重定向目标里的文件
  // 当成合法引用。
  if (realSource !== join(realRoot, sourceSegment)) return mapping;

  const targetSegment = safeSegment(input.targetSessionId);
  const targetDir = join(root, targetSegment);
  const linkFile = input.options?.linkFile ?? link;
  // 目标目录惰性创建：全部引用都无效时不留空目录。
  let realTarget: string | undefined;
  const ensureTarget = async (): Promise<string | undefined> => {
    if (realTarget) return realTarget;
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      const resolved = await realpath(targetDir);
      if (
        resolved !== join(realRoot, targetSegment) ||
        resolved === realSource
      ) {
        return undefined;
      }
      realTarget = resolved;
      return resolved;
    } catch (error) {
      logErr("artifact-store: prepare adopt target failed:", error);
      return undefined;
    }
  };

  for (const reference of references) {
    try {
      const info = await lstat(reference).catch((error: NodeJS.ErrnoException) => {
        // 文件已被保留策略淘汰/手工删除：回执保留原路径，属正常情况
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info?.isFile()) continue;
      const realFile = await realpath(reference);
      if (dirname(realFile) !== realSource) continue;
      const directory = await ensureTarget();
      if (!directory) break; // 目标目录不可用：后续引用也不会成功
      const target = join(directory, basename(realFile));
      await unlink(target).catch(() => undefined);
      try {
        await linkFile(realFile, target);
      } catch {
        // 跨卷/文件系统不支持硬链：回退复制（内容独立，行为等价）；
        // copyFile 的模式继承不保证，显式收紧到 0600。
        await copyFile(realFile, target);
        await chmod(target, 0o600).catch(() => undefined);
      }
      mapping.set(reference, target);
    } catch (error) {
      logErr("artifact-store: adopt reference failed:", error);
    }
  }
  return mapping;
}

/**
 * 按映射改写转录行里的路径。用 JSON 转义形态做替换：POSIX 原样，
 * Windows 反斜杠与 JSONL 里的转义一致，避免漏改。未命中的行逐字节不变。
 */
export function rewriteArtifactReferences(
  lines: readonly string[],
  mapping: ReadonlyMap<string, string>,
): string[] {
  if (mapping.size === 0) return [...lines];
  const escaped = (path: string) => JSON.stringify(path).slice(1, -1);
  // 长路径优先：短路径是另一个路径前缀时（x.txt vs x.txt.txt），先替换短的
  // 会把长的改残——按长度降序保证长的先整体命中。
  const pairs = [...mapping.entries()]
    .map(([from, to]) => [escaped(from), escaped(to)] as const)
    .sort((left, right) => right[0].length - left[0].length);
  return lines.map((line) => {
    let next = line;
    for (const [from, to] of pairs) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    return next;
  });
}
