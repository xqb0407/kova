/**
 * 内置编码工具（bash / read / write / edit / glob / grep）与系统提示词。
 * bash/read/write/edit 的执行已下沉到 Rust 宿主（src-tauri/src/tool_exec.rs）：
 * 本文件只保留工具 schema（LLM 需要）并通过 hostdb 转发执行——bash 由 Rust
 * 杀整棵进程树，避免 Windows 上孙进程残留。
 * glob/grep 仍在本侧实现：纯只读内存计算，且 JS 正则（lookahead 等）与
 * Rust regex 语法不兼容。
 * WebFetch/WebSearch 见 http-tools.ts：schema 在彼处定义，网络执行同样下沉
 * Rust（handle_http）——sidecar 不在 Tauri 运行时内，出口统一到宿主。
 * Question 见 question-tools.ts：挂起等 UI 作答的交互工具，回路仿逐工具审批。
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostToolCall } from "../storage/hostdb";
import { buildBrowserTools } from "./browser-tools";
import { buildScreenshotTool } from "./screenshot-tool";
import { buildOpenFileTool } from "./open-file-tool";
import { buildWebTools } from "./http-tools";
import { buildQuestionTool } from "./question-tools";
import { buildTodoTool } from "../todo/todo";
import { buildMemoryTools } from "../agent/memory";
import { buildSkillUseTool } from "../skills/skill-use-tool";
import { buildMcpTool } from "../mcp/mcp-tools";
import { buildEchoImageTool } from "./echo-image-tool";

/** glob/grep 遍历与输出的上限，防止在超大目录上失控 */
const MAX_WALKED_FILES = 5000;
const MAX_MATCH_ENTRIES = 200;
const MAX_GREP_FILE_BYTES = 512 * 1024;
/** 遍历时跳过的目录名（含任意隐藏目录，. 开头） */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function resolveInWorkspace(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** glob 模式（支持 **、*、?）→ 正则；路径分隔符一律按 / 处理 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
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

/** 递归遍历目录（跳过 node_modules/.git/隐藏目录），对每个文件回调；返回 false 提前终止 */
function walkFiles(
  root: string,
  visit: (abs: string, rel: string) => boolean | void,
): void {
  let walked = 0;
  const stack: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++walked > MAX_WALKED_FILES) return;
      const abs = path.join(dir.abs, entry.name);
      const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push({ abs, rel });
      } else if (entry.isFile()) {
        if (visit(abs, rel) === false) return;
      }
    }
  }
}

/** glob 工具：按模式匹配工作区内文件路径 */
function buildGlobTool(cwd: string): AgentTool {
  return {
    name: "glob",
    label: "Glob",
    description:
      "Find files by name pattern (e.g. \"src/**/*.ts\", \"*.json\"). " +
      "Skips node_modules, .git and hidden directories. Returns up to 200 paths.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern with ** / * / ?" }),
      path: Type.Optional(
        Type.String({ description: "Sub-directory to search (default workspace root)" }),
      ),
    }),
    execute: async (_id, params) => {
      const { pattern, path: sub } = params as { pattern: string; path?: string };
      if (!pattern.trim()) throw new Error("pattern is required");
      const base = resolveInWorkspace(cwd, sub ?? "");
      if (!existsSync(base)) throw new Error(`not found: ${sub ?? "."}`);
      const re = globToRegExp(pattern.trim());
      const matches: string[] = [];
      let truncated = false;
      walkFiles(base, (_abs, rel) => {
        if (re.test(rel) || re.test(path.posix.basename(rel))) {
          if (matches.length >= MAX_MATCH_ENTRIES) {
            truncated = true;
            return false;
          }
          matches.push(rel);
        }
      });
      matches.sort();
      const body = matches.join("\n");
      const suffix = truncated ? "\n…[more files truncated]" : "";
      return textResult(body ? body + suffix : "No files matched.", {
        count: matches.length,
        truncated,
      });
    },
  };
}

