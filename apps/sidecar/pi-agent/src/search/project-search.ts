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
import { join, sep } from "node:path";

/** 单次 git grep 输出字节上限（monocode 同量级：4MiB） */
const GREP_MAX_BYTES = 4 * 1024 * 1024;
/** 匹配行上限 */
const GREP_MAX_MATCHES = 200;
/** 文件名扫描的条目上限 */
const NAME_SCAN_MAX = 20000;
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
    // 先确认是 git 仓库（不是则走退化路径）
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", timeout: 2000, env: process.env,
    });
    if (root.status !== 0) return null;
    const repoRoot = root.stdout.trim() || cwd;

    // -z：路径 NUL 分隔（文件名带空格/引号不破）；-n：行号；-F：固定串
    //（子串语义，与内容索引一致；regex 留给后续显式模式）
    const res = spawnSync(
      "git",
      ["grep", "-z", "-n", "-F", "-e", query, "--"],
      { cwd: repoRoot, encoding: "buffer", timeout: 10_000, env: process.env, maxBuffer: GREP_MAX_BYTES * 2 },
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
