/**
 * 记忆（设置 → 记忆）：全局 + 工作区双作用域的纯 markdown 记忆库。
 * - 全局目录 ~/.kova/memory（PI_MEMORY_DIR 可覆盖，测试用），跨会话跨工作区共享
 * - 工作区目录 <cwd>/.kova/memory（与 .kova/subagents / plans 同族）
 * - 目录下根级 *.md 视为「常驻记忆」，按文件粒度开关（enabledFiles 白名单，
 *   null = 全部启用）；daily/*.md 只参与检索
 * - 两层消费（对齐设计讨论）：精选层 = memoryPromptBlock 注入系统提示词
 *   （modes.ts composeModeSystemPrompt 调用，个性化段之后、环境段之前）；
 *   检索层 = memory_search 工具对全库做关键词行检索（纯内存扫描，量级小无需 FTS）
 * - 配置整包存 SQLite kv（key = KV_KEY），前端经协议 get/set_memory 访问，set 时
 *   protocol.ts 热替换活动会话系统提示词（与 personalization 同款机制）。
 *   总开关默认关闭——默认提示词字节级不变（缓存纪律同 SYSTEM_PROMPT_CORE）。
 * - 工具在 tools.ts buildTools 常驻注册（工具表变更会破坏 Anthropic tools 块缓存，
 *   故不按开关增删），execute 时实时读配置门控。
 * - 删除走回收站（.trash/）、每次改动留一版版本史（.history/<文件名>/）：两者都是
 *   记忆目录下的隐藏子目录，只扫根级 *.md 的清单/注入/检索天然看不见它们；工作区
 *   作用域会落进用户仓库，所以子目录里自带 .gitignore（内容 *）自忽略，git 无噪音。
 *   也不进 SQLite —— hostdb 有 Rust 双实现，动表要两边改，文件系统这条路零跨语言成本。
 */
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export const MEMORY_KV_KEY = "pi.memory";

export type MemoryScope = "global" | "workspace";

/** 记忆设置整包（kv 与协议共用同一形状）；enabledFiles[scope] = null 表示该作用域全部文件启用 */
export type MemoryConfig = {
  /** 总开关：关闭时不注入、工具一律婉拒 */
  enabled: boolean;
  /** 全局记忆叠加开关 */
  global: boolean;
  /** 工作区记忆叠加开关 */
  workspace: boolean;
  /** 文件检索（memory_search 工具）开关 */
  fileSearch: boolean;
  /** 指定记忆开启：每作用域的文件白名单（null = 全部启用，自动跟随新建文件） */
  enabledFiles: { global: string[] | null; workspace: string[] | null };
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  global: true,
  workspace: true,
  fileSearch: true,
  enabledFiles: { global: null, workspace: null },
};

/* --------------------------------- 目录解析 --------------------------------- */

/** 全局记忆目录（应用数据目录下，与 ~/.kova/subagents 同族） */
export function globalMemoryDir(): string {
  if (process.env.PI_MEMORY_DIR) return resolve(process.env.PI_MEMORY_DIR);
  return join(homedir(), ".kova", "memory");
}

/** 工作区记忆目录 */
export function workspaceMemoryDir(cwd: string): string {
  return join(cwd, ".kova", "memory");
}

const scopeDir = (scope: MemoryScope, cwd: string): string =>
  scope === "global" ? globalMemoryDir() : workspaceMemoryDir(cwd);

/* --------------------------------- 配置存取 --------------------------------- */

const FILE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*\.md$/u;

/** 任意来源（kv JSON / 协议消息）的宽松规整：布尔取真值，白名单去重去非法名 */
export function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const list = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const names = v
      .filter((n): n is string => typeof n === "string")
      .filter((n) => FILE_NAME_RE.test(n))
      .slice(0, 200);
    return [...new Set(names)];
  };
  const ef = (r.enabledFiles ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(r.enabled, false),
    global: bool(r.global, true),
    workspace: bool(r.workspace, true),
    fileSearch: bool(r.fileSearch, true),
    enabledFiles: { global: list(ef.global), workspace: list(ef.workspace) },
  };
}

let current: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };

