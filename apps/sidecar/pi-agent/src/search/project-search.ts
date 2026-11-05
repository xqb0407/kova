/**
 * 项目搜索（§search 的项目域）：项目文件名/路径 + 代码内容。
 *
 * 内容走 `git grep`（C 速度 + 白送 .gitignore 语义）：-z -n 分隔解析，
 * 输出/匹配数双上限，超界 truncated=true。非 git 目录退化到文件名扫描
 * （不读正文——没有 git 的目录树可能巨大，全量读文件会卡住 mgmt 队列，
 * 文件名命中已够「找那个文件」的用途；正文检索留给接 git 后）。
 *
 * 同步 spawnSync 有 git-prompt.ts 同款先例（每轮一次的量级），由搜索命令
 * 在 mgmt 串行队列上调用——与 prompt 准备段互斥，不抢在写线程的转录。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { open as openFile, readdir as readdirAsync } from "node:fs/promises";
import { join, sep, extname } from "node:path";
import type { RemoteTarget } from "../types";
import { quotePosixShellArg } from "../tools/remote/ssh-exec";
import { remoteExec } from "../tools/remote/exec";
import { remoteListFiles } from "../tools/remote/remote-tool-call";

/** 单次 git grep 输出字节上限（monocode 同量级：4MiB） */
const GREP_MAX_BYTES = 4 * 1024 * 1024;
/** 匹配行上限 */
const GREP_MAX_MATCHES = 200;
/** 文件名扫描的条目上限 */
const NAME_SCAN_MAX = 20000;
/** 正文补扫：文件数 / 总读取字节 / 单文件读取上限 */
const CONTENT_SCAN_MAX_FILES = 400;
const CONTENT_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const CONTENT_READ_BYTES = 64 * 1024;
/** 正文补扫认得的文本扩展名（与资料库索引的抽取口径一致） */
const CONTENT_TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".cjs", ".py", ".rs", ".go", ".java", ".css", ".sh", ".toml", ".yaml",
  ".yml", ".xml", ".html", ".htm", ".svg", ".csv",
]);
const NAME_SCAN_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  ".next", ".turbo", "vendor", "__pycache__", ".venv", "venv",
]);

export type ProjectFileHit = {
  rel: string;
  name: string;
};

export type ProjectContentHit = {
  rel: string;
  name: string;
  line: number;
  preview: string;
};

export type ProjectSearchResult = {
  files: ProjectFileHit[];
  contents: ProjectContentHit[];
  truncated: boolean;
};

const EMPTY: ProjectSearchResult = { files: [], contents: [], truncated: false };

function gitGrep(cwd: string, query: string): { hits: ProjectContentHit[]; truncated: boolean } | null {
  try {
    // 只确认 cwd 在 git 工作区内；grep **在 cwd 里跑**——git grep 在子目录
    // 下默认只搜该子树、输出 cwd 相对路径。此前在 repoRoot 里跑，命中路径是
    // 仓库根相对路径（子目录 cwd 下 kb_read/文件面板都解析不到），还会把 cwd
    // 之外的仓库文件搜出来。
    const root = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf8", timeout: 2000, env: process.env,
    });
    if (root.status !== 0 || root.stdout.trim() !== "true") return null;

    // -z：路径 NUL 分隔（文件名带空格/引号不破）；-n：行号；-F：固定串
    //（子串语义，与内容索引一致；regex 留给后续显式模式）
    const res = spawnSync(
      "git",
      ["grep", "-z", "-n", "-F", "-e", query, "--"],
      { cwd, encoding: "buffer", timeout: 10_000, env: process.env, maxBuffer: GREP_MAX_BYTES * 2 },
    );
    const raw = res.stdout;
    if (!raw || raw.length === 0) return { hits: [], truncated: false };
    // maxBuffer 超限 git 会被杀：按最后一个完整 NUL/换行截断再解析
    const capped = raw.length > GREP_MAX_BYTES;
    const bytes = capped ? raw.subarray(0, GREP_MAX_BYTES) : raw;

    const hits: ProjectContentHit[] = [];
    let truncated = capped;
    let offset = 0;
    while (offset < bytes.length && hits.length < GREP_MAX_MATCHES) {
      // path\0line\0preview\n（-z 下三段 NUL 分隔、行尾换行）
      const pathEnd = bytes.indexOf(0, offset);
      if (pathEnd < 0) { truncated = true; break; }
      const lineEnd = bytes.indexOf(0, pathEnd + 1);
      if (lineEnd < 0) { truncated = true; break; }
      const nl = bytes.indexOf(0x0a, lineEnd + 1);
      const previewEnd = nl < 0 ? bytes.length : nl;
      const rel = bytes.subarray(offset, pathEnd).toString("utf8").replaceAll("\\", "/");
      const line = Number.parseInt(
        bytes.subarray(pathEnd + 1, lineEnd).toString("utf8"), 10,
      );
      const preview = bytes.subarray(lineEnd + 1, previewEnd).toString("utf8");
      offset = (nl < 0 ? bytes.length : nl + 1);
      if (!rel || !Number.isFinite(line)) continue;
      hits.push({ rel, name: rel.split("/").pop() ?? rel, line, preview: preview.trimEnd() });
      if (hits.length >= GREP_MAX_MATCHES) { truncated = true; break; }
    }
    return { hits, truncated };
  } catch {
    return null;
  }
}