/** grep 工具：在工作区文本文件里按正则逐行搜索 */
function buildGrepTool(cwd: string): AgentTool {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents with a regular expression and return path:line matches. " +
      "Skips node_modules, .git, hidden dirs and binary files. Use `include` to filter " +
      "file names (glob). Returns up to 200 matches.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression (JavaScript syntax)" }),
      path: Type.Optional(
        Type.String({ description: "File or directory to search (default workspace root)" }),
      ),
      include: Type.Optional(
        Type.String({ description: "Only search files whose name matches this glob, e.g. \"*.ts\"" }),
      ),
    }),
    execute: async (_id, params) => {
      const { pattern, path: sub, include } = params as {
        pattern: string;
        path?: string;
        include?: string;
      };
      if (!pattern.trim()) throw new Error("pattern is required");
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw new Error(`invalid regex: ${err instanceof Error ? err.message : err}`);
      }
      const includeRe = include?.trim() ? globToRegExp(include.trim()) : undefined;
      const target = resolveInWorkspace(cwd, sub ?? "");
      if (!existsSync(target)) throw new Error(`not found: ${sub ?? "."}`);
      if (statSync(target).isFile()) {
        // 单文件直接搜，不做遍历与过滤
        const text = readFileSync(target, "utf8");
        const lines = text.split("\n");
        const hits: string[] = [];
        for (let i = 0; i < lines.length && hits.length < MAX_MATCH_ENTRIES; i++) {
          if (re.test(lines[i])) hits.push(`${sub ?? path.basename(target)}:${i + 1}: ${lines[i].trim()}`);
        }
        return textResult(hits.join("\n") || "No matches.", { count: hits.length });
      }
      const matches: string[] = [];
      let truncated = false;
      walkFiles(target, (abs, rel) => {
        if (matches.length >= MAX_MATCH_ENTRIES) {
          truncated = true;
          return false;
        }
        if (includeRe && !includeRe.test(path.posix.basename(rel))) return;
        if (statSync(abs).size > MAX_GREP_FILE_BYTES) return;
        let text: string;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          return;
        }
        if (text.includes("\0")) return; // 二进制文件
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_MATCH_ENTRIES) {
            truncated = true;
            return false;
          }
          if (re.test(lines[i])) {
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 400)}`);
          }
        }
      });
      const body = matches.join("\n");
      const suffix = truncated ? "\n…[more matches truncated]" : "";
      return textResult(body ? body + suffix : "No matches.", {
        count: matches.length,
        truncated,
      });
    },
  };
}

/** bash/read/write/edit：schema 留本侧，执行转发给 Rust 宿主（tool_exec.rs） */
function hostTool(
  name: string,
  cwd: string,
  description: string,
  parameters: AgentTool["parameters"],
): AgentTool {
  return {
    name,
    label: { bash: "Bash", read: "Read", write: "Write", edit: "Edit" }[name] ?? name,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      // signal 透传给 hostToolCall：中断时向宿主发 host_cancel，bash 会被杀进程树
      const data = await hostToolCall(
        name,
        cwd,
        params as Record<string, unknown>,
        signal ?? undefined,
      );
      const details: Record<string, unknown> = {};
      if (data.truncated !== undefined) details.truncated = data.truncated;
      if (data.exitCode !== undefined) details.exitCode = data.exitCode;
      if (data.totalLines !== undefined) details.totalLines = data.totalLines;
      return textResult(data.output, Object.keys(details).length ? details : undefined);
    },
  };
}

export function buildTools(cwd: string, threadId: string): AgentTool[] {
  const tools: AgentTool[] = [
    hostTool("bash", cwd,
      "Run a shell command in the workspace and return combined stdout/stderr. " +
        "Output is capped; use narrower commands (grep/tail/head) instead of dumping large files. " +
        "Windows runs Git Bash when available (cmd.exe fallback) — do not use PowerShell-only syntax like backtick escapes.",
      Type.Object({
        command: Type.String({ description: "The shell command to run" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds (default 120000)" }),
        ),
      }),
    ),
    hostTool("read", cwd,
      "Read a text file. Returns up to 64KB with line numbers. " +
        "Use offset/limit to paginate large files.",
      Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        offset: Type.Optional(Type.Number({ description: "1-based start line" })),
        limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
      }),
    ),
    hostTool("write", cwd,
      "Write (or create) a file with the given content. Parent directories are created automatically.",
      Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        content: Type.String({ description: "Full file content" }),
      }),
    ),
    hostTool("edit", cwd,
      "Replace an exact string in a file. old_string must match exactly and appear exactly once, " +
        "unless replace_all is true.",
      Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        old_string: Type.String({ description: "Exact text to replace" }),
        new_string: Type.String({ description: "Replacement text" }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence (default false)" }),
        ),
      }),
    ),
    buildGlobTool(cwd),
    buildGrepTool(cwd),
    ...buildWebTools(cwd),
    // 浏览器驱动：执行转发 Rust 宿主（browser.rs）驱动面板子 webview，
    // threadId 用于 data-panelOpen 面板唤起（见 browser-tools.ts）
    // 【暂停暴露】只保留 browser_navigate（agent 导航打开网页 + 返回渲染快照）；
    // snapshot/click/type/scroll/back/resize 暂不下发 AI，工具代码原样留在
    // browser-tools.ts，恢复时去掉 filter 即可
    ...buildBrowserTools(threadId).filter((tool) => tool.name === "browser_navigate"),
    // 屏幕截图：执行转发 Rust 宿主（tool_exec.rs，macOS only），结果 image 块
    // 走正规投影链路上屏（image-parts.ts 闸门 + 前端 data-image 渲染）
    buildScreenshotTool(cwd),
    // 面板打开文件：只发 data-panelOpen chunk（文件标签磁盘实时模式），
    // 无 IO 无副作用（见 open-file-tool.ts）
    buildOpenFileTool(cwd, threadId),
    // Question 不触盘不触网（挂起等 UI 作答），但要 threadId 做挂起归属
    buildQuestionTool(threadId),
    // todo：不触盘不触网，只维护会话内任务清单（per-thread 槽见 todo.ts）
    buildTodoTool(threadId),
    // 记忆三件套（write/read/search）：常驻注册（工具表稳定缓存友好），开关在
    // execute 内实时门控；cwd 供工作区作用域定位（rebindRunCwd 会重建）
    ...buildMemoryTools(cwd),
    // 技能调用：按名加载生效技能正文（只读动作，不进审批；见 skill-use-tool.ts）
    buildSkillUseTool(cwd),
    // MCP 网关（search/describe/call/status）：常驻注册的代理工具，全部服务器
    // 的工具面走这一个入口；cwd 决定工作区层配置来源（rebindRunCwd 会重建）
    buildMcpTool(cwd, threadId),
    // 【临时】图片投影链路验收工具（docs/image-part-design.md §10 PR4）：
    // 验收通过后连同 echo-image-tool.ts 一并删除并摘除此注册
    buildEchoImageTool(),
  ];
  return tools;
}

/**
 * 静态核心系统提示：不含任何会话级动态信息（cwd / 时间戳），字节级稳定。
 * 它必须排在系统提示词最前——跨会话时 OpenAI 前缀增量与 Anthropic tools 块
 * 才能保持缓存命中；cwd 等动态段一律放末尾。
 */
export const SYSTEM_PROMPT_CORE = [
  "You are a capable coding agent running inside the Xulux desktop app.",
  "",
  "Code change discipline:",
  "- Read the relevant code before making changes.",
  "- Make minimal diffs; no refactoring or extra abstractions unless asked.",
  "- Follow the existing code style and framework conventions.",
  "- Touch only files related to the task at hand.",
  "",
  "Tool preference: inspect files with read/glob/grep instead of shell commands; use bash for anything dynamic (build, test, git, process control).",
  "Before a batch of tool calls, write one short sentence saying what you are about to do.",
  "",
  "Correctness: after making changes, run the relevant verification (build / test / lint). When something fails, find the root cause before fixing - never blind-patch or hide errors.",
  "",
  "Task tracking:",
  "- Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "- Mark a task in_progress (pass activeForm) BEFORE beginning work; mark it completed IMMEDIATELY when done - never batch completions. Exactly one task in_progress at a time.",
  "- Never mark a task completed while tests are failing, the work is partial, or errors are unresolved - keep it in_progress and create a new task for the blocker instead.",
  "- Task status is a 4-state machine: pending -> in_progress -> completed, plus deleted as a tombstone. To change status call update with the task id and target status.",
  "- Use blockedBy for dependencies (additive merge on update via addBlockedBy/removeBlockedBy); cycles are rejected.",
  "- Subject must be short and imperative; description is for long-form detail; activeForm is the present-continuous label shown while in_progress.",
  "",
  "Subagents:",
  "- Use `Task` to delegate separable work (parallel exploration, multi-file implementation, adversarial review, wide search) to subagents; converge with `TaskWait` / `TaskList` / `TaskStop`.",
  "- Call `subagents_list` to see the current definitions and their storage directories - never guess paths or read the YAML files yourself.",
  "- To create or update a reusable subagent use `subagents_save`; to remove one use `subagents_delete`. Never hand-edit their YAML with write/edit: those tools skip validation, cross-layer dedup and hot-reload.",
  "- scope=workspace puts a definition in this repo (.xulux/subagents/, shared with the team); scope=system makes it machine-wide.",
  "- A subagent sees neither this conversation nor the user, can only use the tools its definition declares (from bash/read/write/edit/glob/grep), and its final report is its only output - design description, tools and prompt with that in mind.",
  "",
  "Communication:",
  "- Reply in the same language the user writes in.",
  "- Make the final message self-contained: the outcome, what changed, and anything still open.",
].join("\n");

/** 动态段：工作目录行。必须放在系统提示词的最末尾（见 SYSTEM_PROMPT_CORE 说明）。 */
export const workspacePromptLine = (cwd: string) =>
  `The workspace directory is \`${cwd}\`. Relative paths resolve there.`;

