/**
 * 知识检索/读取工具（kb_search / kb_read）。
 *
 * 三个来源，各自保持真值在原地：
 * - library：用户资料库（Markdown 笔记/文件），走现有 artifact_blocks 索引；
 * - project：当前项目 cwd 的文档/代码，走 git grep（远程会话走 SSH）；
 * - memory：模型记忆文件，复用 memory_search 的关键词行检索。
 *
 * 只读：不改文件、不建索引（library 索引由 refreshArtifactsIndex 增量补齐）。
 * kb_read 返回的 `cite:` 行是可点击的 kova:// 链接，模型原样抄进回答，
 * 前端渲染成来源芯片。资料库在 workspace 之外，必须走 kb_read，不能用 read。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExternalDir } from "pi-protocol";
import { Type } from "typebox";
import { getMemoryConfig, readMemoryFile, searchMemoryText, type MemoryScope } from "../agent/memory";
import {
  searchProjectDirFull,
  searchProjectDirRemote,
  type ProjectContentHit,
  type ProjectFileHit,
} from "../search/project-search";
import {
  ARTIFACT_OWNER_LIBRARY,
  artifactSearch,
  knowledgeRefsRecord,
  libraryRootGet,
  sessionSearch,
} from "../storage/hostdb";
import type { RemoteTarget } from "../types";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_READ_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 多根项目一次检索的总时间预算：单个 git grep 自己还有 10s 上限 */
const PROJECT_SEARCH_BUDGET_MS = 8_000;

type KnowledgeSource = "library" | "project" | "memory" | "sessions";
type ProjectRoot = { path: string; label: string };

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function clampLimit(value: unknown, fallback = DEFAULT_SEARCH_LIMIT): number {
  const n = typeof value === "number" ? Math.trunc(value) : fallback;
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, 1), MAX_SEARCH_LIMIT);
}

