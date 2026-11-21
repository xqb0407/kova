/**
 * 项目虚拟目录：一个项目由主目录 + 若干附加代码工程根组成（类虚拟工作区形态）。
 *
 * 语义（对齐 pi-add-dir，按 kova 的既有纪律收敛）：
 * - cwd 不变；附加根只按绝对路径访问，相对路径仍解析到 cwd。
 * - 每目录取一个非空指令文件注入系统提示词：`AGENTS.md` → `CLAUDE.md` →
 *   `.claude/CLAUDE.md`（与 agent/instructions.ts 同款"同层首个非空"，避免
 *   同一份规则被重复注入）。
 * - 附加根里的技能按 `.kova/skills` / `.agents/skills` / `.claude/skills`
 *   发现（见 skills/discovery.ts）。
 * - 校验是**纯函数**（除 realpath 外零 I/O 语义），便于逐条单测。
 *
 * 安全边界：附加根的 AGENTS.md/CLAUDE.md 会被当成指令执行，所以只允许
 * 用户在**项目设置**里显式添加（配置存本机 kv）；不从模型侧开放增删，
 * 也不读取仓库里的项目级配置。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExternalDir } from "pi-protocol";

/** 单个项目的附加根上限：防止提示词与搜索被失控配置拖垮 */
export const MAX_EXTERNAL_DIRS = 8;
/** 单份指令文件的注入上限（字符），与 instructions.ts 同口径 */
const MAX_INSTRUCTION_CHARS = 16_000;
/** 所有外部目录指令的合计上限（字符） */
const MAX_TOTAL_INSTRUCTION_CHARS = 32_000;
/** 搜索时跳过的目录名（隐藏目录另行跳过） */
const SKIPPED_SEARCH_DIRS = new Set([".git", "node_modules"]);
/** 单次遍历的条目安全阀：命中结果上限之外再兜一层，防超大目录失控 */
const MAX_WALKED_ENTRIES = 50_000;
/** 指令文件候选顺序（同层首个非空生效） */
const INSTRUCTION_CANDIDATES = [
  { path: "AGENTS.md", source: "AGENTS.md" as const },
  { path: "CLAUDE.md", source: "CLAUDE.md" as const },
  { path: join(".claude", "CLAUDE.md"), source: "CLAUDE.md" as const },
];

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** `~` / `~/x` 展开（只认 `~/`，`~user` 语义各家 shell 不一，当普通相对路径） */
export function expandUserPath(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(home, input.slice(2));
  }
  return input;
}

/** 解析为绝对路径；存在则解软链（同一目录不因两种名字被判成一内一外） */
export function resolveExternalPath(input: string, cwd: string): string {
  const expanded = expandUserPath(input.trim());
  const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (isMissingPathError(error)) return resolve(resolved);
    throw error;
  }
}

export function externalDirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** path.relative 口径的内外判定（`..` 与绝对路径都正确归位） */
export function isWithinDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** 两个目录是否有包含关系（任一方向） */
export function externalDirsOverlap(a: string, b: string): boolean {
  return isWithinDir(a, b) || isWithinDir(b, a);
}

export function externalDirLabel(absolutePath: string): string {
  return basename(absolutePath) || absolutePath;
}

export type ExternalDirValidation =
  | { ok: true; absolutePath: string; label: string }
  | { ok: false; message: string };

/**
 * 新目录的准入校验：非空、存在、是目录、不与 cwd/已加目录重叠、不超上限。
 * 已在列表里的同路径由调用方先行短路（重复添加不算错误，返回原清单）。
 */