/* ------------------------------ 环境事实动态段 ------------------------------ */

/** 环境事实块头（测试与结构断言的识别点）；块内各行单换行相连、无空行，
 *  工作目录行仍是整个系统提示词的最后一行（cwd 行在最尾的不变式不破） */
const ENV_BLOCK_HEADER = "Environment (host facts):";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** 宿主时区名：只依赖进程环境，模块加载期解析一次 */
const hostTimezone: string | undefined = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
})();

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 宿主本地日历日 YYYY-MM-DD（不用 toISOString：UTC 会跨日错位） */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 用户默认 shell：Windows 走 COMSPEC，类 Unix 走 $SHELL */
const hostShell = () =>
  process.platform === "win32"
    ? process.env.COMSPEC || "cmd.exe"
    : process.env.SHELL || "/bin/sh";

/**
 * 环境事实块：日期 / 模型 / 操作系统 / shell 等宿主侧动态信息，
 * 整块置于系统提示词末尾并以 workspacePromptLine 收尾。
 * 缓存影响：块内除日历日（跨天才变）外均会话内稳定，且整段本就在
 * 动态尾部，静态前缀的缓存命中不受影响。无模型时省略 Model 行。
 */
export const environmentPromptBlock = (
  cwd: string,
  model?: { provider: string; id: string; name?: string } | null,
): string => {
  const now = new Date();
  const lines = [
    ENV_BLOCK_HEADER,
    `- Today's date is ${localDateString(now)} (${WEEKDAY_NAMES[now.getDay()]}), host timezone ${hostTimezone ?? "unknown"}. Trust this over assumptions from training data.`,
  ];
  if (model) {
    const qualified = `${model.provider}/${model.id}`;
    lines.push(
      `- Model: ${model.name && model.name !== model.id ? `${model.name} (${qualified})` : qualified}.`,
    );
  }
  lines.push(
    `- Host: ${OS_LABELS[process.platform] ?? process.platform} (${process.platform} ${process.arch}); shell: ${hostShell()}.`,
  );
  lines.push(workspacePromptLine(cwd));
  return lines.join("\n");
};
