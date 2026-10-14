/**
 * 子代理记忆（§4.5）：私有命名空间 + 与主代理同构的两层消费。
 *
 * 为什么不能直接复用 agent/memory.ts：
 * - writeMemoryFile 的 scopeDir 只认 global / workspace 两个作用域，
 *   子代理需要第三个命名空间 <cwd>/.kova/agent-memory/<name>/
 * - 子代理记忆**不受主记忆总开关控制**。MemoryConfig.enabled 默认关闭，
 *   那是主代理提示词的缓存纪律；用一个默认关闭的全局开关去否决用户
 *   显式声明的 `memory: private` 是错的耦合。
 *
 * 纯函数（目录枚举、行打分、截断）复用 agent/memory.ts 的导出，
 * 只有"写"另起一套——它要落自己的目录，且不做版本史/回收站
 * （子代理记忆是 agent 自产的中间产物，不是用户资产）。
 *
 * 并发：MAX_SUBAGENT_CONCURRENCY 为 8 且 Task 是 parallel 模式，
 * 同一子代理的并发委派会竞争同一份文件。sidecar 是单进程，
 * 按 cwd+name 建 promise 队列串行 append 即可；overwrite 取最后写入
 * 胜出（与"最后写入者赢"的常规语义一致，不额外仲裁）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { listRootMemoryFiles, scoreLine, truncateMiddle } from "../agent/memory";
import { normalizeSubagentName, type SubagentMemoryMode } from "./subagent-definitions";

/** 与 agent/memory.ts 同款预算：子代理上下文比主代理更紧，不另开更大口子 */
const PER_FILE_MAX_CHARS = 4_000;
const MEMORY_BLOCK_TOTAL_CHARS = 12_000;

/** 记忆文件名约束（与 agent/memory.ts 的 FILE_NAME_RE 同款） */
const FILE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*\.md$/u;

/** 私有命名空间目录：<cwd>/.kova/agent-memory/<name>/ */
export function privateSubagentMemoryDir(cwd: string, agentName: string): string {
  return join(cwd, ".kova", "agent-memory", normalizeSubagentName(agentName));
}

/** 该子代理实际使用的记忆目录（private 走命名空间，shared 走主记忆工作区目录） */
export function subagentMemoryDir(
  mode: SubagentMemoryMode,
  cwd: string,
  agentName: string,
): string {
  return mode === "private"
    ? privateSubagentMemoryDir(cwd, agentName)
    : join(cwd, ".kova", "memory");
}

function stamp(): string {
  return new Date().toISOString();
}

/**
 * 写队列：同一 (cwd+mode+name) 的写串行化。
 * Map 而非锁——sidecar 单进程，键不会无限增长（委派结束即不再写入）。
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  // 无论成败都让队列前进：一次失败不该把后续所有写堵死
  const next = prev.then(task, task);
  writeQueues.set(
    key,
    next.catch(() => {}),
  );
  void next.finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  });
  return next;
}

/** 测试钩子：清空写队列 */
export function resetSubagentMemoryQueuesForTest(): void {
  writeQueues.clear();
}

/**
 * 写一条子代理记忆。append 盖时间戳注释，overwrite 整体覆盖。
 * 与 writeMemoryFile 同款语义，但目录由调用方给定（命名空间隔离在此保证）。
 */
export async function writeSubagentMemory(
  dir: string,
  file: string,
  content: string,
  mode: "append" | "overwrite" = "append",
): Promise<{ rel: string; bytes: number; mode: "append" | "overwrite" }> {
  const name = file.trim();
  if (!FILE_NAME_RE.test(name)) {
    throw new Error(
      `invalid memory file name: ${file}（根级 .md 文件名，仅限字母/数字/点/横线/下划线/空格）`,
    );
  }
  const body = content.trim();
  if (!body) throw new Error("content is required");
  return enqueue(dir + "::" + name, async () => {
    await mkdir(dir, { recursive: true });
    const abs = join(dir, name);
    const ts = stamp();
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
  });
}

/** 读一个记忆文件；不带 file 时返回清单 */
export function readSubagentMemory(
  dir: string,
  file?: string,
): { kind: "list"; files: string[] } | { kind: "content"; rel: string; content: string } {
  if (!file?.trim()) {
    const names = listRootMemoryFiles(dir).map((f) => f.name);
    const daily = listDailyFiles(dir);
    return { kind: "list", files: [...names, ...daily.map((n) => `daily/${n}`)] };
  }
  const rel = file.trim();
  if (!FILE_NAME_RE.test(rel) && !/^daily\/[^/]+\.md$/.test(rel)) {
    throw new Error(`invalid memory file: ${file}`);
  }
  const abs = join(dir, rel);
  if (!existsSync(abs)) throw new Error(`no memory file: ${rel}`);
  return { kind: "content", rel, content: readFileSync(abs, "utf8") };
}