export function validateExternalDir(
  input: string,
  options: {
    cwd: string;
    existing: readonly ExternalDir[];
    maxDirs?: number;
  },
): ExternalDirValidation {
  const raw = input.trim();
  if (!raw) return { ok: false, message: "Directory path must not be blank." };
  let absolutePath: string;
  try {
    absolutePath = resolveExternalPath(raw, options.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cannot access directory: ${message}` };
  }
  if (!externalDirExists(absolutePath)) {
    return { ok: false, message: `Directory does not exist: ${absolutePath}` };
  }
  if (/\p{C}/u.test(absolutePath)) {
    return { ok: false, message: "Directory path must not contain control characters." };
  }
  const workspace = resolveExternalPath(options.cwd, options.cwd);
  if (externalDirsOverlap(workspace, absolutePath)) {
    return { ok: false, message: "Directory overlaps the workspace directory." };
  }
  const overlap = options.existing.find((dir) =>
    externalDirsOverlap(resolveExternalPath(dir.path, options.cwd), absolutePath),
  );
  if (overlap) {
    return {
      ok: false,
      message: `Directory overlaps an already-added directory: ${overlap.path}`,
    };
  }
  const limit = options.maxDirs ?? MAX_EXTERNAL_DIRS;
  if (options.existing.length >= limit) {
    return {
      ok: false,
      message: `At most ${limit} additional folders can be added to one project.`,
    };
  }
  return { ok: true, absolutePath, label: externalDirLabel(absolutePath) };
}

export type ExternalDirContext = {
  /** 首个非空指令文件的正文（已截断）；null = 没有可注入的指令 */
  body: string | null;
  source: "AGENTS.md" | "CLAUDE.md" | null;
  /** 命中文件的绝对路径 */
  path: string | null;
  truncated: boolean;
};

function readInstructionFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    const body = readFileSync(filePath, "utf8").trim();
    return body || null;
  } catch {
    return null;
  }
}

/** 读一个外部目录的指令文件：同层首个非空生效，超限保头截断 */
export function scanExternalDirContext(absolutePath: string): ExternalDirContext {
  for (const candidate of INSTRUCTION_CANDIDATES) {
    const fullPath = join(absolutePath, candidate.path);
    const raw = readInstructionFile(fullPath);
    if (!raw) continue;
    const truncated = raw.length > MAX_INSTRUCTION_CHARS;
    return {
      body: truncated
        ? `${raw.slice(0, MAX_INSTRUCTION_CHARS)}\n…[truncated ${raw.length - MAX_INSTRUCTION_CHARS} chars]`
        : raw,
      source: candidate.source,
      path: fullPath,
      truncated,
    };
  }
  return { body: null, source: null, path: null, truncated: false };
}

/** 外部目录里的技能目录（按优先级；同名先见者胜在 skills/discovery.ts 统一裁决） */
export function externalSkillDirs(absolutePath: string): string[] {
  return [
    join(absolutePath, ".kova", "skills"),
    join(absolutePath, ".agents", "skills"),
    join(absolutePath, ".claude", "skills"),
  ];
}

/** 目录当前是否可用（配置保留、目录消失 = inactive） */
export function activeExternalDirs(dirs: readonly ExternalDir[]): ExternalDir[] {
  return dirs.filter((dir) => externalDirExists(dir.path));
}

/**
 * 系统提示词的外部目录段：无目录/全部缺失时返回空串（默认提示词字节级不变）。
 * 缺失目录保留占位说明，模型据此知道"别再试了"，而不是反复 read 失败。
 */
export function externalDirsPromptBlock(
  dirs: readonly ExternalDir[],
  mainFolder?: string,
): string {
  if (dirs.length === 0) return "";
  const main = mainFolder?.trim();
  const sections = [
    "## Project Folders (additional code repositories)",
    (main
      ? `The project's main folder is \`${main}\`; workspace-level AGENTS.md and .kova configuration are read from there. `
      : "") +
      `This project includes ${dirs.length} additional folder${dirs.length === 1 ? "" : "s"} besides the workspace directory. ` +
      "They are readable and writable with absolute paths; relative paths still resolve to the workspace directory.",
  ];
  let budget = MAX_TOTAL_INSTRUCTION_CHARS;
  for (const dir of dirs) {
    const header = `### ${dir.label} - \`${dir.path}\``;
    if (!externalDirExists(dir.path)) {
      sections.push(`${header}\n[unavailable: directory does not exist]`);
      continue;
    }
    const context = scanExternalDirContext(dir.path);
    if (!context.body) {
      sections.push(header);
      continue;
    }
    const body =
      context.body.length <= budget
        ? context.body
        : `${context.body.slice(0, budget)}\n…[truncated: session external instruction budget reached]`;
    budget = Math.max(0, budget - Math.min(context.body.length, budget));
    sections.push(`${header}\n#### ${context.source} (from ${dir.label})\n${body}`);
  }
  return sections.join("\n\n");
}