/** 非 git 退化：文件名/路径子串匹配（有界深扫，不读正文） */
function scanFileNames(cwd: string, query: string): {
  files: ProjectFileHit[];
  truncated: boolean;
} {
  const files: ProjectFileHit[] = [];
  let visited = 0;
  let truncated = false;
  const needle = query.toLowerCase();
  const walk = (rel: string, depth: number): void => {
    if (truncated) return;
    const abs = rel ? join(cwd, ...rel.split("/")) : cwd;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= NAME_SCAN_MAX) { truncated = true; return; }
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const fileRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (NAME_SCAN_SKIP.has(entry.name) || depth >= 12) continue;
        visited += 1;
        walk(fileRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (fileRel.toLowerCase().includes(needle)) {
        files.push({ rel: fileRel, name: entry.name });
        if (files.length >= GREP_MAX_MATCHES) { truncated = true; return; }
      }
    }
  };
  walk("", 0);
  return { files, truncated };
}

/** 入口：cwd 非法/不存在返回空结果；git grep 优先，非 git 退文件名扫描 */
export function searchProjectDir(cwd: string, query: string): ProjectSearchResult {
  const trimmed = query.trim();
  if (!trimmed) return EMPTY;
  try {
    if (!statSync(cwd).isDirectory()) return EMPTY;
  } catch {
    return EMPTY;
  }
  // 归一 cwd（相对/尾斜杠）
  const base = cwd.replaceAll(sep, "/").replace(/\/+$/, "") || "/";
  const grep = gitGrep(base, trimmed);
  if (grep) {
    // git 仓库：文件名命中从 grep 命中的路径聚合（够用：内容命中本身就带路径）
    const seen = new Set<string>();
    const files: ProjectFileHit[] = [];
    for (const hit of grep.hits) {
      if (seen.has(hit.rel)) continue;
      seen.add(hit.rel);
      files.push({ rel: hit.rel, name: hit.name });
      if (files.length >= GREP_MAX_MATCHES) break;
    }
    // 文件名命中补一轮路径扫描（query 是文件名片段而内容不命中的情况）
    if (files.length < 40) {
      const byName = scanFileNames(base, trimmed);
      for (const f of byName.files) {
        if (seen.has(f.rel)) continue;
        seen.add(f.rel);
        files.push(f);
        if (files.length >= GREP_MAX_MATCHES) break;
      }
      return { files, contents: grep.hits, truncated: grep.truncated || byName.truncated };
    }
    return { files, contents: grep.hits, truncated: grep.truncated };
  }
  const byName = scanFileNames(base, trimmed);
  return { files: byName.files, contents: [], truncated: byName.truncated };
}

/** rel → 绝对路径（渲染层打开文件用） */
export function joinProjectPath(cwd: string, rel: string): string {
  return `${cwd.replaceAll(sep, "/").replace(/\/+$/, "")}/${rel.replace(/^\//, "")}`;
}