function listDailyFiles(dir: string): string[] {
  const dailyDir = join(dir, "daily");
  if (!existsSync(dailyDir)) return [];
  try {
    return readdirSync(dailyDir)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

const MEMORY_GUIDELINES = [
  "These are your own durable notes, carried across the tasks you are given.",
  "- When a task teaches you something that will still be true next time — a policy detail, a recurring customer issue, a mistake you should not repeat — persist it with memory_write so the next task starts where this one ended.",
  "- Use memory_search to recall past context before asking the user to repeat themselves.",
  "- Do not edit memory files with write/edit; use memory_write.",
].join("\n");

/**
 * 子代理记忆的系统提示词段。根级 *.md 视为常驻（逐文件 4K、整段 12K 预算，
 * 超预算的整体略去并留一行说明）；daily/ 只参与检索。
 *
 * 空目录不是空串：给最小引导，让模型知道记忆能力存在——否则它永远
 * 不会去写第一条记忆（与主代理 memoryPromptBlock 同款处理）。
 */
export function subagentMemoryPromptBlock(dir: string): string {
  const sections: string[] = [];
  let used = 0;
  const omitted: string[] = [];
  for (const { name } of listRootMemoryFiles(dir)) {
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const section = `### ${name}\n${truncateMiddle(content, PER_FILE_MAX_CHARS)}`;
    if (used + section.length > MEMORY_BLOCK_TOTAL_CHARS) {
      omitted.push(name);
      continue;
    }
    sections.push(section);
    used += section.length;
  }
  const lines = ["## Your memory", MEMORY_GUIDELINES];
  if (omitted.length > 0) {
    lines.push(
      `- Notes over the injection budget (not shown): ${omitted.join(", ")} — read them with memory_read.`,
    );
  }
  if (sections.length === 0) return lines.join("\n");
  return [lines.join("\n"), ...sections].join("\n\n");
}

/** 关键词行检索：根级 *.md + daily/*.md，纯内存扫描（与 searchMemoryText 同款） */
function searchSubagentMemory(
  dir: string,
  query: string,
  limit: number,
): Array<{ rel: string; line: number; text: string }> {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
  if (terms.length === 0) return [];
  const maxHits = Math.min(Math.max(Math.trunc(limit) || 6, 1), 20);
  const files = [
    ...listRootMemoryFiles(dir).map((f) => f.name),
    ...listDailyFiles(dir).map((n) => `daily/${n}`),
  ];
  const hits: Array<{ rel: string; line: number; text: string; score: number }> = [];
  for (const rel of files) {
    let text: string;
    try {
      const st = statSync(join(dir, rel));
      if (st.size > 2 * 1024 * 1024) continue;
      text = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const score = scoreLine(lines[i].toLowerCase(), terms);
      if (score === 0) continue;
      hits.push({ rel, line: i + 1, text: lines[i].trim().slice(0, 400), score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.line - b.line);
  return hits.slice(0, maxHits).map(({ rel, line, text }) => ({ rel, line, text }));
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * 记忆三件套。仅在定义的 memory 维度非 none 时挂载。
 *
 * 关键：scope 参数**不进 schema**。工具在闭包里把目录钉死，
 * 子代理在参数里伪造 scope 字段也无处可去——隔离是结构性的，
 * 不是靠运行时校验参数值。
 */
export function buildSubagentMemoryTools(dir: string, agentName: string): AgentTool[] {
  const writeTool: AgentTool = {
    name: "memory_write",
    label: "Memory Write",
    description:
      "Persist a durable note about your own work — a policy detail, a recurring customer issue, " +
      "a mistake worth not repeating. Append mode adds a timestamped entry; overwrite replaces the file. " +
      "Notes are visible only to you, not to the user or the main agent.",
    parameters: Type.Object({
      content: Type.String({
        description: "Markdown body (one fact per line; #tags like #policy / #lesson improve searchability)",
      }),
      file: Type.Optional(
        Type.String({ description: "Target .md file name (default MEMORY.md)" }),
      ),
      mode: Type.Optional(
        Type.String({ description: "'append' (default) or 'overwrite'" }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { content?: string; file?: string; mode?: string };
      try {
        const res = await writeSubagentMemory(
          dir,
          p.file ?? "MEMORY.md",
          String(p.content ?? ""),
          p.mode === "overwrite" ? "overwrite" : "append",
        );
        return textResult(
          `Saved to ${res.rel} (${res.mode}, ${res.bytes} bytes). It will be available to your next task.`,
          res,
        );
      } catch (err) {
        return textResult(
          `memory_write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  const readTool: AgentTool = {
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read one of your memory files, or list what you have stored when called without 'file'.",
    parameters: Type.Object({
      file: Type.Optional(
        Type.String({
          description: "File to read (e.g. MEMORY.md or daily/2026-09-13.md)",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { file?: string };
      try {
        const res = readSubagentMemory(dir, p.file);
        if (res.kind === "list") {
          return textResult(
            res.files.length ? res.files.join("\n") : "You have no memory files yet.",
            { files: res.files },
          );
        }
        return textResult(`${res.rel}\n\n${res.content}`, {
          rel: res.rel,
          bytes: res.content.length,
        });
      } catch (err) {
        return textResult(
          `memory_read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  const searchTool: AgentTool = {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Keyword search across your memory files, returning path:line hits ranked by relevance. " +
      "Use it to recall earlier context instead of asking the user to repeat themselves.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords" }),
      limit: Type.Optional(Type.Number({ description: "Max hits (default 6, max 20)" })),
    }),
    execute: async (_id, params) => {
      const p = params as { query?: string; limit?: number };
      const query = String(p.query ?? "").trim();
      if (!query) return textResult("query is required");
      const hits = searchSubagentMemory(dir, query, p.limit ?? 6);
      if (hits.length === 0) return textResult(`No matches for "${query}".`);
      return textResult(
        hits.map((h) => `${h.rel}:${h.line}: ${h.text}`).join("\n"),
        { count: hits.length },
      );
    },
  };

  return [writeTool, readTool, searchTool].map((t) => ({
    ...t,
    // agentName 只用于诊断标识：让活动流里能看出是哪个 agent 在写记忆
    label: `${t.label ?? t.name} (${agentName})`,
  })) as AgentTool[];
}