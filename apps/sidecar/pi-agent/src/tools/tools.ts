/**
 * 内置编码工具（bash / read / write / edit / glob / grep）与系统提示词。
 * bash/read/write/edit 的执行已下沉到 Rust 宿主（原 Rust 宿主/src/tool_exec.rs）：
 * 本文件只保留工具 schema（LLM 需要）并通过 hostdb 转发执行——bash 由 Rust
 * 杀整棵进程树，避免 Windows 上孙进程残留。
 * glob/grep 仍在本侧实现：纯只读内存计算，且 JS 正则（lookahead 等）与
 * Rust regex 语法不兼容。
 * WebFetch/WebSearch 见 http-tools.ts：schema 在彼处定义，网络执行同样下沉
 * Rust（handle_http）——sidecar 不在 旧桌面壳 运行时内，出口统一到宿主。
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
import {
  planAllowsWrite,
  resolveToolPath,
  writeDeniedMessage,
  type SandboxPlan,
} from "pi-sandbox";
import { hostToolCall } from "../storage/hostdb";
// 直取 registry（叶子）：sessions.ts 门面会牵进 resolve.ts→tools.ts，绕开循环
import { currentTurnOf } from "../sessions/registry";
import { checkpointCapture, checkpointPrepare } from "../checkpoint/store";
import { buildBrowserTools } from "./browser-tools";
import { buildScreenshotTool } from "./screenshot-tool";
import { buildImageGenTool } from "./imagegen-tool";
import { buildOpenFileTool } from "./open-file-tool";
import { buildOpenPanelTool, maybeAutoOpenPanel } from "./open-panel-tool";
import { buildWebTools } from "./http-tools";
import { activeGitAccelEnv } from "./mirror-config";
import { buildQuestionTool } from "./question-tools";
import { buildTodoTool } from "../todo/todo";
import { buildMemoryTools, getMemoryConfig } from "../agent/memory";
import { buildSkillUseTool } from "../skills/skill-use-tool";
import { buildUseDesignThemeTool } from "../design-md/use-design-theme-tool";
import type { ThemeRef } from "../design-md/store";
import type { ApprovalLevel, SessionMode } from "../types";
import type { ReviewSessionFacts } from "../permissions/auto-review";
import { buildMcpTool } from "../mcp/mcp-tools";
import { buildEchoImageTool } from "./echo-image-tool";
import { buildSearchExternalFilesTool } from "./external-dir-tools";
import type { ExternalDir } from "pi-protocol";
import { resolveSecretEnv } from "../secrets/secrets";

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

/** 模型参数 → 宿主信封。**保留字段在这里被摘掉**：`secretEnv` 只能由本侧的
 *  augment 决定；模型若在自己的参数里伪造同名键（工具 schema 里没有，但不妨碍
 * 它多吐一个字段），放行就等于绕过用户的密钥授权策略去注入任意密钥。
 *  `accelEnv` 同理：放行等于让模型把流量导去任意主机。
 *  纯函数，便于单测这条边界。 */
export function buildHostToolPayload(
  params: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...params };
  delete base.secretEnv;
  delete base.secretEnvResolved;
  delete base.accelEnv;
  // 沙箱计划只能由本侧闭包生成；模型伪造同名键不得影响宿主的裁决。
  delete base.sandbox;
  return extra && Object.keys(extra).length ? { ...base, ...extra } : base;
}

/** bash/read/write/edit：schema 留本侧，执行转发给 Rust 宿主（tool_exec.rs）；
 *  threadId 供 write/edit 落盘成功后的"面板认领文件自动开板"回路（open-panel-tool）；
 *  augment 在 execute 内追加宿主信封字段（bash 用它挂密钥注入名单与访问加速环境——
 *  **不进工具 schema**，模型无从要求密钥，也无从指定加速前缀）。 */