/* ------------------------------ 远程项目变体 ------------------------------ */

/**
 * 远程项目搜索：git grep / 文件列举走 SSH（同 -z -n -F 协议），解析与本地一致。
 * 非法查询/远端不可达返回空结果（与本地「目录不存在返回空」同语义）；
 * 调用方（search handler）本就异步派活，这里的 async 不占 mgmt 串行队列。
 */
export async function searchProjectDirRemote(
  target: RemoteTarget,
  cwd: string,
  query: string,
): Promise<ProjectSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return EMPTY;
  const base = cwd.replaceAll(sep, "/").replace(/\/+$/, "") || "/";
  let out = "";
  try {
    // 与本地同参：-z 路径 NUL 分隔、-n 行号、-F 固定串；head -c 截断防失控
    const result = await remoteExec(
      target,
      `cd ${quotePosixShellArg(base)} && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ` +
        `git grep -z -n -F -e ${quotePosixShellArg(trimmed)} -- 2>/dev/null | head -c ${GREP_MAX_BYTES}`,
      { cwd: base, timeoutMs: 20_000, maxOutputBytes: GREP_MAX_BYTES },
    );
    out = result.stdout;
  } catch {
    out = "";
  }

  if (out) {
    // 与本地 gitGrep 同构解析（远端已按字节截断，尾部残行按 truncated 处理）
    const bytes = Buffer.from(out, "utf8");
    const hits: ProjectContentHit[] = [];
    let truncated = bytes.length >= GREP_MAX_BYTES;
    let offset = 0;
    while (offset < bytes.length && hits.length < GREP_MAX_MATCHES) {
      const pathEnd = bytes.indexOf(0, offset);
      if (pathEnd < 0) { truncated = true; break; }
      const lineEnd = bytes.indexOf(0, pathEnd + 1);
      if (lineEnd < 0) { truncated = true; break; }
      const nl = bytes.indexOf(0x0a, lineEnd + 1);
      const previewEnd = nl < 0 ? bytes.length : nl;
      const rel = bytes.subarray(offset, pathEnd).toString("utf8").replaceAll("\\", "/");
      const line = Number.parseInt(bytes.subarray(pathEnd + 1, lineEnd).toString("utf8"), 10);
      const preview = bytes.subarray(lineEnd + 1, previewEnd).toString("utf8");
      offset = nl < 0 ? bytes.length : nl + 1;
      if (!rel || !Number.isFinite(line)) continue;
      hits.push({ rel, name: rel.split("/").pop() ?? rel, line, preview: preview.trimEnd() });
      if (hits.length >= GREP_MAX_MATCHES) { truncated = true; break; }
    }
    const seen = new Set<string>();
    const files: ProjectFileHit[] = [];
    for (const hit of hits) {
      if (seen.has(hit.rel)) continue;
      seen.add(hit.rel);
      files.push({ rel: hit.rel, name: hit.name });
      if (files.length >= GREP_MAX_MATCHES) break;
    }
    // 内容命中不足时补一轮远端文件名扫描（find 列举 + 本侧子串过滤）
    if (files.length < 40) {
      try {
        const rels = await remoteListFiles(target, cwd, base);
        const needle = trimmed.toLowerCase();
        for (const rel of rels) {
          if (seen.has(rel)) continue;
          if (!rel.toLowerCase().includes(needle)) continue;
          files.push({ rel, name: rel.split("/").pop() ?? rel });
          if (files.length >= GREP_MAX_MATCHES) { truncated = true; break; }
        }
      } catch {
        // 列举失败不影响已有命中
      }
    }
    return { files, contents: hits, truncated };
  }

  // 无 git / grep 无命中：退文件名扫描（远端 find + 本侧过滤）
  try {
    const rels = await remoteListFiles(target, cwd, base);
    const needle = trimmed.toLowerCase();
    const files: ProjectFileHit[] = [];
    let truncated = false;
    for (const rel of rels) {
      if (!rel.toLowerCase().includes(needle)) continue;
      files.push({ rel, name: rel.split("/").pop() ?? rel });
      if (files.length >= GREP_MAX_MATCHES) { truncated = true; break; }
    }
    return { files, contents: [], truncated };
  } catch {
    return EMPTY;
  }
}

