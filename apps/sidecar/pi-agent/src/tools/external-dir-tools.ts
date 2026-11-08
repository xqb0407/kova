/**
 * 项目虚拟目录检索工具：跨项目所有附加根目录搜索文件（只读）。
 *
 * 目录只能由用户在项目设置里增删（不从模型侧开放），所以这里没有 add 工具：
 * 模型能检索，但不能改变项目边界。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExternalDir } from "pi-protocol";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { searchExternalDirs } from "../agent/external-dirs";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 1_000;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export type ExternalDirToolDeps = {
  /** 当前项目的虚拟目录（工具执行期实时读 run.externalDirs） */
  getExternalDirs: () => readonly ExternalDir[];
};

export function buildSearchExternalFilesTool(deps: ExternalDirToolDeps): AgentTool {
  return {
    name: "search_external_files",
    label: "Search Project Folders",
    description:
      "Search for files across all additional folders attached to this project. " +
      "Supports glob patterns like '*.ts' or 'src/**/*.test.ts'. " +
      "Use this when you need to find a file in another code repository of the same project. " +
      "Skips .git, node_modules, hidden directories and symlinks.",
    parameters: obj({
      pattern: str({
        description: "File name or glob pattern to search for",
        minLength: 1,
      }),
      maxResults: opt(
        int({
          description: `Maximum number of results (default: ${DEFAULT_MAX_RESULTS}, maximum: ${MAX_RESULTS})`,
          minimum: 1,
          maximum: MAX_RESULTS,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { pattern, maxResults } = params as {
        pattern: string;
        maxResults?: number;
      };
      const dirs = deps.getExternalDirs() ?? [];
      if (dirs.length === 0) {
        throw new Error(
          "This project has no additional folders. Add them in the project settings first.",
        );
      }
      const result = await searchExternalDirs(
        dirs,
        pattern,
        maxResults ?? DEFAULT_MAX_RESULTS,
        signal ?? undefined,
      );
      if (result.totalFound === 0) {
        return textResult(
          `No files matching "${result.pattern}" found in ${dirs.length} additional folder${dirs.length === 1 ? "" : "s"}.`,
          { totalFound: 0, pattern: result.pattern, directoryCount: 0, truncated: false },
        );
      }
      const lines = [
        `Found ${result.totalFound} file(s) matching "${result.pattern}":\n`,
      ];
      for (const directory of result.directories) {
        lines.push(`📂 ${directory.label} (${directory.path}):`);
        for (const file of directory.files) lines.push(`  ${file}`);
        lines.push("");
      }
      if (result.truncated) {
        lines.push(`…[stopped at the ${result.maxResults}-result limit; narrow the pattern to see more]`);
      }
      return textResult(lines.join("\n"), {
        totalFound: result.totalFound,
        pattern: result.pattern,
        directoryCount: result.directories.length,
        truncated: result.truncated,
      });
    },
  };
}