function hostTool(
  name: string,
  cwd: string,
  threadId: string,
  description: string,
  parameters: AgentTool["parameters"],
  augment?: (params: Record<string, unknown>) => Record<string, unknown>,
  /** 项目虚拟目录：write/edit 检查点把附加根也视为合法落点 */
  getExtraRoots?: () => readonly string[],
  /** 沙箱计划：执行前由宿主按同一份根/网络策略裁决。 */
  getSandbox?: () => Promise<SandboxPlan | null> | SandboxPlan | null,
): AgentTool {
  return {
    name,
    label:
      {
        bash: "Bash",
        read: "Read",
        write: "Write",
        edit: "Edit",
        task_output: "Task Output",
        task_stop: "Task Stop",
      }[name] ?? name,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      // 宿主信封 = 模型给的参数（剔除保留字段）+ 本侧追加字段
      // （augment 只给名字，值在 Rust 侧查出，见 docs/secrets-env-design.md）
      const payload = buildHostToolPayload(
        params as Record<string, unknown>,
        augment?.(params as Record<string, unknown>),
      );
      const sandbox = await getSandbox?.();
      // 写类工具先在 sidecar 判一次：越界写入不必等宿主拒绝，也就不会先落
      // 一个没有对应 capture 的检查点基线。宿主侧仍会再判一次（纵深防御）。
      if (sandbox && (name === "write" || name === "edit")) {
        const filePath = (params as { file_path?: unknown }).file_path;
        if (typeof filePath === "string" && filePath.trim()) {
          const target = resolveToolPath(cwd, filePath);
          if (!planAllowsWrite(sandbox, target)) {
            throw new Error(writeDeniedMessage(sandbox, target));
          }
        }
      }
      // 编辑检查点（条目所有权层，checkpoint/store.ts）：结构化编辑成功前后各记
      // 一道边界。轮归属取自 activeTurns（工具必然跑在活跃轮内；取不到就整体降级
      // 为不记）。门面函数吃掉一切异常——检查点坏了绝不挡工具执行。
      const cpPaths =
        name === "write" || name === "edit"
          ? [String((params as { file_path?: unknown }).file_path ?? "").trim()].filter(
              Boolean,
            )
          : [];
      const cpTurn = cpPaths.length ? currentTurnOf(threadId) : {};
      const cpRoots = cpPaths.length ? getExtraRoots?.() ?? [] : [];
      if (cpPaths.length && cpTurn.sessionId && cpTurn.requestId) {
        await checkpointPrepare(
          cpTurn.sessionId,
          cwd,
          cpTurn.requestId,
          cpPaths,
          cpRoots,
        );
      }
      // signal 透传给 hostToolCall：中断时向宿主发 host_cancel，bash 会被杀进程树。
      // owner 带线程 id：后台任务（runInBackground）跨回合存活于宿主全局表，
      // 归属校验靠它，task_output/task_stop 才不会跨线程串味
      const data = await hostToolCall(
        name,
        cwd,
        payload,
        signal ?? undefined,
        threadId,
        sandbox ?? undefined,
      );
      // 失败在 hostToolCall 抛出、走不到这里——成功态才刷 after
      if (cpPaths.length && cpTurn.sessionId && cpTurn.requestId) {
        await checkpointCapture(
          cpTurn.sessionId,
          cwd,
          cpTurn.requestId,
          cpPaths,
          cpRoots,
        );
      }
      // 宿主信封承诺 output:string，但个别 Rust handler 的失败分支可能返回其他
      // 形状（如 {error}）——undefined 塞进 text 块会落成畸形转录，压缩统计等
      // 遍历点（block.text.length）直接崩掉 agent 回合。这里统一兜底为可读文本。
      const output =
        typeof data.output === "string"
          ? data.output
          : data.output == null
            ? `host tool "${name}" returned no output (raw: ${JSON.stringify(data).slice(0, 400)})`
            : String(data.output);
      // read 命中图片（Rust 侧按扩展名返回 base64，≤2MiB）：转成 text + image
      // 内容块，模型直接"看见"图片；UI 投影（image-parts.ts 闸门）自动上屏
      if (data.base64 && data.mimeType) {
        return {
          content: [
            { type: "text" as const, text: output },
            { type: "image" as const, data: data.base64, mimeType: data.mimeType },
          ],
          details: { bytes: data.bytes },
        };
      }
      // 落盘成功（失败已在 hostToolCall 抛出，走不到这里）：若文件被某 UI 面板
      // 的 opens 声明认领，自动发 data-pluginOpen——AI 写画布文档时用户端必上屏，
      // 不再依赖模型记得显式开板。异常绝不允许影响工具结果。
      if (name === "write" || name === "edit") {
        try {
          const filePath = (params as { file_path?: unknown }).file_path;
          if (typeof filePath === "string" && filePath.trim()) {
            maybeAutoOpenPanel(cwd, threadId, filePath.trim());
          }
        } catch {
          /* 自动开板是尽力而为的旁路 */
        }
      }
      const details: Record<string, unknown> = {};
      if (data.sandbox) details.sandbox = data.sandbox;
      if (data.truncated !== undefined) details.truncated = data.truncated;
      if (data.exitCode !== undefined) details.exitCode = data.exitCode;
      if (data.totalLines !== undefined) details.totalLines = data.totalLines;
      return textResult(output, Object.keys(details).length ? details : undefined);
    },
  };
}

