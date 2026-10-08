/**
 * 子代理知识源：声明式目录 + 按需检索（§4.4）。
 *
 * 知识形态很杂——本地 markdown/表格、飞书表格、Notion——但投递方式只有两种：
 * - files：工作区相对 glob，正文留在磁盘，经 kb_search 关键词检索后按需 read
 * - mcp：命名一个 MCP 服务器与工具，agent 走作用域化网关自行调用
 *
 * 两条路都不预加载正文。系统提示词只拿到每源一行的目录（见 capabilities.ts），
 * 这正是子代理省上下文的本意：知识库可能有几 MB，全量注入会直接撑爆委派。
 *
 * 检索是纯内存的逐行扫描，量级与 agent/memory.ts 的 searchMemoryText 同族
 * （markdown 记忆库通常几十 KB~几 MB）。没有 embedding 服务，也不需要——
 * 见设计文档 §2「向量 RAG 本期不做」：真需要时它是本模块的实现替换，
 * 不影响 schema 与上层调用。
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { globToRegExp } from "../tools/tools";
import type { KnowledgeSource } from "./subagent-definitions";

/** 单次检索最多读取的字节数：防止超大语料打爆子代理上下文 */
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;
/** 单次检索返回的命中条数上限 */
const MAX_HITS = 50;
/** 单条命中的行文本上限（与 grep 同款） */
const MAX_HIT_LINE = 400;
/** 单文件读取上限：超限跳过而不是截断（半个文件比没有更误导） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 遍历时跳过的目录（与 grep/glob 同款） */
const SKIP_DIRS = new Set(["node_modules", ".git", ".kova"]);

export type KnowledgeHit = {
  /** 知识源名（agent 看到的是它，便于判断这条来自哪份资料） */
  source: string;
  rel: string;
  line: number;
  text: string;
  score: number;
};

/**
 * 关键词打分：命中次数为主，标题式全词匹配加权。
 * 不做分词、不做同义——中文语料上简单的子串命中已经够用，
 * 而引入分词依赖会让一个纯内存工具背上不必要的重量。
 */
function scoreLine(line: string, terms: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx < 0) continue;
    // 多次出现加权，但封顶：同一行堆词不代表它更重要
    let hits = 0;
    let from = idx;
    while (from >= 0 && hits < 5) {
      hits += 1;
      from = lower.indexOf(term, from + term.length);
    }
    score += hits;
  }
  return score;
}

/** 查询分词：空白分隔；引号内视为一个词 */
function parseQuery(raw: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const t = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (t.length >= 1) terms.push(t);
  }
  return [...new Set(terms)].slice(0, 12);
}

/** 遍历时单次展开的文件数上限（与 tools.ts MAX_WALKED_FILES 同款） */
const MAX_WALKED_FILES = 5000;

/**
 * 展开一个 glob 为相对工作区根的文件列表。
 * 整条路径编成一个正则后逐文件比对——拆成"目录段+文件名"两段是错的：
 * 双星号斜杠会落进文件名那一段，于是永不匹配。
 * globToRegExp 已正确处理递归通配段，直接复用。
 */
function expandGlob(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/[*?]/.test(normalized)) {
    return existsSync(path.join(root, normalized)) ? [normalized] : [];
  }
  const re = globToRegExp(normalized);
  const out: string[] = [];
  let walked = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const abs = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++walked > MAX_WALKED_FILES) return out;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(path.join(abs, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, path.join(abs, entry.name)).replace(/\\/g, "/");
      if (re.test(rel)) out.push(rel);
    }
  }
  return out;
}

/**
 * 检索 files 类知识源。跨全部源的命中按分数排序，同分按源名+路径稳定排序。
 * 扫描预算耗尽即停，并在结果里显式标注截断——静默截断会让模型误以为
 * "库里只有这些内容"。
 */
export function searchKnowledge(
  cwd: string,
  sources: readonly KnowledgeSource[],
  query: string,
  limit: number,
): { hits: KnowledgeHit[]; scannedBytes: number; truncated: boolean } {
  const terms = parseQuery(query);
  if (terms.length === 0) return { hits: [], scannedBytes: 0, truncated: false };
  const fileSources = sources.filter((s) => s.path.trim());
  if (fileSources.length === 0) return { hits: [], scannedBytes: 0, truncated: false };

  const hits: KnowledgeHit[] = [];
  let scanned = 0;
  let truncated = false;

  for (const source of fileSources) {
    if (truncated) break;
    const pattern = source.path as string;
    for (const rel of expandGlob(cwd, pattern)) {
      if (truncated) break;
      const abs = path.join(cwd, rel);
      try {
        const size = statSync(abs).size;
        if (size > MAX_FILE_BYTES) continue;
        if (scanned + size > MAX_SCANNED_BYTES) {
          truncated = true;
          break;
        }
        const text = readFileSync(abs, "utf8");
        scanned += size;
        if (text.includes("\0")) continue; // 二进制
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const score = scoreLine(lines[i], terms);
          if (score === 0) continue;
          hits.push({
            source: source.name,
            rel,
            line: i + 1,
            text: lines[i].trim().slice(0, MAX_HIT_LINE),
            score,
          });
        }
      } catch {
        // 读不了的文件跳过：一份坏文件不该让整个检索失败
      }
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.source.localeCompare(b.source) ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line,
  );
  const cap = Math.max(1, Math.min(Math.trunc(limit) || 10, MAX_HITS));
  return { hits: hits.slice(0, cap), scannedBytes: scanned, truncated };
}

/**
 * kb_search 工具。仅在定义声明了 files 类知识源时挂载——
 * 没有源可搜就不该有这个工具（模型看不见它，能力即不存在）。
 */
export function buildKnowledgeTool(
  cwd: string,
  sources: readonly KnowledgeSource[],
): AgentTool {
  const names = sources.map((s) => s.name);
  return {
    name: "kb_search",
    label: "Knowledge Search",
    description: [
      "Search the knowledge sources declared for this agent (" +
        `${names.join(", ")}) and return ranked path:line hits.`,
      "Use it when the task depends on documented domain knowledge (product manuals, policies, SOPs) rather than on the code. Then read the promising files with the read tool to get the full context — a hit is one line, not the answer.",
      "The index covers text files only and is capped per call; if results look incomplete, narrow the query or search a different phrase.",
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords (quote phrases to keep them together)" }),
      limit: Type.Optional(
        Type.Number({ description: "Max hits (default 10, max 50)" }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { query?: string; limit?: number };
      const query = String(p.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: "query is required" }], details: {} };
      }
      const { hits, truncated } = searchKnowledge(cwd, sources, query, p.limit ?? 10);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches for "${query}" in: ${names.join(", ")}. Try different keywords, or report that the knowledge base does not cover this.`,
            },
          ],
          details: { count: 0 },
        };
      }
      const body = hits
        .map((h) => `[${h.source}] ${h.rel}:${h.line}: ${h.text}`)
        .join("\n");
      const suffix = truncated
        ? "\n…[knowledge scan hit its byte budget; results above are incomplete — narrow the query or search a specific file]"
        : "";
      return {
        content: [{ type: "text" as const, text: body + suffix }],
        details: { count: hits.length, truncated },
      };
    },
  };
}