export type ExternalSearchDirectory = {
  path: string;
  label: string;
  files: string[];
};

export type ExternalSearchResult = {
  pattern: string;
  maxResults: number;
  /** 实际搜索过的目录数（达到上限提前停止时不含未搜目录） */
  searchedDirectories: number;
  totalFound: number;
  /** true = 上限终止了搜索，后续目录/文件可能还有匹配 */
  truncated: boolean;
  directories: ExternalSearchDirectory[];
};

function normalizePattern(pattern: string): string {
  let normalized = pattern.trim();
  if (sep === "\\") normalized = normalized.replaceAll("/", "\\");
  const prefix = `.${sep}`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

/** 与 tools.ts 的 globToRegExp 同语义（此处独立成份：避免 tools ↔ 本模块成环） */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * 在一个外部目录里按 glob 搜索文件。
 * 匹配口径：pattern 含分隔符 → 匹配相对路径；否则只匹配 basename。
 * 跳过符号链接、`.git`、`node_modules` 与所有隐藏目录（与 glob/grep 工具一致）。
 */
export async function findFilesInExternalDir(
  root: string,
  pattern: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const normalized = normalizePattern(pattern);
  if (!normalized) throw new Error("File pattern must not be blank.");
  const matchPath = normalized.includes(sep) || normalized.includes("/");
  const re = globToRegExp(normalized.replaceAll("/", sep));
  const results: string[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      signal?.throwIfAborted();
      if (!isMissingPathError(error)) throw error;
      continue;
    }
    signal?.throwIfAborted();
    for (const entry of entries) {
      if (++visited > MAX_WALKED_ENTRIES) return results;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_SEARCH_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const candidate = matchPath ? relative(root, fullPath) : entry.name;
      if (!re.test(candidate)) continue;
      results.push(fullPath);
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/**
 * 跨所有外部目录搜索：目录顺序 = 添加顺序，结果上限全局共享。
 * 达到上限即停：`truncated=true`，后续目录不再计入 searchedDirectories。
 */
export async function searchExternalDirs(
  dirs: readonly ExternalDir[],
  pattern: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<ExternalSearchResult> {
  const directories: ExternalSearchDirectory[] = [];
  let totalFound = 0;
  let searchedDirectories = 0;
  for (const dir of activeExternalDirs(dirs)) {
    signal?.throwIfAborted();
    const remaining = maxResults - totalFound;
    if (remaining <= 0) break;
    searchedDirectories++;
    const files = await findFilesInExternalDir(dir.path, pattern, remaining, signal);
    if (files.length > 0) {
      // 遍历顺序是 DFS，输出前排序：同一输入得到稳定清单，便于模型对照与人工复现
      files.sort();
      directories.push({ path: dir.path, label: dir.label, files });
      totalFound += files.length;
    }
  }
  return {
    pattern,
    maxResults,
    searchedDirectories,
    totalFound,
    truncated: totalFound >= maxResults,
    directories,
  };
}

/** 外部目录里发现的技能名（诊断用；只读目录名，不加载正文） */
export function externalSkillNames(absolutePath: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const skillsDir of externalSkillDirs(absolutePath)) {
    let entries;
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = join(skillsDir, entry.name, "SKILL.md");
      try {
        if (!statSync(skillFile).isFile() || seen.has(entry.name)) continue;
      } catch {
        continue;
      }
      seen.add(entry.name);
      names.push(entry.name);
    }
  }
  return names;
}
