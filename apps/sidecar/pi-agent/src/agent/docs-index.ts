/**
 * 知识来源提示词段：使用规则 + 项目文档地图。
 *
 * 项目资料不复制进资料库：repo 里的 docs 是团队真值，agent 只需要一张
 * 「有哪些文档」的目录。地图控制在 40 条 / 2KB 以内，正文由 kb_read 按需读；
 * 地图变化走尾部更新（见 modes.ts 的 VOLATILE_PROMPT_BLOCK_KEYS），不重写
 * 首条 system。远程会话不扫本地 cwd（路径可能是远端同名目录）。
 */
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { basename, join } from "node:path";

const MAX_DOCS = 40;
const MAX_MAP_CHARS = 2000;
const MAX_EXCERPT_CHARS = 4000;
const MAX_SUMMARY_CHARS = 100;
const SCAN_DEPTH = 2;
const CACHE_TTL_MS = 30_000;
// AGENTS.md/CLAUDE.md 已由 instructions 段整篇注入，这里不再重复列目录
const ROOT_DOCS = ["README.md", "DESIGN.md", "PLAN.md"] as const;

const RULES = [
  "## Knowledge sources",
  "- kb_search searches the user's library notes/files, this project's docs and code, and durable memory; kb_read opens a hit and returns a cite line.",
  "- If the user refers to something they saved, decided earlier, or asked you to remember, call kb_search before saying you do not know.",
  "- Library files live outside the workspace: read them with kb_read (source=library), not the read tool.",
  "- When an answer relies on a note or project doc, include the cite line returned by kb_read verbatim.",
].join("\n");

const DOCS_RULE =
  "- Before substantial design or refactor work, check the project docs index below before searching the whole repo. When a line starts with a [label] (a project folder), pass that label or its path as root to kb_read.";

type CacheEntry = { at: number; key: string; lines: string[] };
/** 按 cwd 分桶：多个会话并行跑不同项目时，单槽缓存会互相顶掉、每轮重扫 */
const CACHE_MAX = 8;
const cache = new Map<string, CacheEntry>();

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type DocEntry = { rel: string; title: string; summary: string };

/** 单个文件 → 目录条目；读不到/不是普通文件返回 null。
 *  只按需读前 4KB（不整读大文件），lstat 跳过软链——根级 README.md 指向
 *  cwd 外的软链不能把外部内容带进系统提示词。 */