/** bash 的职责边界：命令归 bash，文件内容/修改归 read/write/edit。
 *  写明 cat/sed 读与改都不更新宿主 read-state 的后果——模型用 cat/sed -n 读、
 *  再 edit 会被「read it first」挡住，于是退回 sed -i；把这条因果放在调用点
 *  最省提示词。formatter/codegen 明确留在 bash 侧：它们本来就是“命令改文件”。 */
export const BASH_TOOL_DESCRIPTION = [
  "Run a shell command in the workspace and return combined stdout/stderr.",
  "Use bash for commands (builds, tests, git, formatters, codegen, process control). For project files use read/glob/grep, not cat/head/tail/sed/awk; sed/awk are only for processing command output in a pipeline. Hand-editing project files with sed -i, redirection, heredoc or tee is blocked — use edit/write; redirect logs to a temp dir (e.g. /tmp), never into the workspace. File contents and hand edits belong to read/write/edit; cat and sed bypass the read state the host checks before write/edit.",
  "Output is capped — run a narrower command instead of dumping large files.",
  "Default timeout 120s — pass a larger timeout (up to 600000ms) for slow commands, or prefer runInBackground:true for long-running processes (dev servers, builds, watchers): it returns immediately with a taskId and the process keeps running across turns (not killed when a turn is cancelled); read output later with task_output, kill with task_stop.",
  "Never discard output with >/dev/null — invisible progress looks like a hang.",
  "Windows runs Git Bash when available (cmd.exe fallback) — do not use PowerShell-only syntax like backtick escapes.",
].join(" ");

/** read 的描述：offset/limit 就是 sed -n 的替代；读文件必须走 read 才能记录
 *  宿主 write/edit 需要的 read-state，shell 文本工具不会更新它。 */
export const READ_TOOL_DESCRIPTION = [
  "Read a text file. Returns up to 64KB with line numbers.",
  "Use read instead of cat/head/tail/sed -n to inspect project files; offset/limit replaces line-range printing, and reading records the read state write/edit require.",
  "Use offset/limit to paginate large files.",
  "Image files (png/jpg/jpeg/gif/webp, up to 2MiB) are returned as an image you can see directly; larger images fail — downscale first (e.g. sips -Z 1600).",
].join(" ");

/** write 的描述以宿主真实行为为准：tool-exec 的 handleWrite 一次 writeFileSync 写整份
 *  内容，宿主没有输入大小上限（16KB 只是 bash 的输出上限，read 是 64KB）；但工具参数
 *  要由模型生成，输出预算（自定义端点默认 8192 tokens）才是必须分段的原因。
 *  旧描述把分段归因于“host 超时”是错的，但整段删掉会让大文件写入撞输出截断。 */
export const WRITE_TOOL_DESCRIPTION = [
  "Write (or create) a file with the given content; parent directories are created automatically.",
  "Use it to create a new file or replace a file completely — for targeted changes use edit.",
  "An existing file needs a current read state: read it first, or it is already current because you wrote or edited it in this session.",
  "If the content is larger than roughly 300 lines / 16KB, write it in parts — mode \"overwrite\" first, then \"append\". The limit here is the model's response budget, not the host's ability to write the file.",
  "For .json files every write must leave the file valid JSON: write a valid skeleton first, then extend it with edit — append only works for plain text.",
].join(" ");