export function getMemoryConfig(): MemoryConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initMemory(): Promise<void> {
  try {
    const row = await kvGet(MEMORY_KV_KEY);
    if (row?.value) current = normalizeMemoryConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("memory: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv */
export function resetMemoryConfigForTest(): void {
  current = { ...DEFAULT_MEMORY_CONFIG };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyMemoryConfig(raw: unknown): Promise<MemoryConfig> {
  const next = normalizeMemoryConfig(raw);
  current = next;
  try {
    await kvSet(MEMORY_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("memory: persist failed:", err);
  }
  return next;
}

/* ------------------------------ 作用域与文件清单 ------------------------------ */

/** 作用域是否处于可注入/可写入状态：总开关 + 作用域开关 */
export function scopeActive(cfg: MemoryConfig, scope: MemoryScope, cwd: string): boolean {
  if (!cfg.enabled) return false;
  if (scope === "global") return cfg.global;
  return cfg.workspace && Boolean(cwd);
}

/** 指定记忆开启：白名单为 null = 全部启用；数组 = 仅列出的文件 */
export function isFileOn(cfg: MemoryConfig, scope: MemoryScope, name: string): boolean {
  const allow = cfg.enabledFiles[scope];
  if (allow === null) return true;
  return allow.includes(name);
}

export type MemoryFileEntry = { name: string; bytes: number; mtime: number };

/** 根级 *.md 清单（MEMORY.md 恒排最前，其余按名称），不存在/空目录返回 [] */
export function listRootMemoryFiles(dir: string): MemoryFileEntry[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => {
        try {
          const st = statSync(join(dir, e.name));
          return { name: e.name, bytes: st.size, mtime: Math.round(st.mtimeMs) };
        } catch {
          return { name: e.name, bytes: 0, mtime: 0 };
        }
      })
      .sort((a, b) =>
        a.name === "MEMORY.md" ? -1 : b.name === "MEMORY.md" ? 1 : a.name.localeCompare(b.name),
      );
  } catch {
    return [];
  }
}

/** daily/*.md 清单（只参与检索，不注入），按日期倒序 */
function listDailyFiles(dir: string): string[] {
  const daily = join(dir, "daily");
  if (!existsSync(daily)) return [];
  try {
    return readdirSync(daily)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 设置页文件清单载荷：每作用域的目录 + 文件（根级 + daily 合并展示） */
export function memoryScopesPayload(cwd?: string): {
  global: { dir: string; files: MemoryFileEntry[] };
  workspace: { dir: string; files: MemoryFileEntry[] } | null;
} {
  const globalFiles = listRootMemoryFiles(globalMemoryDir());
  const dailyCount = listDailyFiles(globalMemoryDir()).length;
  if (dailyCount > 0) {
    globalFiles.push({ name: `daily/（${dailyCount} 个日志文件）`, bytes: 0, mtime: 0 });
  }
  const workspaceFiles: MemoryFileEntry[] = [];
  if (cwd) {
    const wFiles = listRootMemoryFiles(workspaceMemoryDir(cwd));
    const wDaily = listDailyFiles(workspaceMemoryDir(cwd)).length;
    workspaceFiles.push(...wFiles);
    if (wDaily > 0) {
      workspaceFiles.push({ name: `daily/（${wDaily} 个日志文件）`, bytes: 0, mtime: 0 });
    }
  }
  return {
    global: { dir: globalMemoryDir(), files: globalFiles },
    workspace: cwd ? { dir: workspaceMemoryDir(cwd), files: workspaceFiles } : null,
  };
}

/* ------------------------------- 提示词注入块 ------------------------------- */

const PER_FILE_MAX_CHARS = 4_000;
const MEMORY_BLOCK_TOTAL_CHARS = 12_000;

/** 中间截断：保头尾，超长时中间省略（长记忆的结尾往往与开头同等重要） */
function truncateMiddle(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const marker = "\n…[truncated]…\n";
  const keep = maxChars - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return trimmed.slice(0, head) + marker + (tail > 0 ? trimmed.slice(-tail) : "");
}

const MEMORY_GUIDELINES = [
  "Durable memory files are loaded below; treat them as standing context that always applies.",
  "- Persist important user preferences, decisions and durable facts with memory_write so they survive new sessions.",
  "- Lessons: when a task reveals a durable lesson — you made a mistake and were corrected, the user rejected an approach, or you found a non-obvious root cause — summarize it in one concise line (what happened → root cause → what to do differently next time) and persist it with memory_write, one entry per lesson, tagged #lesson, to workspace/lessons.md. Lessons are workspace-scoped by design: never write them to global memory; if workspace memory is off, skip persisting.",
  "- Use memory_search to recall past context across all memory files (keyword search).",
  "- Do not edit memory files with write/edit; use memory_write so stamps and validation stay intact.",
].join("\n");

/**
 * 系统提示词的记忆段：工作区优先（更具体），全局随后；逐文件 4K、整段 12K 预算，
 * 超预算的文件整体略去并留一行说明。关闭/无内容/无开启作用域时为空串
 * （composeModeSystemPrompt 过滤空段，默认提示词字节级不变）。
 */
export function memoryPromptBlock(cwd: string): string {
  const cfg = getMemoryConfig();
  if (!cfg.enabled) return "";

  const sections: string[] = [];
  let used = 0;
  const omitted: string[] = [];
  for (const scope of ["workspace", "global"] as const) {
    if (!scopeActive(cfg, scope, cwd)) continue;
    const dir = scopeDir(scope, cwd);
    for (const { name } of listRootMemoryFiles(dir)) {
      if (!isFileOn(cfg, scope, name)) continue;
      let content: string;
      try {
        content = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const body = truncateMiddle(content, PER_FILE_MAX_CHARS);
      const section = `### ${scope}/${name}\n${body}`;
      if (used + section.length > MEMORY_BLOCK_TOTAL_CHARS) {
        omitted.push(`${scope}/${name}`);
        continue;
      }
      sections.push(section);
      used += section.length;
    }
  }

  const lines = ["## Memory", MEMORY_GUIDELINES];
  if (omitted.length > 0) {
    lines.push(`- Memory files over the injection budget (not shown): ${omitted.join(", ")} — use memory_read to access them.`);
  }
  if (sections.length === 0) {
    // 总开关开着但还没有任何内容：给最小引导，让模型知道记忆能力存在
    const anyActive =
      scopeActive(cfg, "workspace", cwd) || scopeActive(cfg, "global", cwd);
    return anyActive ? lines.join("\n") : "";
  }
  return [lines.join("\n"), ...sections].join("\n\n");
}

/* --------------------------------- 关键词检索 --------------------------------- */

export type MemorySearchHit = {
  scope: MemoryScope;
  rel: string;
  line: number;
  text: string;
  score: number;
};

/** 行打分：各查询词的命中次数 × 词长权重（substring 匹配，中英文皆可） */
export function scoreLine(lowerLine: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    let idx = 0;
    let count = 0;
    while (count < 10 && (idx = lowerLine.indexOf(term, idx)) !== -1) {
      count++;
      idx += term.length;
    }
    if (count > 0) score += count * Math.min(term.length, 8);
  }
  return score;
}

/**
 * 关键词行检索：扫描开启作用域的根级 *.md + daily/*.md，返回按分数排序的命中行。
 * 纯内存扫描（记忆库量级小，毫秒级），不依赖 SQLite FTS 或外部索引。
 */
export function searchMemoryText(
  cwd: string,
  query: string,
  limit = 6,
): MemorySearchHit[] {
  const cfg = getMemoryConfig();
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
  if (terms.length === 0) return [];
  const maxHits = Math.min(Math.max(Math.trunc(limit) || 6, 1), 20);
  const hits: MemorySearchHit[] = [];

  for (const scope of ["workspace", "global"] as const) {
    if (!scopeActive(cfg, scope, cwd)) continue;
    const dir = scopeDir(scope, cwd);
    const relFiles: string[] = [];
    for (const { name } of listRootMemoryFiles(dir)) {
      if (isFileOn(cfg, scope, name)) relFiles.push(name);
    }
    for (const name of listDailyFiles(dir)) relFiles.push(`daily/${name}`);

    for (const rel of relFiles) {
      let text: string;
      try {
        text = readFileSync(join(dir, rel), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const score = scoreLine(lines[i].toLowerCase(), terms);
        if (score > 0) {
          hits.push({ scope, rel, line: i + 1, text: lines[i].trim().slice(0, 240), score });
        }
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.scope.localeCompare(b.scope) || a.rel.localeCompare(b.rel) || a.line - b.line);
  return hits.slice(0, maxHits);
}

/* -------------------------- 版本史（.history）与回收站（.trash） -------------------------- */

const HISTORY_DIR = ".history";
const TRASH_DIR = ".trash";
/** 每文件保留的版本数（超出按时间从旧到新裁掉） */
export const MAX_VERSIONS_PER_FILE = 50;

/** 版本来源：设置页保存 / AI 工具写入 / 外部编辑器改动补录 / 从历史恢复 / 删除前留档 */
export type MemoryVersionSource = "page" | "agent" | "external" | "restore" | "delete";

const VERSION_SOURCES: readonly MemoryVersionSource[] = [
  "page",
  "agent",
  "external",
  "restore",
  "delete",
];

export type MemoryVersionEntry = {
  /** 版本 id（= 版本文件名），读取/恢复/删除都按它定位 */
  id: string;
  /** 该版记录时间（取文件 mtime，毫秒） */
  ts: number;
  source: MemoryVersionSource;
  bytes: number;
};

export type MemoryTrashEntry = {
  id: string;
  /** 原文件名（回收站里的名字是 <时间戳>--<原名>） */
  name: string;
  /** 移入回收站的时间（毫秒） */
  ts: number;
  bytes: number;
};

/** 文件名安全的时间戳：ISO 里的 : 与 . 在 Windows 非法，一律换成 -（保持字典序=时间序） */
const versionStamp = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");

/** 单调递增的版本时间戳：同一毫秒内连记多版时 +1，保证字典序恒等于记录顺序
 *  （否则同毫秒的两版会退化成按来源字母序排，"删除前那一版"就可能排到 page 后面） */
let lastVersionMs = 0;
function monotonicStamp(): string {
  const now = Date.now();
  lastVersionMs = now > lastVersionMs ? now : lastVersionMs + 1;
  return versionStamp(new Date(lastVersionMs));
}

/**
 * 隐藏子目录（版本史/回收站）：惰性创建 + 放一个 `.gitignore`（内容 `*`）自忽略。
 * 工作区作用域的记忆目录在用户仓库里，不加这行 `git status` 会冒出一堆版本文件。
 */
async function ensureSideDir(dir: string, name: string): Promise<string> {
  const abs = join(dir, name);
  await mkdir(abs, { recursive: true });
  const ignore = join(abs, ".gitignore");
  if (!existsSync(ignore)) {
    await writeFile(ignore, "*\n", "utf8").catch(() => {});
  }
  return abs;
}

/** 版本文件名：<时间戳>--<来源>.md（字典序即时间序）；重名（重启后时钟回拨等）靠 -N 后缀避让 */
async function uniqueVersionPath(vdir: string, source: MemoryVersionSource): Promise<string> {
  const base = monotonicStamp();
  for (let n = 0; n < 100; n += 1) {
    const id = n === 0 ? `${base}--${source}.md` : `${base}-${n}--${source}.md`;
    if (!existsSync(join(vdir, id))) return join(vdir, id);
  }
  // 极端情况（同毫秒百次写入）：退化成带随机段的名字，宁可排序略乱也不丢版本
  return join(vdir, `${base}-${Math.random().toString(36).slice(2, 8)}--${source}.md`);
}

function parseVersionFile(id: string): { source: MemoryVersionSource } | null {
  const m = /^[0-9TZ-]+--([a-z]+)\.md$/.exec(id);
  if (!m) return null;
  const source = m[1] as MemoryVersionSource;
  return VERSION_SOURCES.includes(source) ? { source } : null;
}

/** 版本目录（每个记忆文件一个） */
const versionDirFor = (dir: string, name: string): string => join(dir, HISTORY_DIR, name);

/** 版本清单：按文件名倒序（最新在前）；坏名字跳过 */
function listVersionIds(vdir: string): string[] {
  if (!existsSync(vdir)) return [];
  try {
    return readdirSync(vdir)
      .filter((n) => parseVersionFile(n) !== null)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 裁剪：只留最新 MAX_VERSIONS_PER_FILE 版 */
async function pruneVersions(vdir: string): Promise<void> {
  const ids = listVersionIds(vdir);
  for (const id of ids.slice(MAX_VERSIONS_PER_FILE)) {
    await unlink(join(vdir, id)).catch(() => {});
  }
}

/**
 * 把文件当前内容记成一版（内容与最新一版相同则跳过 —— 反复保存同一内容不刷屏）。
 * 版本史语义是"该文件出现过的每个状态"，因此最新一版恒等于当前内容；
 * 恢复旧版 = 用旧内容再写一次（来源 restore），历史只增不改，任何一步都能回退。
 * force = 内容相同也记（删除事件必留痕：删除前那一版要让"删除于何时"看得见）。
 */
export async function snapshotMemoryVersion(
  scope: MemoryScope,
  cwd: string,
  file: string,
  source: MemoryVersionSource,
  force = false,
): Promise<void> {
  const name = file.trim();
  if (!FILE_NAME_RE.test(name)) return; // 名非法/目录不存在：静默跳过，不阻断写路径
  const dir = scopeDir(scope, cwd);
  const abs = join(dir, name);
  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    return; // 文件还不存在（首次写入之前没有可记的状态）
  }
  const vdir = versionDirFor(dir, name);
  const newest = listVersionIds(vdir)[0];
  if (newest && !force) {
    try {
      if ((await readFile(join(vdir, newest), "utf8")) === content) return;
    } catch {
      /* 读不到就当需要新记一版 */
    }
  }
  await ensureSideDir(dir, HISTORY_DIR);
  await mkdir(vdir, { recursive: true });
  await writeFile(await uniqueVersionPath(vdir, source), content, "utf8");
  await pruneVersions(vdir);
}

/** 版本清单（最新在前） */
export function listMemoryVersions(
  scope: MemoryScope,
  cwd: string,
  file: string,
): MemoryVersionEntry[] {
  const name = file.trim();
  if (!FILE_NAME_RE.test(name)) return [];
  const vdir = versionDirFor(scopeDir(scope, cwd), name);
  const out: MemoryVersionEntry[] = [];
  for (const id of listVersionIds(vdir)) {
    const parsed = parseVersionFile(id)!;
    try {
      const st = statSync(join(vdir, id));
      out.push({ id, ts: Math.round(st.mtimeMs), source: parsed.source, bytes: st.size });
    } catch {
      /* 读不到的版本直接不展示 */
    }
  }
  return out;
}

/** 读某一版内容；不存在抛错（调用方提示"版本已不存在"） */
export async function readMemoryVersion(
  scope: MemoryScope,
  cwd: string,
  file: string,
  versionId: string,
): Promise<string> {
  const name = file.trim();
  const id = versionId.trim();
  if (!FILE_NAME_RE.test(name) || parseVersionFile(id) === null) {
    throw new Error(`invalid memory version: ${file} / ${versionId}`);
  }
  const abs = join(versionDirFor(scopeDir(scope, cwd), name), id);
  try {
    return await readFile(abs, "utf8");
  } catch {
    throw new Error(`memory version not found: ${versionId}`);
  }
}

/** 删单条版本（历史瘦身；当前内容不受影响） */
export async function deleteMemoryVersion(
  scope: MemoryScope,
  cwd: string,
  file: string,
  versionId: string,
): Promise<void> {
  const name = file.trim();
  const id = versionId.trim();
  if (!FILE_NAME_RE.test(name) || parseVersionFile(id) === null) {
    throw new Error(`invalid memory version: ${file} / ${versionId}`);
  }
  await unlink(join(versionDirFor(scopeDir(scope, cwd), name), id));
}

/** 把某一版写回文件（来源 restore：这次写回本身也会进历史） */
export async function restoreMemoryVersion(
  scope: MemoryScope,
  cwd: string,
  file: string,
  versionId: string,
): Promise<MemoryWriteResult> {
  const content = await readMemoryVersion(scope, cwd, file, versionId);
  // 版本内容自带 last updated 头，按 overwrite 写回会重新盖时间戳：预览与恢复后不再逐字相等
  const body = content.replace(/^<!--\s*last updated:[^>]*-->\s*/i, "");
  return writeMemoryFile(scope, cwd, file, body, "overwrite", "restore");
}

/* --------------------------------- 回收站 --------------------------------- */

/** 移入回收站（可恢复）；先留一版历史，"彻底删除"前内容都还找得回来 */
export async function trashMemoryFile(
  scope: MemoryScope,
  cwd: string,
  file: string,
): Promise<{ name: string; id: string }> {
  const name = file.trim();
  if (!FILE_NAME_RE.test(name)) {
    throw new Error(`invalid memory file name: ${file}（根级 .md 文件名，仅限字母/数字/点/横线/下划线/空格）`);
  }
  const dir = scopeDir(scope, cwd);
  const abs = safeResolve(dir, name);
  if (!abs || !existsSync(abs)) throw new Error(`memory file not found: ${name}`);
  // 删除是一个事件：内容没变也留一版（历史里看得见"是什么时候删的、删的是什么"）
  await snapshotMemoryVersion(scope, cwd, name, "delete", true);
  const tdir = await ensureSideDir(dir, TRASH_DIR);
  const id = `${versionStamp(new Date())}--${name}`;
  await rename(abs, join(tdir, id));
  return { name, id };
}

/** 回收站清单（最新在前）；只认 <时间戳>--<原名>.md 形状，其它文件忽略 */
export function listMemoryTrash(scope: MemoryScope, cwd: string): MemoryTrashEntry[] {
  const dir = join(scopeDir(scope, cwd), TRASH_DIR);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryTrashEntry[] = [];
  for (const id of names.sort().reverse()) {
    const m = /^([0-9TZ-]+)--(.+\.md)$/.exec(id);
    if (!m || !FILE_NAME_RE.test(m[2])) continue;
    try {
      const st = statSync(join(dir, id));
      out.push({ id, name: m[2], ts: Math.round(st.mtimeMs), bytes: st.size });
    } catch {
      /* 读不到的条目跳过 */
    }
  }
  return out;
}

/** 从回收站恢复；同名文件已存在时拒绝（不覆盖当前内容） */
export async function restoreMemoryTrash(
  scope: MemoryScope,
  cwd: string,
  id: string,
): Promise<{ name: string }> {
  const dir = scopeDir(scope, cwd);
  const entry = listMemoryTrash(scope, cwd).find((e) => e.id === id);
  if (!entry) throw new Error(`trash entry not found: ${id}`);
  const target = join(dir, entry.name);
  if (existsSync(target)) {
    throw new Error(`同名记忆文件已存在：${entry.name}（请先改名或删除当前文件）`);
  }
  await rename(join(dir, TRASH_DIR, id), target);
  return { name: entry.name };
}

/** 彻底删除回收站里的一条：连同它的版本史一起清掉（"彻底"就是彻底） */
export async function deleteMemoryTrash(scope: MemoryScope, cwd: string, id: string): Promise<void> {
  const dir = scopeDir(scope, cwd);
  const entry = listMemoryTrash(scope, cwd).find((e) => e.id === id);
  if (!entry) throw new Error(`trash entry not found: ${id}`);
  await rm(join(dir, TRASH_DIR, id), { force: true });
  await rm(versionDirFor(dir, entry.name), { recursive: true, force: true });
}

/** 清空回收站：条目 + 各自的版本史一起删；活着的记忆文件的版本史不动 */
export async function emptyMemoryTrash(scope: MemoryScope, cwd: string): Promise<number> {
  const dir = scopeDir(scope, cwd);
  const entries = listMemoryTrash(scope, cwd);
  for (const entry of entries) {
    await rm(join(dir, TRASH_DIR, entry.id), { force: true });
    await rm(versionDirFor(dir, entry.name), { recursive: true, force: true });
  }
  return entries.length;
}

/* --------------------------------- 读与写 --------------------------------- */

/** 目录内相对路径安全解析：越界（.. / 绝对路径）返回 null */
function safeResolve(dir: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const abs = resolve(dir, rel);
  const root = resolve(dir) + sep;
  return abs.startsWith(root) ? abs : null;
}

export type MemoryReadResult =
  | { kind: "list"; files: MemoryFileEntry[]; daily: string[] }
  | { kind: "text"; rel: string; content: string }
  | { kind: "missing"; rel: string };

/** 读记忆：file 缺省 = 列出根级与 daily 清单；file 允许 daily/YYYY-MM-DD.md */
export async function readMemoryFile(
  cfg: MemoryConfig,
  scope: MemoryScope,
  cwd: string,
  file?: string,
): Promise<MemoryReadResult> {
  const dir = scopeDir(scope, cwd);
  if (!file || !file.trim()) {
    return { kind: "list", files: listRootMemoryFiles(dir), daily: listDailyFiles(dir) };
  }
  const rel = file.trim().replace(/^\.\//, "");
  const abs = safeResolve(dir, rel);
  if (!abs) return { kind: "missing", rel };
  try {
    return { kind: "text", rel, content: await readFile(abs, "utf8") };
  } catch {
    return { kind: "missing", rel };
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

export type MemoryWriteResult = { rel: string; bytes: number; mode: "append" | "overwrite" };

/**
 * 写记忆（根级 *.md；daily 日志不开放直写）：append 追加并盖时间戳注释，
 * overwrite 整体覆盖并盖 last updated 注释。调用方需先做 scopeActive 门控。
 * source 只影响版本史里这一版的来源标签（设置页 page / AI agent / 恢复 restore）。
 */
export async function writeMemoryFile(
  scope: MemoryScope,
  cwd: string,
  file: string,
  content: string,
  mode: "append" | "overwrite" = "append",
  source: MemoryVersionSource = "page",
): Promise<MemoryWriteResult> {
  const name = file.trim();
  if (!FILE_NAME_RE.test(name)) {
    throw new Error(`invalid memory file name: ${file}（根级 .md 文件名，仅限字母/数字/点/横线/下划线/空格）`);
  }
  const dir = scopeDir(scope, cwd);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, name);
  const ts = stamp(new Date());
  const body = content.trim();
  if (!body) throw new Error("content is required");
  let next: string;
  if (mode === "overwrite") {
    next = `<!-- last updated: ${ts} -->\n${body}\n`;
  } else {
    let existing = "";
    try {
      existing = await readFile(abs, "utf8");
    } catch {
      /* 新文件 */
    }
    const separator = existing.trim() ? "\n\n" : "";
    next = `${existing}${separator}<!-- ${ts} -->\n${body}\n`;
  }
  await writeFile(abs, next, "utf8");
  // 版本史：写成功后把新状态记一版（与上一版相同会自动跳过）
  await snapshotMemoryVersion(scope, cwd, name, source).catch((err) =>
    logErr("memory: snapshot failed:", err),
  );
  return { rel: name, bytes: Buffer.byteLength(next), mode };
}

/* --------------------------------- 工具注册 --------------------------------- */

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

const SCOPE_DESC = "'global' = ~/.kova/memory (all sessions), 'workspace' = <workspace>/.kova/memory (this workspace only)";

/** 记忆三件套（write/read/search）：常驻注册，execute 时实时读配置门控 */
export function buildMemoryTools(cwd: string): AgentTool[] {
  const gate = (scope: MemoryScope): string | null => {
    const cfg = getMemoryConfig();
    if (!cfg.enabled) return "Memory is disabled in Settings → Memory. Tell the user they can enable it there.";
    if (!scopeActive(cfg, scope, cwd)) {
      return scope === "workspace"
        ? "Workspace memory is switched off in Settings → Memory. Only global memory is active."
        : "Global memory is switched off in Settings → Memory. Only workspace memory is active.";
    }
    return null;
  };

  const writeTool: AgentTool = {
    name: "memory_write",
    label: "Memory Write",
    description:
      "Persist durable memory (user preferences, decisions, lessons learned, facts worth " +
      `remembering across sessions) as Markdown. ${SCOPE_DESC}. File defaults to MEMORY.md. ` +
      "Append mode adds a timestamped entry; overwrite replaces the whole file. Use for " +
      "'remember this' requests, important decisions, and summarizing lessons after a task " +
      "(what happened → root cause → what to do differently).",
    parameters: Type.Object({
      scope: Type.String({ description: SCOPE_DESC }),
      content: Type.String({ description: "Memory content in Markdown (one fact per line; prefix #tags like #decision / #preference to improve searchability)" }),
      file: Type.Optional(Type.String({ description: "Target .md file name in the memory directory (default MEMORY.md)" })),
      mode: Type.Optional(
        Type.String({ description: "'append' (default) or 'overwrite'" }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { scope?: string; content?: string; file?: string; mode?: string };
      const scope: MemoryScope = p.scope === "workspace" ? "workspace" : "global";
      const blocked = gate(scope);
      if (blocked) return textResult(blocked);
      const mode = p.mode === "overwrite" ? "overwrite" : "append";
      try {
        const res = await writeMemoryFile(scope, cwd, p.file ?? "MEMORY.md", String(p.content ?? ""), mode, "agent");
        return textResult(
          `Saved to ${scope}/${res.rel} (${res.mode}, ${res.bytes} bytes). It will be injected into future sessions.`,
          res,
        );
      } catch (err) {
        return textResult(`memory_write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  const readTool: AgentTool = {
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read a memory file or list what is stored. " +
      `${SCOPE_DESC}. Without 'file' it lists the available memory files per scope.`,
    parameters: Type.Object({
      scope: Type.String({ description: SCOPE_DESC }),
      file: Type.Optional(Type.String({ description: "File to read, relative to the memory directory (e.g. MEMORY.md or daily/2026-09-13.md)" })),
    }),
    execute: async (_id, params) => {
      const p = params as { scope?: string; file?: string };
      const scope: MemoryScope = p.scope === "workspace" ? "workspace" : "global";
      const blocked = gate(scope);
      if (blocked) return textResult(blocked);
      const res = await readMemoryFile(getMemoryConfig(), scope, cwd, p.file);
      if (res.kind === "list") {
        const names = [...res.files.map((f) => f.name), ...res.daily.map((n) => `daily/${n}`)];
        return textResult(names.length ? names.join("\n") : "No memory files yet.", { files: names });
      }
      if (res.kind === "missing") return textResult(`No memory file: ${scope}/${res.rel}`);
      return textResult(`${scope}/${res.rel}\n\n${res.content}`, { rel: res.rel, bytes: res.content.length });
    },
  };

  const searchTool: AgentTool = {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Keyword search across all active memory files (both scopes, root files and daily logs). " +
      "Returns path:line hits ranked by relevance. Use to recall past context that is not in the injected memory block.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords" }),
      limit: Type.Optional(Type.Number({ description: "Max hits (default 6, max 20)" })),
    }),
    execute: async (_id, params) => {
      const p = params as { query?: string; limit?: number };
      const cfg = getMemoryConfig();
      if (!cfg.enabled) {
        return textResult("Memory is disabled in Settings → Memory. Tell the user they can enable it there.");
      }
      if (!cfg.fileSearch) {
        return textResult("Memory file search is switched off in Settings → Memory. Use memory_read to inspect files instead.");
      }
      if (!cfg.global && !cfg.workspace) {
        return textResult("Both memory scopes are switched off in Settings → Memory.");
      }
      const query = String(p.query ?? "").trim();
      if (!query) return textResult("query is required");
      const hits = searchMemoryText(cwd, query, p.limit);
      if (hits.length === 0) return textResult(`No matches for "${query}".`);
      return textResult(
        hits.map((h) => `${h.scope}/${h.rel}:${h.line}: ${h.text}`).join("\n"),
        { count: hits.length },
      );
    },
  };

  return [writeTool, readTool, searchTool];
}