function docEntry(cwd: string, rel: string): DocEntry | null {
  const abs = join(cwd, ...rel.split("/"));
  let text = "";
  try {
    if (!lstatSync(abs).isFile()) return null;
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.alloc(MAX_EXCERPT_CHARS);
      const read = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  let summary = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed);
    if (heading?.[1] && !title) {
      title = stripMarkdown(heading[1]);
      continue;
    }
    if (trimmed.startsWith("```")) continue;
    // frontmatter 分隔线与注释不是摘要
    if (trimmed === "---" || trimmed.startsWith("<!--")) continue;
    if (!summary && !heading) summary = stripMarkdown(trimmed);
    if (title && summary) break;
  }
  title = title || basename(rel, ".md");
  if (title.length > MAX_SUMMARY_CHARS) title = `${title.slice(0, MAX_SUMMARY_CHARS)}…`;
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}…`;
  }
  return { rel, title, summary };
}

/** docs/ 下深度 ≤2 的 Markdown + 根级约定文档 */
function listDocFiles(cwd: string): string[] {
  const out: string[] = [];
  for (const rel of ROOT_DOCS) {
    try {
      if (lstatSync(join(cwd, rel)).isFile()) out.push(rel);
    } catch {
      /* 缺失跳过 */
    }
  }
  const walk = (rel: string, depth: number): void => {
    if (out.length >= MAX_DOCS) return;
    let entries;
    try {
      entries = readdirSync(join(cwd, ...rel.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_DOCS) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < SCAN_DEPTH) walk(next, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.md$/iu.test(entry.name) && !out.includes(next)) {
        out.push(next);
      }
    }
  };
  // docs 本身必须是真目录：lstat 不跟随软链，避免 `docs -> /somewhere` 把
  // cwd 外的文档整棵带进系统提示词（子目录/文件的 Dirent 已按软链跳过）。
  try {
    if (!lstatSync(join(cwd, "docs")).isDirectory()) return out;
  } catch {
    return out;
  }
  walk("docs", 1);
  return out;
}

/** 单个根的目录行（最多 MAX_DOCS 条，不按字符裁；多根合并时统一预算） */
export function projectDocsLines(cwd: string, remote = false): string[] {
  if (!cwd || remote) return [];
  const files = listDocFiles(cwd);
  // 缓存键带每个文件的 mtime：新增/删除/改动都会立刻换 key，不能只靠 TTL
  //（否则删掉 AGENTS.md 后最多 30s 内提示词里还留着旧条目）。
  const signature = files
    .map((rel) => {
      try {
        return `${rel}:${lstatSync(join(cwd, ...rel.split("/"))).mtimeMs}`;
      } catch {
        return `${rel}:0`;
      }
    })
    .join("|");
  const key = `${cwd}\u0000${signature}`;
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && cached.key === key && now - cached.at < CACHE_TTL_MS) {
    return cached.lines;
  }
  const lines = files
    .map((rel) => docEntry(cwd, rel))
    .filter((entry): entry is DocEntry => entry !== null)
    .map(
      (entry) =>
        `- ${entry.rel} — ${entry.title}${entry.summary ? ` — ${entry.summary}` : ""}`,
    );
  cache.delete(cwd);
  cache.set(cwd, { at: now, key, lines });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return lines;
}

/** 项目文档地图（空串 = 没有可列文档） */
export function projectDocsMap(cwd: string, remote = false): string {
  if (!cwd || remote) return "";
  const lines: string[] = [];
  let used = 0;
  for (const line of projectDocsLines(cwd, remote)) {
    if (lines.length >= MAX_DOCS) break;
    if (used + line.length + 1 > MAX_MAP_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? ["## Project docs", ...lines].join("\n") : "";
}

export type DocsRoot = { path: string; label: string };

/** 完整知识段：静态规则 + 可选文档地图（主目录 + 项目附加根，统一预算） */
export function knowledgePromptBlock(
  cwd: string,
  remote = false,
  externalRoots: readonly DocsRoot[] = [],
): string {
  if (!cwd || remote) return RULES;
  const roots: DocsRoot[] = [
    { path: cwd, label: "main" },
    ...externalRoots
      .filter((root) => root.path && root.path !== cwd)
      .slice(0, 8),
  ];
  const multiRoot = roots.length > 1;
  // 轮转取行：主根文档再多也先给每个附加根至少一条，避免预算被 main 吃光
  const perRoot = roots.map((root) => ({
    label: root.label.replace(/[\s[\]]+/g, " ").trim() || "root",
    lines: projectDocsLines(root.path),
  }));
  const depth = Math.max(0, ...perRoot.map((root) => root.lines.length));
  const lines: string[] = [];
  let used = 0;
  outer: for (let index = 0; index < depth; index += 1) {
    for (const root of perRoot) {
      const line = root.lines[index];
      if (!line) continue;
      if (lines.length >= MAX_DOCS) break outer;
      const prefixed = multiRoot
        ? `- [${root.label}] ${line.replace(/^-\s*/, "")}`
        : line;
      if (used + prefixed.length + 1 > MAX_MAP_CHARS) break outer;
      lines.push(prefixed);
      used += prefixed.length + 1;
    }
  }
  if (lines.length === 0) return RULES;
  return `${RULES}\n${DOCS_RULE}\n\n${["## Project docs", ...lines].join("\n")}`;
}
