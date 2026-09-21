/**
 * 指令文件（AGENTS.md）的发现与注入。
 *
 * 仓库根 AGENTS.md 是跨工具共享的指令事实标准（OpenAI Codex / Claude Code 兼读），
 * 组装系统提示词时读取并注入动态尾部段；全局层 ~/.xulux/AGENTS.md 提供机器级
 * 指令（Codex 的 ~/.codex/AGENTS.md 同位）。
 *
 * 注入语义（对齐 memoryPromptBlock 家族纪律）：
 * - 全局在前、工作区在后（更具体的指令更靠近尾部），各文件一个 ### 小节；
 * - 缺失/为空/路径是目录 → 该层跳过；两层都无内容 → 空串，默认提示词字节级不变
 *   （与 skills / mcp 块同款兜底）；
 * - 单文件 16k 字符截断（保头部），防失控巨型指令文件撑爆上下文；
 * - 每次组装同步读盘（memory 同款，无缓存、无 init 闸门、无 kv）：文件改动在
 *   下一次提示词重组（新会话 / reloadSkills / applyMode 等热替换路径）自然生效。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 单文件注入上限（字符） */
const MAX_FILE_CHARS = 16_000;

const BLOCK_HEADER = "## Instructions (AGENTS.md)";
const BLOCK_GUIDE =
  "The following are user-maintained instructions for this workspace; follow them together with the rules above.";

/** 全局层路径（机器级；测试经 PI_GLOBAL_AGENTS_MD 钉住，兜底 ~/.xulux/AGENTS.md） */
export function globalAgentsMdPath(): string {
  if (process.env.PI_GLOBAL_AGENTS_MD) return process.env.PI_GLOBAL_AGENTS_MD;
  return join(homedir(), ".xulux", "AGENTS.md");
}

/** 工作区层路径（仓库根，随 git 共享给所有兼容工具） */
export function workspaceAgentsMdPath(cwd: string): string {
  return join(cwd, "AGENTS.md");
}

/** 读一层：缺失/为空/路径是目录 → undefined；超限保头截断并附标记 */
function readLayer(path: string, label: string): string | undefined {
  let raw: string;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const body = raw.trim();
  if (!body) return undefined;
  const clipped =
    body.length > MAX_FILE_CHARS
      ? `${body.slice(0, MAX_FILE_CHARS)}\n…[truncated ${body.length - MAX_FILE_CHARS} chars]`
      : body;
  return `### ${label}\n${clipped}`;
}

/** 系统提示词的指令段：两层都无内容返回空串（默认提示词字节级不变） */
export function instructionsPromptBlock(cwd?: string): string {
  const sections = [
    readLayer(globalAgentsMdPath(), "global"),
    cwd && cwd.trim() ? readLayer(workspaceAgentsMdPath(cwd.trim()), "workspace") : undefined,
  ].filter((s): s is string => Boolean(s));
  if (sections.length === 0) return "";
  return [BLOCK_HEADER, BLOCK_GUIDE, ...sections].join("\n\n");
}