/* ---------------------- 非 git 目录的正文补扫（kb_search 用） ---------------------- */

/** 正文补扫认得的文本扩展名之外的文件：只进文件名命中，不读内容 */
function isContentTextFile(name: string): boolean {
  return CONTENT_TEXT_EXTS.has(extname(name).toLowerCase());
}

/**
 * 有界正文扫描（非 git 目录）：异步逐文件读前 64KB 做子串匹配。
 * 预算 400 文件 / 8MB——kb_search 的兜底路径，量级按「中型非 git 目录一次
 * 查询」设定；超限 truncated=true。跳过隐藏目录/依赖目录/软链（Dirent 语义）。
 */
export async function scanProjectContent(
  cwd: string,
  query: string,
): Promise<{ hits: ProjectContentHit[]; truncated: boolean }> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], truncated: false };
  const needle = trimmed.toLowerCase();
  const hits: ProjectContentHit[] = [];
  let truncated = false;
  let fileCount = 0;
  let bytesRead = 0;
  let visited = 0;

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (
      fileCount >= CONTENT_SCAN_MAX_FILES ||
      bytesRead >= CONTENT_SCAN_MAX_BYTES ||
      visited >= NAME_SCAN_MAX
    ) {
      truncated = true;
      return;
    }
    const abs = rel ? join(cwd, ...rel.split("/")) : cwd;
    let entries: Dirent[];
    try {
      entries = await readdirAsync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      // 目录条目也算访问量：防病态大树（几万空目录）只靠文件数上限拦不住
      visited += 1;
      if (visited > NAME_SCAN_MAX) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= 12 || NAME_SCAN_SKIP.has(entry.name)) continue;
        await walk(childRel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isContentTextFile(entry.name)) continue;
      if (fileCount >= CONTENT_SCAN_MAX_FILES || bytesRead >= CONTENT_SCAN_MAX_BYTES) {
        truncated = true;
        return;
      }
      fileCount += 1;
      const fileAbs = join(abs, entry.name);
      let text = "";
      try {
        const fd = await openFile(fileAbs, "r");
        try {
          const buf = Buffer.alloc(CONTENT_READ_BYTES);
          const read = await fd.read(buf, 0, buf.length, 0);
          text = buf.subarray(0, read.bytesRead).toString("utf8");
          bytesRead += read.bytesRead;
        } finally {
          await fd.close();
        }
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // 二进制伪装成文本扩展名
      const lower = text.toLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      const line = lower.slice(0, index).split("\n").length;
      const lineStart = lower.lastIndexOf("\n", index) + 1;
      const lineEnd = lower.indexOf("\n", index);
      const preview = text
        .slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        .trimEnd();
      hits.push({
        rel: childRel,
        name: entry.name,
        line,
        preview: preview.slice(0, 240),
      });
      if (hits.length >= GREP_MAX_MATCHES) {
        truncated = true;
        return;
      }
    }
  };
  await walk("", 0);
  return { hits, truncated };
}

/**
 * 项目检索完整版（kb_search 用）：git grep / 文件名扫描之外，若没有任何
 * 正文命中，再补一轮有界正文扫描——非 git 目录此前只有文件名命中。
 * 远程会话请用 searchProjectDirRemote（远端不做本地正文扫描）。
 */
export async function searchProjectDirFull(
  cwd: string,
  query: string,
): Promise<ProjectSearchResult> {
  const base = searchProjectDir(cwd, query);
  if (base.contents.length > 0) return base;
  const scan = await scanProjectContent(cwd, query);
  if (scan.hits.length === 0) {
    return { ...base, truncated: base.truncated || scan.truncated };
  }
  const seen = new Set(base.files.map((file) => file.rel));
  const files = [...base.files];
  for (const hit of scan.hits) {
    if (!seen.has(hit.rel)) {
      seen.add(hit.rel);
      files.push({ rel: hit.rel, name: hit.name });
    }
  }
  return {
    files,
    contents: [...base.contents, ...scan.hits],
    truncated: base.truncated || scan.truncated,
  };
}