export function buildTools(
  cwd: string,
  threadId: string,
  getDesignTheme?: () => ThemeRef | null,
  getThemeLoads?: () => Map<string, string> | undefined,
  /** 工作目录真正落盘点：bash 是唯一硬依赖 cwd 已存在的工具（宿主用
   *  current_dir(cwd) spawn，目录没了直接失败）。无目录会话的任务子目录
   *  推迟到这里、agent 真跑命令时才建；write 等其余路径写时自带 mkdir。 */
  ensureCwd?: () => void,
  /** 当前会话的审批档位（闭包，运行期才解引用 run）：MCP 网关按它决定是否逐次审批。
   *  缺省 `ask`——与内置工具同一保守缺省，宁可多问一次。 */
  getApprovalLevel?: () => ApprovalLevel,
  /** AI 审查档（review）所需的会话事实（模型 + 最近消息）。同为闭包：MCP 网关的
   *  execute 运行期才解引用 run，档位可在会话中途改。缺省 = 审查拿不到模型，
   *  落到审批卡（fail to human）。 */
  getReviewFacts?: () => ReviewSessionFacts,
  /** 当前会话模式（闭包，运行期才解引用 run）：Question 只在执行档拦
   *  「替审批卡要授权」的提问，plan/ask 的澄清提问不受影响。 */
  getMode?: () => SessionMode,
  /** 项目虚拟目录（多代码工程合并）：运行期实时读 run.externalDirs。
   *  缺省时检索工具不下发（普通任务/未配置项目的会话保持原工具面）。 */
  getExternalDirs?: () => readonly ExternalDir[],
  /** 沙箱计划（闭包）：bash 走 OS 沙箱，read/write/edit/http 走宿主路径/网络裁决。 */
  getSandboxPlan?: () => Promise<SandboxPlan | null> | SandboxPlan | null,
): AgentTool[] {
  const tools: AgentTool[] = [
    hostTool("bash", cwd, threadId,
      BASH_TOOL_DESCRIPTION,
      Type.Object({
        command: Type.String({ description: "The shell command to run" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in ms (default 120000, max 600000); ignored with runInBackground" }),
        ),
        runInBackground: Type.Optional(
          Type.Boolean({ description: "Run detached and return a taskId immediately (for dev servers, builds, watchers)" }),
        ),
      }),
      // 密钥注入：只把**名字**挂到信封上（值在 Rust 侧查库解密 + 输出脱敏，
      // 见 docs/secrets-env-design.md）。名单由用户绑定 + 本线程已加载技能决定，
      // 模型无从指定；本次没命中任何绑定时返回空对象，信封与从前完全一致。
      // 访问加速：git clone/fetch 的 github.com 地址经 insteadOf 走镜像（环境变量
      // 由 Rust 注入那一条派生进程，不落盘、不改用户 git 配置）；命令里带 push
      // 时整个跳过——镜像只代理读。
      (params) => {
        // 任务目录落盘点（见 buildTools 的 ensureCwd 注释）：宿主 spawn 前必须存在
        ensureCwd?.();
        const extra: Record<string, unknown> = {};
        const secretEnv = resolveSecretEnv(cwd, threadId);
        if (secretEnv.length) extra.secretEnv = secretEnv;
        const accelEnv = activeGitAccelEnv(params.command);
        if (accelEnv) extra.accelEnv = accelEnv;
        return extra;
      },
      undefined,
      getSandboxPlan,
    ),
    hostTool(
      "task_output",
      cwd,
      threadId,
      "Read collected output and status of a background task started with bash runInBackground:true. " +
        "Returns everything the process printed so far (tail, up to 256KB) plus whether it is still running. " +
        "Check after doing other work rather than polling in a tight loop.",
      Type.Object({
        taskId: Type.Number({ description: "The taskId returned when the background task started" }),
      }),
    ),
    hostTool(
      "task_stop",
      cwd,
      threadId,
      "Kill a background task's whole process tree (started with bash runInBackground:true). " +
        "Use when the task is no longer needed or stuck.",
      Type.Object({
        taskId: Type.Number({ description: "The taskId of the background task to kill" }),
      }),
    ),
    hostTool("read", cwd, threadId,
      READ_TOOL_DESCRIPTION,
      Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        offset: Type.Optional(Type.Number({ description: "1-based start line" })),
        limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
      }),
      undefined,
      undefined,
      getSandboxPlan,
    ),
    hostTool("write", cwd, threadId,
      WRITE_TOOL_DESCRIPTION,
      Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        content: Type.String({ description: "Full file content" }),
        mode: Type.Optional(
          Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
            description:
              "Default overwrite. Use append to extend an existing file in parts (large-file strategy).",
          }),
        ),
      }),
      undefined,
      () => (getExternalDirs?.() ?? []).map((dir) => dir.path),
      getSandboxPlan,
    ),
    hostTool("edit", cwd, threadId,
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
      undefined,
      () => (getExternalDirs?.() ?? []).map((dir) => dir.path),
      getSandboxPlan,
    ),
    buildGlobTool(cwd),
    buildGrepTool(cwd),
    ...buildWebTools(cwd, getSandboxPlan),
    // 浏览器驱动：执行转发 Rust 宿主（browser.rs）驱动面板子 webview，
    // threadId 用于 data-panelOpen 面板唤起（见 browser-tools.ts）
    ...buildBrowserTools(threadId),
    // 屏幕截图：执行转发 Rust 宿主（tool_exec.rs，macOS only），结果 image 块
    // 走正规投影链路上屏（image-parts.ts 闸门 + 前端 data-image 渲染）
    buildScreenshotTool(cwd),
    // 文生图（OpenAI 兼容 images 协议，见 imagegen-tool.ts）：sidecar 直连出网，
    // 结果 image 块走正规投影链路上屏；常驻注册，开关/模型在 execute 实时门控
    buildImageGenTool({ cwd, getSandbox: getSandboxPlan }),
    // 面板打开文件：只发 data-panelOpen chunk（文件标签磁盘实时模式），
    // 无 IO 无副作用（见 open-file-tool.ts）
    buildOpenFileTool(cwd, threadId),
    // 面板唤起插件 UI：只发 data-pluginOpen chunk（通用原语，插件无关，
    // 面板存在性经插件 store 校验；见 open-panel-tool.ts）
    buildOpenPanelTool(cwd, threadId),
    // Question 不触盘不触网（挂起等 UI 作答），但要 threadId 做挂起归属；
    // getMode 让执行档把「替审批卡要授权」的提问拦下来
    buildQuestionTool(threadId, getMode),
    // todo：不触盘不触网，只维护会话内任务清单（per-thread 槽见 todo.ts）
    buildTodoTool(threadId),
    // 记忆三件套（write/read/search）：按总开关**条件注册**——关闭时整组不下发，
    // 模型看不见工具，记忆能力就是不存在（比"给了再拒绝"干净，也没有误报成功的余地）。
    // 开关翻转由 reloadMemoryTools 整表重建活动会话；工具表只在用户拨开关那一次变化，
    // 稳定期缓存照旧命中。开启时作用域/检索细项仍在 execute 内实时门控（第二道闸，
    // 防轮中翻转后残留的旧工具表仍能写）。cwd 供工作区作用域定位（rebindRunCwd 也会重建）
    ...(getMemoryConfig().enabled ? buildMemoryTools(cwd) : []),
    // 技能调用：按名加载生效技能正文（只读动作，不进审批；见 skill-use-tool.ts）；
    // threadId 供"已加载技能"台账登记（密钥注入的判定条件之一）
    buildSkillUseTool(cwd, threadId, getExternalDirs),
    // 设计主题加载：按名（或会话缺省主题）取 DESIGN.md 全文（只读动作，不进审批；
    // 见 design-md/use-design-theme-tool.ts）。缺省目标经 getDesignTheme 闭包按引用
    // 读 run.designTheme，会话内切主题即时生效；未注入闭包时工具回落最近使用 kv；
    // getThemeLoads 台账供重复加载短路（同 ref 同正文哈希 → 简短确认不重贴全文）
    buildUseDesignThemeTool(getDesignTheme ?? (() => null), getThemeLoads),
    // MCP 网关（search/describe/call/status）：常驻注册的代理工具，全部服务器
    // 的工具面走这一个入口；cwd 决定工作区层配置来源（rebindRunCwd 会重建），
    // 审批档位决定 call 动作要不要逐次弹审批（「完全访问」档不弹；
    // 「AI 审查」档先让审查器判，见 permissions/auto-review.ts）
    buildMcpTool(cwd, threadId, undefined, getApprovalLevel, getReviewFacts),
    // 项目虚拟目录检索：只读，跨项目所有附加根搜索文件（目录由项目设置管理，
    // 模型不能自行增删）。未注入闭包时不下发。
    ...(getExternalDirs ? [buildSearchExternalFilesTool({ getExternalDirs })] : []),
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
export const SYSTEM_PROMPT_CORE_SEGMENTS = {
  identity:
    "You are a capable coding agent running inside the Kova desktop app.",
  discipline: [
    "Code change discipline:",
    "- Read the relevant code before making changes.",
    "- Make minimal diffs; no refactoring or extra abstractions unless asked.",
    "- Follow the existing code style and framework conventions.",
    "- Touch only files related to the task at hand.",
    "",
    "Tool preference: inspect files with read/glob/grep instead of shell commands; use bash for anything dynamic (build, test, git, process control).",
    "Before a batch of tool calls, write one short sentence saying what you are about to do.",
    "",
    "Permissions: never use Question to ask for permission, to confirm an action, or to get a deletion or other destructive action approved. Call the tool directly - the app shows an approval card when approval is required, and the user can choose to remember the authorization. A Question answer is not an authorization; only the approval card is. This applies especially to destructive actions and writes outside the workspace: attempt the work normally instead of asking in chat, and if it is rejected, report the rejection rather than retrying the same question.",
    "",
    "Correctness: after making changes, run the relevant verification (build / test / lint). When something fails, find the root cause before fixing - never blind-patch or hide errors.",
  ].join("\n"),
  taskTracking: [
    "Task tracking:",
    "- Use `todo` only for genuinely multi-step work - three or more concrete steps the user can name. Never create tasks for questions, explanations, or work you can finish in one or two tool calls; answering a question is not a task.",
    "- Mark a task in_progress (pass activeForm) BEFORE beginning work; mark it completed IMMEDIATELY when done - never batch completions. Exactly one task in_progress at a time.",
    "- Never mark a task completed while tests are failing, the work is partial, or errors are unresolved - keep it in_progress and create a new task for the blocker instead.",
    "- Task status is a 4-state machine: pending -> in_progress -> completed, plus deleted as a tombstone. To change status call update with the task id and target status.",
    "- Use blockedBy for dependencies (additive merge on update via addBlockedBy/removeBlockedBy); cycles are rejected.",
    "- Subject must be short and imperative; description is for long-form detail; activeForm is the present-continuous label shown while in_progress.",
  ].join("\n"),
  subagents: [
    "Subagents:",
    "- Use `Task` to delegate separable work (parallel exploration, multi-file implementation, adversarial review, wide search) to subagents; converge with `TaskWait` / `TaskList` / `TaskStop`.",
    "- Call `subagents_list` to see the current definitions and their storage directories - never guess paths or read the YAML files yourself.",
    "- To create or update a reusable subagent use `subagents_save`; to remove one use `subagents_delete`. Never hand-edit their YAML with write/edit: those tools skip validation, cross-layer dedup and hot-reload.",
    "- scope=workspace puts a definition in this repo (.kova/subagents/, shared with the team); scope=system makes it machine-wide.",
    "- A subagent sees neither this conversation nor the user, can only use the tools its definition declares (from bash/read/write/edit/glob/grep), and its final report is its only output - design description, tools and prompt with that in mind.",
  ].join("\n"),
  communication: [
    "Communication:",
    "- Reply in the same language the user writes in.",
    "- Make the final message self-contained: the outcome, what changed, and anything still open.",
  ].join("\n"),
} as const;

/** 段名序 = 拼接序。抽取成段是为了让问答档能剔掉与"只回答不动手"无关的段，
 *  而非改写内容——全量拼接的结果与拆分前逐字节相同，缓存不变式不受影响 */
const SYSTEM_PROMPT_CORE_SEGMENT_ORDER = [
  "identity",
  "discipline",
  "taskTracking",
  "subagents",
  "communication",
] as const satisfies readonly (keyof typeof SYSTEM_PROMPT_CORE_SEGMENTS)[];

export type SystemPromptCoreSegment =
  (typeof SYSTEM_PROMPT_CORE_SEGMENT_ORDER)[number];

/** 按给定段序拼静态核心；缺省给全量段（code/plan 档走这里） */
export function systemPromptCore(
  segments: readonly SystemPromptCoreSegment[] = SYSTEM_PROMPT_CORE_SEGMENT_ORDER,
): string {
  return segments.map((s) => SYSTEM_PROMPT_CORE_SEGMENTS[s]).join("\n\n");
}

export const SYSTEM_PROMPT_CORE = systemPromptCore();

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