function oneLine(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/** 引用标签里的 `]`/换行会截断 Markdown 链接，替换而不是丢字；超长标题会
 *  把一行工具输出撑爆，按 200 字符收口。 */
function citeLabel(text: string): string {
  return text
    .replace(/[[\]]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function libraryCite(rel: string, title: string, line?: number): string {
  const suffix = line && line > 0 ? `&line=${line}` : "";
  return `[资料库：${citeLabel(title)}](kova://library?rel=${encodeURIComponent(rel)}${suffix})`;
}

export function projectCite(path: string, line?: number, cwd?: string): string {
  const lineSuffix = line && line > 0 ? `&line=${line}` : "";
  const cwdSuffix = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
  return `[项目：${citeLabel(path)}](kova://project?path=${encodeURIComponent(path)}${lineSuffix}${cwdSuffix})`;
}

/** 资料库相对路径：非绝对、无 `..`、无控制字符 */
export function isSafeRel(rel: string): boolean {
  if (!rel || rel.length > 1024 || /[\u0000-\u001f]/.test(rel)) return false;
  if (rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel)) return false;
  return rel.split(/[\\/]/).every((seg) => seg && seg !== "." && seg !== "..");
}

export function within(root: string, abs: string): boolean {
  const base = resolve(root);
  const target = resolve(abs);
  return target === base || target.startsWith(base + sep);
}

/** 解软链后再判界：库内一个指向外部的 symlink 不能把 kb_read 变成任意读 */
function realWithin(root: string, abs: string): boolean {
  try {
    return within(realpathSync(root), realpathSync(abs));
  } catch {
    return false;
  }
}

/** 两个根是否指同一目录（优先 canonical，目录不存在时退回 lexical） */
function sameRoot(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** 生效的项目根：cwd 在前，附加根按配置顺序去重；远程会话只用 cwd */
function projectRoots(
  cwd: string,
  externalDirs: readonly ExternalDir[],
  remote: RemoteTarget | null,
): ProjectRoot[] {
  const roots: ProjectRoot[] = cwd ? [{ path: cwd, label: "main" }] : [];
  if (remote) return roots;
  for (const dir of externalDirs) {
    if (!dir.path || roots.some((root) => sameRoot(root.path, dir.path))) {
      continue;
    }
    roots.push({
      path: dir.path,
      label: dir.label?.trim() || basename(dir.path) || "root",
    });
  }
  return roots;
}

/** 剥掉 YAML frontmatter（笔记正文给模型看时不带元数据块） */
export function splitFrontmatter(body: string): { front: string; text: string } {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) {
    return { front: "", text: body };
  }
  const match = /\r?\n---\r?\n/.exec(body.slice(3));
  if (!match) return { front: "", text: body };
  const end = 3 + match.index + match[0].length;
  return { front: body.slice(3, 3 + match.index), text: body.slice(end) };
}

export function frontmatterValue(front: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(front);
  if (!match?.[1]) return "";
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return String(JSON.parse(raw));
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (!startLine || startLine < 1) return text;
  const lines = text.split("\n");
  const start = Math.max(0, Math.trunc(startLine) - 1);
  const end = Math.min(
    lines.length,
    endLine && endLine >= startLine ? Math.trunc(endLine) : Math.trunc(startLine),
  );
  return lines.slice(start, end).join("\n");
}

/** 输出上限：先按行号切片再截断。若先截断全文，64KB 之后的行号永远读不到
 *  （长笔记/大文件里 kb_search 命中后面的行，kb_read 却返回空）。 */
function clipRead(text: string): string {
  return text.length > MAX_READ_BYTES
    ? `${text.slice(0, MAX_READ_BYTES)}\n…[truncated]`
    : text;
}

function notLibrary(): string {
  return "资料库位置不可用（可能在设置 → 通用 → 资料库中未配置或目录被移除）。";
}

async function librarySearch(query: string, limit: number) {
  let root = "";
  try {
    root = (await libraryRootGet()).root ?? "";
  } catch {
    /* host query 不可用：按不可用处理 */
  }
  let ready = false;
  try {
    ready = Boolean(root) && statSync(root).isDirectory();
  } catch {
    ready = false;
  }
  if (!ready) {
    return { ok: false as const, text: notLibrary(), hits: [] as string[] };
  }
  try {
    // 动态加载：search-index → sessions/resolve → tools/tools → knowledge-tools
    // 是一条环；工具模块顶层静态引它会形成新的循环依赖（虽然能加载，但顺序脆弱）。
    const { refreshArtifactsIndex } = await import("../search/search-index");
    await refreshArtifactsIndex();
    const result = await artifactSearch(
      ARTIFACT_OWNER_LIBRARY,
      query.toLowerCase(),
      limit,
    );
    const lines = result.hits.map(
      (hit) => `- path=${hit.rel} name=${hit.name}\n  ${oneLine(hit.preview)}`,
    );
    return {
      ok: true as const,
      text: lines.join("\n"),
      hits: result.hits.map((hit) => hit.rel),
      truncated: result.truncated,
      root,
    };
  } catch (err) {
    return {
      ok: false as const,
      text: `资料库检索失败：${err instanceof Error ? err.message : String(err)}`,
      hits: [] as string[],
    };
  }
}

async function projectSearch(
  roots: readonly ProjectRoot[],
  query: string,
  remote: RemoteTarget | null,
  limit: number,
) {
  if (roots.length === 0) {
    return {
      ok: false as const,
      text: "当前会话没有工作目录，无法检索项目文档。",
      hits: [] as string[],
    };
  }
  const perRoot: {
    root: ProjectRoot;
    files: ProjectFileHit[];
    contents: ProjectContentHit[];
    truncated: boolean;
  }[] = [];
  let truncated = false;
  const startedAt = Date.now();
  for (const root of roots) {
    if (Date.now() - startedAt > PROJECT_SEARCH_BUDGET_MS) {
      truncated = true;
      break;
    }
    try {
      const result = remote
        ? await searchProjectDirRemote(remote, root.path, query)
        : await searchProjectDirFull(root.path, query);
      perRoot.push({ root, ...result });
      truncated ||= result.truncated;
    } catch (err) {
      // 单个根不可读不拖垮其余根；错误在结果里点名
      perRoot.push({
        root,
        files: [],
        contents: [],
        truncated: false,
      });
      truncated = true;
      void err;
    }
  }
  // 轮转合并：主根命中再多也不能把附加根的结果整段挤掉
  const files: { root: ProjectRoot; hit: ProjectFileHit }[] = [];
  const contents: { root: ProjectRoot; hit: ProjectContentHit }[] = [];
  const depth = Math.max(
    0,
    ...perRoot.map((entry) =>
      Math.max(entry.files.length, entry.contents.length),
    ),
  );
  outer: for (let index = 0; index < depth; index += 1) {
    for (const entry of perRoot) {
      const file = entry.files[index];
      if (file && files.length < limit) files.push({ root: entry.root, hit: file });
      const content = entry.contents[index];
      if (content && contents.length < limit) {
        contents.push({ root: entry.root, hit: content });
      }
      if (files.length >= limit && contents.length >= limit) break outer;
    }
  }
  const lines = [
    ...files.map(
      (row) => `- root=${row.root.path} path=${row.hit.rel}`,
    ),
    ...contents.map(
      (row) =>
        `- root=${row.root.path} path=${row.hit.rel}:${row.hit.line}\n  ${oneLine(row.hit.preview)}`,
    ),
  ];
  return {
    ok: true as const,
    text: lines.length > 0 ? lines.join("\n") : "No matches.",
    hits: files.map((row) => `${row.root.path}\0${row.hit.rel}`),
    truncated,
  };
}

function memorySearch(cwd: string, query: string, limit: number) {
  let cfg: ReturnType<typeof getMemoryConfig>;
  try {
    cfg = getMemoryConfig();
  } catch (err) {
    return {
      ok: false as const,
      text: `记忆不可用：${err instanceof Error ? err.message : String(err)}`,
      hits: [] as string[],
    };
  }
  if (!cfg.enabled) {
    return {
      ok: false as const,
      text: "记忆已关闭（设置 → 记忆）。",
      hits: [] as string[],
    };
  }
  if (!cfg.fileSearch) {
    return {
      ok: false as const,
      text: "记忆检索已关闭（设置 → 记忆）。可用 kb_read source=memory 直接读已知文件。",
      hits: [] as string[],
    };
  }
  const hits = searchMemoryText(cwd, query, limit);
  const lines = hits.map(
    (hit) => `- path=${hit.scope}/${hit.rel}:${hit.line}\n  ${oneLine(hit.text)}`,
  );
  return {
    ok: true as const,
    text: lines.length > 0 ? lines.join("\n") : "No matches.",
    hits: hits.map((hit) => `${hit.scope}/${hit.rel}`),
  };
}

async function sessionsSearch(query: string, limit: number) {
  let result: Awaited<ReturnType<typeof sessionSearch>>;
  try {
    result = await sessionSearch(query.toLowerCase(), limit);
  } catch (err) {
    return {
      ok: false as const,
      text: `会话检索失败：${err instanceof Error ? err.message : String(err)}`,
      hits: [] as string[],
    };
  }
  const lines = [
    ...result.sessions.slice(0, 10).map(
      (hit) =>
        `- session=${hit.sessionId} title=${oneLine(hit.title, 80)}\n  ${oneLine(hit.firstMessage)}`,
    ),
    ...result.messages.slice(0, 10).map(
      (hit) =>
        `- session=${hit.sessionId} seq=${hit.seq} role=${hit.role}\n  ${oneLine(hit.preview)}`,
    ),
  ];
  return {
    ok: true as const,
    text: lines.length > 0 ? lines.join("\n") : "No matches.",
    hits: result.messages.slice(0, 10).map((hit) => `${hit.sessionId}:${hit.seq}`),
    truncated: result.truncated,
  };
}

export type KnowledgeToolDeps = {
  cwd: string;
  getRemoteTarget?: () => RemoteTarget | null;
  /** 项目附加根（多仓项目）：kb_search/kb_read 的 project scope 会覆盖 */
  getExternalDirs?: () => readonly ExternalDir[];
  /** 会话 id：kb_read 成功读到内容后记 knowledge_refs */
  getSessionId?: () => string | undefined;
};

export function buildKnowledgeTools(deps: KnowledgeToolDeps): AgentTool[] {
  const { cwd, getExternalDirs, getRemoteTarget, getSessionId } = deps;

  /** 使用记录：失败只吞掉，不能因为统计写失败而让 kb_read 报错 */
  const recordUse = async (
    source: "library" | "project" | "memory",
    scopeId: string,
    path: string,
  ): Promise<void> => {
    const sessionId = getSessionId?.();
    if (!sessionId) return;
    try {
      await knowledgeRefsRecord({ sessionId, source, scopeId, path });
    } catch {
      /* 统计失败不冒泡 */
    }
  };

  const searchTool: AgentTool = {
    name: "kb_search",
    label: "Knowledge Search",
    description:
      "Search the user's durable knowledge: their library notes and files (scope=library), " +
      "the current project's docs/code including folders attached to this project (scope=project), " +
      "durable memory (scope=memory), and optionally past sessions (scope=sessions). Use scope=all " +
      "(default) for notes + project docs + memory. Project hits include a root path; pass that " +
      "root and path to kb_read. Prefer this over guessing when the user refers to something they " +
      "saved earlier or to project design docs.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to search for" }),
      scope: Type.Optional(
        Type.String({
          description: "'all' (default), 'library', 'project', 'memory' or 'sessions'",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Max hits per source (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT})` }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { query?: string; scope?: string; limit?: number };
      const query = String(p.query ?? "").trim().slice(0, 200);
      if (!query) return textResult("query is required");
      const limit = clampLimit(p.limit);
      const scope: KnowledgeSource | "all" = (() => {
        const raw = String(p.scope ?? "").toLowerCase();
        return raw === "library" ||
          raw === "project" ||
          raw === "memory" ||
          raw === "sessions"
          ? raw
          : "all";
      })();
      const remote = getRemoteTarget?.() ?? null;
      const roots = projectRoots(cwd, getExternalDirs?.() ?? [], remote);
      // 三个来源并行：资料库索引刷新最慢，串行会把项目/记忆的命中一起拖后
      const jobs: Promise<{ heading: string; text: string }>[] = [];
      if (scope === "library" || scope === "all") {
        jobs.push(
          librarySearch(query, limit).then((r) => ({
            heading: "library",
            text: r.text,
          })),
        );
      }
      if (scope === "project" || scope === "all") {
        jobs.push(
          projectSearch(roots, query, remote, limit).then((r) => ({
            heading: "project",
            text: r.text,
          })),
        );
      }
      if (scope === "memory" || scope === "all") {
        jobs.push(
          Promise.resolve(memorySearch(cwd, query, limit)).then((r) => ({
            heading: "memory",
            text: r.text,
          })),
        );
      }
      if (scope === "sessions") {
        jobs.push(
          sessionsSearch(query, limit).then((r) => ({
            heading: "sessions",
            text: r.text,
          })),
        );
      }
      const results = await Promise.all(jobs);
      const sections = results.map((r) => `## ${r.heading}\n${r.text}`);

      return textResult(
        `${sections.join("\n\n")}\n\nOpen a hit with kb_read (same source + path; for project hits pass its root).`,
        { query, scope },
      );
    },
  };

  const readTool: AgentTool = {
    name: "kb_read",
    label: "Knowledge Read",
    description:
      "Read a kb_search hit (or a known note/project doc) and get a citation link to include " +
      "in your answer. source=library reads a library file (relative to the library root, " +
      "outside the workspace — do not use the read tool for it); source=project reads a file " +
      "relative to a project root (pass the root from kb_search; defaults to the workspace); " +
      "source=memory reads a memory file as 'scope/file'. Always include the returned cite " +
      "line when your answer relies on the content.",
    parameters: Type.Object({
      source: Type.String({ description: "'library', 'project' or 'memory'" }),
      path: Type.String({ description: "Library rel, project path, or memory 'scope/file'" }),
      root: Type.Optional(
        Type.String({
          description:
            "Project root from kb_search (absolute path), or the [label] shown in the project docs index; defaults to the workspace",
        }),
      ),
      startLine: Type.Optional(Type.Number({ description: "1-based first line" })),
      endLine: Type.Optional(Type.Number({ description: "1-based last line" })),
    }),
    execute: async (_id, params) => {
      const p = params as {
        source?: string;
        path?: string;
        root?: string;
        startLine?: number;
        endLine?: number;
      };
      const source = String(p.source ?? "").toLowerCase();
      const path = String(p.path ?? "").trim();
      if (!path) return textResult("path is required");

      if (source === "library") {
        if (!isSafeRel(path)) return textResult("path must be a relative path inside the library");
        let root = "";
        try {
          root = (await libraryRootGet()).root ?? "";
        } catch {
          /* 按不可用处理 */
        }
        let rootReady = false;
        try {
          rootReady = Boolean(root) && statSync(root).isDirectory();
        } catch {
          rootReady = false;
        }
        if (!rootReady) return textResult(notLibrary());
        const abs = resolve(root, path);
        if (!existsSync(abs)) {
          return textResult(`No such library file: ${path}`);
        }
        if (!within(root, abs) || !realWithin(root, abs)) {
          return textResult("path escapes the library root");
        }
        let body: string;
        try {
          const st = statSync(abs);
          if (!st.isFile()) return textResult("not a file");
          if (st.size > MAX_FILE_BYTES) return textResult("file is too large to read inline");
          body = readFileSync(abs, "utf8");
        } catch {
          return textResult(`No such library file: ${path}`);
        }
        if (body.includes("\u0000")) return textResult("not a text file");
        const { front, text } = splitFrontmatter(body);
        const title = (
          frontmatterValue(front, "title") ||
          path.split("/").pop() ||
          path
        ).slice(0, 200);
        const tags = frontmatterValue(front, "tags").slice(0, 500);
        const slice = clipRead(sliceLines(text, p.startLine, p.endLine));
        const header = [
          `source: library`,
          `path: ${path}`,
          `title: ${title}`,
          ...(tags ? [`tags: ${tags}`] : []),
          `cite: ${libraryCite(path, title, p.startLine)}`,
        ].join("\n");
        // 统计写入不阻塞工具返回：host 查询异常/慢不应拖慢 kb_read
        void recordUse("library", root, path);
        return textResult(`${header}\n\n${slice.trim()}`, { source, path, title });
      }

      if (source === "project") {
        if (!isSafeRel(path)) return textResult("path must be a relative path inside the workspace");
        const remote = getRemoteTarget?.() ?? null;
        const roots = projectRoots(cwd, getExternalDirs?.() ?? [], remote);
        const requestedRoot = String(p.root ?? "").trim();
        const target = requestedRoot
          ? roots.find(
              (root) =>
                sameRoot(root.path, requestedRoot) ||
                root.label === requestedRoot,
            )
          : roots[0];
        if (!target) {
          return textResult(
            requestedRoot
              ? `root is not part of this project: ${requestedRoot}`
              : "当前会话没有工作目录。",
          );
        }
        const rootPath = target.path;
        // 远程会话没有本地文件面板：不给 kova:// 链接（点了会拿远端路径到本地
        // 工作区找文件），退回纯文本来源行。
        const cite = remote
          ? `${path}${p.startLine ? `:${p.startLine}` : ""} (remote project)`
          : projectCite(path, p.startLine, rootPath);
        if (remote) {
          return textResult(
            `source: project\nroot: ${rootPath}\npath: ${path}\ncite: ${cite}\n\n` +
              "Remote session: read the file with the read tool, then cite the path above.",
            { source, path, root: rootPath, remote: true },
          );
        }
        const abs = resolve(rootPath, path);
        if (!existsSync(abs)) return textResult(`No such project file: ${path}`);
        if (!within(rootPath, abs) || !realWithin(rootPath, abs)) {
          return textResult("path escapes the project root");
        }
        let body: string;
        try {
          const st = statSync(abs);
          if (!st.isFile()) return textResult("not a file");
          if (st.size > MAX_FILE_BYTES) return textResult("file is too large to read inline");
          body = readFileSync(abs, "utf8");
        } catch {
          return textResult(`No such project file: ${path}`);
        }
        if (body.includes("\u0000")) return textResult("not a text file");
        const slice = clipRead(sliceLines(body, p.startLine, p.endLine));
        void recordUse("project", rootPath, path);
        return textResult(
          `source: project\nroot: ${rootPath}\npath: ${path}\ncite: ${cite}\n\n${slice.trim()}`,
          { source, path, root: rootPath },
        );
      }

      if (source === "memory") {
        let cfg: ReturnType<typeof getMemoryConfig>;
        try {
          cfg = getMemoryConfig();
        } catch (err) {
          return textResult(`记忆不可用：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!cfg.enabled) return textResult("记忆已关闭（设置 → 记忆）。");
        const slash = path.indexOf("/");
        const scope: MemoryScope = slash > 0 && path.slice(0, slash) === "global" ? "global" : "workspace";
        const rel = slash > 0 ? path.slice(slash + 1) : path;
        const res = await readMemoryFile(cfg, scope, cwd, rel);
        if (res.kind === "missing") return textResult(`No such memory file: ${scope}/${rel}`);
        if (res.kind === "list") return textResult("Pass a memory file name, e.g. workspace/MEMORY.md");
        const slice = clipRead(sliceLines(res.content, p.startLine, p.endLine));
        // workspace 记忆按 cwd 区分：不同项目的 MEMORY.md 不合并统计
        const memoryScopeId =
          scope === "workspace" ? `workspace:${cwd}` : scope;
        void recordUse("memory", memoryScopeId, res.rel);
        return textResult(
          `source: memory\npath: ${scope}/${res.rel}\ncite: memory ${scope}/${res.rel}\n\n${slice.trim()}`,
          { source, path: `${scope}/${res.rel}` },
        );
      }

      return textResult("source must be 'library', 'project' or 'memory'");
    },
  };

  return [searchTool, readTool];
}
