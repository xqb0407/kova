/**
 * 内置编码工具（bash / read / write / edit）与系统提示词。
 * bash 在子进程里执行并截断超长输出；read/write/edit 直接操作工作区文件。
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_TOOL_OUTPUT = 16 * 1024;
const MAX_READ_BYTES = 64 * 1024;

function resolveInWorkspace(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export function buildTools(cwd: string): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "bash",
      label: "Bash",
      description:
        "Run a shell command in the workspace and return combined stdout/stderr. " +
        "Output is capped; use narrower commands (grep/tail/head) instead of dumping large files.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to run" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds (default 120000)" }),
        ),
      }),
      execute: async (_id, params) => {
        const { command, timeout } = params as {
          command: string;
          timeout?: number;
        };
        const child = spawn("/bin/bash", ["-c", command], {
          cwd,
          env: process.env,
        });
        let out = "";
        let truncated = false;
        const collect = (chunk: Buffer) => {
          if (out.length >= MAX_TOOL_OUTPUT) {
            truncated = true;
            child.kill();
            return;
          }
          out += chunk.toString("utf8");
          if (out.length > MAX_TOOL_OUTPUT) {
            out = out.slice(0, MAX_TOOL_OUTPUT);
            truncated = true;
            child.kill();
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            truncated = true;
            child.kill();
            resolve(null);
          }, timeout ?? 120_000);
          child.on("close", (c) => {
            clearTimeout(timer);
            resolve(c);
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve(-1);
          });
        });
        const suffix = truncated ? "\n…[output truncated]" : "";
        const status =
          code === 0 ? "" : code === null ? "\n[timeout]" : `\n[exit code: ${code}]`;
        return textResult(out + status + suffix, { truncated, exitCode: code });
      },
    },
    {
      name: "read",
      label: "Read",
      description:
        "Read a text file. Returns up to 64KB with line numbers. " +
        "Use offset/limit to paginate large files.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        offset: Type.Optional(Type.Number({ description: "1-based start line" })),
        limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
      }),
      execute: async (_id, params) => {
        const { file_path, offset, limit } = params as {
          file_path: string;
          offset?: number;
          limit?: number;
        };
        const full = resolveInWorkspace(cwd, file_path);
        const raw = readFileSync(full, "utf8");
        if (raw.includes("\0")) {
          throw new Error(`${file_path} is a binary file and cannot be read as text`);
        }
        const allLines = raw.split("\n");
        const start = Math.max((offset ?? 1) - 1, 0);
        const end = Math.min(start + (limit ?? allLines.length), allLines.length);
        let slice = allLines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");
        if (slice.length > MAX_READ_BYTES) {
          slice = slice.slice(0, MAX_READ_BYTES) + "\n…[truncated]";
        }
        const more =
          end < allLines.length
            ? `\n…[${allLines.length - end} more lines, total ${allLines.length}]`
            : "";
        return textResult(slice + more, { totalLines: allLines.length });
      },
    },
    {
      name: "write",
      label: "Write",
      description: "Write (or create) a file with the given content. Parent directories are created automatically.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        content: Type.String({ description: "Full file content" }),
      }),
      execute: async (_id, params) => {
        const { file_path, content } = params as {
          file_path: string;
          content: string;
        };
        const full = resolveInWorkspace(cwd, file_path);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
        return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${file_path}`);
      },
    },
    {
      name: "edit",
      label: "Edit",
      description:
        "Replace an exact string in a file. old_string must match exactly and appear exactly once, " +
        "unless replace_all is true.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        old_string: Type.String({ description: "Exact text to replace" }),
        new_string: Type.String({ description: "Replacement text" }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence (default false)" }),
        ),
      }),
      execute: async (_id, params) => {
        const { file_path, old_string, new_string, replace_all } = params as {
          file_path: string;
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        };
        const full = resolveInWorkspace(cwd, file_path);
        const raw = readFileSync(full, "utf8");
        const occurrences = raw.split(old_string).length - 1;
        if (occurrences === 0) {
          throw new Error(`old_string not found in ${file_path}`);
        }
        if (occurrences > 1 && !replace_all) {
          throw new Error(
            `old_string appears ${occurrences} times in ${file_path}; provide more context or set replace_all=true`,
          );
        }
        const updated =
          occurrences > 1 ? raw.replaceAll(old_string, new_string) : raw.replace(old_string, new_string);
        writeFileSync(full, updated, "utf8");
        return textResult(`Replaced ${replace_all && occurrences > 1 ? occurrences : 1} occurrence(s) in ${file_path}`);
      },
    },
  ];
  return tools;
}

export const systemPrompt = (cwd: string) =>
  [
    "You are a capable coding agent running inside the Xulux desktop app.",
    `The workspace directory is \`${cwd}\`. Relative paths resolve there.`,
    "Reply in the same language the user writes in.",
    "Prefer the read tool over shell commands for inspecting files; use bash for anything dynamic.",
    "Before a batch of tool calls, write one short sentence saying what you are about to do.",
    "Make the final message self-contained: the outcome, what changed, and anything still open.",
  ].join("\n");
