/**
 * 记忆（设置 → 记忆）：全局 + 工作区双作用域的纯 markdown 记忆库。
 * - 全局目录 ~/.xulux/memory（PI_MEMORY_DIR 可覆盖，测试用），跨会话跨工作区共享
 * - 工作区目录 <cwd>/.xulux/memory（与 .xulux/subagents / plans 同族）
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
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

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

/** 全局记忆目录（应用数据目录下，与 ~/.xulux/subagents 同族） */
export function globalMemoryDir(): string {
  if (process.env.PI_MEMORY_DIR) return resolve(process.env.PI_MEMORY_DIR);
  return join(homedir(), ".xulux", "memory");
}

/** 工作区记忆目录 */
export function workspaceMemoryDir(cwd: string): string {
  return join(cwd, ".xulux", "memory");
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
 */
export async function writeMemoryFile(
  scope: MemoryScope,
  cwd: string,
  file: string,
  content: string,
  mode: "append" | "overwrite" = "append",
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
  return { rel: name, bytes: Buffer.byteLength(next), mode };
}

/* --------------------------------- 工具注册 --------------------------------- */

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

const SCOPE_DESC = "'global' = ~/.xulux/memory (all sessions), 'workspace' = <workspace>/.xulux/memory (this workspace only)";

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
      "Persist durable memory (user preferences, decisions, facts worth remembering across sessions) " +
      `as Markdown. ${SCOPE_DESC}. File defaults to MEMORY.md. Append mode adds a timestamped entry; ` +
      "overwrite replaces the whole file. Use for 'remember this' requests and important decisions.",
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
        const res = await writeMemoryFile(scope, cwd, p.file ?? "MEMORY.md", String(p.content ?? ""), mode);
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
