/**
 * 指令文件（AGENTS.md / CLAUDE.md）的发现与注入。
 *
 * 仓库根 AGENTS.md 是跨工具共享的指令事实标准（OpenAI Codex 等兼读）；CLAUDE.md
 * 是 Claude Code 的约定文件。每层按「AGENTS.md 优先，缺失/为空时回退 CLAUDE.md」
 * 取一个非空文件，避免同一份规则被重复注入。
 *
 * 两层（同层命中第一个非空文件即停）：
 * - 全局层：~/.kova/AGENTS.md（PI_GLOBAL_AGENTS_MD 可钉住）→ ~/.claude/CLAUDE.md
 * - 工作区层：<cwd>/AGENTS.md → <cwd>/CLAUDE.md → <cwd>/.claude/CLAUDE.md
 *
 * 注入语义（对齐 memoryPromptBlock 家族纪律）：
 * - 全局在前、工作区在后（更具体的指令更靠近尾部），每层一个 ### 小节；
 * - 缺失/为空/路径是目录 → 该候选跳过，继续看同层下一个；两层都无内容 → 空串，
 *   默认提示词字节级不变（与 skills / mcp 块同款兜底）；
 * - 单文件 16k 字符截断（保头部），防失控巨型指令文件撑爆上下文；
 * - 每次组装同步读盘（memory 同款，无缓存、无 init 闸门、无 kv）：文件改动在
 *   下一次提示词重组（新会话 / reloadSkills / applyMode 等热替换路径）自然生效。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 单文件注入上限（字符） */
const MAX_FILE_CHARS = 16_000;

const BLOCK_GUIDE =
  "The following are user-maintained instructions for this workspace; follow them together with the rules above.";

/** 来源在标题里的固定顺序：同时命中两种文件时标题稳定，不随层序漂移 */
const SOURCE_ORDER = ["AGENTS.md", "CLAUDE.md"] as const;
type InstructionSource = (typeof SOURCE_ORDER)[number];

/** 全局层路径（机器级；测试经 PI_GLOBAL_AGENTS_MD 钉住，兜底 ~/.kova/AGENTS.md） */
export function globalAgentsMdPath(): string {
  if (process.env.PI_GLOBAL_AGENTS_MD) return process.env.PI_GLOBAL_AGENTS_MD;
  return join(homedir(), ".kova", "AGENTS.md");
}

/** Claude Code 全局记忆（AGENTS.md 缺失/为空时的回退；测试经 PI_GLOBAL_CLAUDE_MD 钉住） */
export function globalClaudeMdPath(): string {
  if (process.env.PI_GLOBAL_CLAUDE_MD) return process.env.PI_GLOBAL_CLAUDE_MD;
  return join(homedir(), ".claude", "CLAUDE.md");
}

/** 工作区层路径（仓库根，随 git 共享给所有兼容工具） */
export function workspaceAgentsMdPath(cwd: string): string {
  return join(cwd, "AGENTS.md");
}

/** 工作区 CLAUDE.md 回退候选：根级优先，其次 Claude Code 的 .claude/ 目录 */
export function workspaceClaudeMdPaths(cwd: string): string[] {
  return [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md")];
}

type LayerCandidate = { path: string; source: InstructionSource; label: string };
type InstructionLayer = { body: string; source: InstructionSource; label: string };

/** 读一个文件：缺失/为空/路径是目录 → undefined；超限保头截断并附标记 */
function readLayerBody(path: string): string | undefined {
  let raw: string;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const body = raw.trim();
  if (!body) return undefined;
  return body.length > MAX_FILE_CHARS
    ? `${body.slice(0, MAX_FILE_CHARS)}\n…[truncated ${body.length - MAX_FILE_CHARS} chars]`
    : body;
}

/** 同层按候选顺序取第一个非空文件（AGENTS.md 优先，CLAUDE.md 回退） */
function readFirstLayer(candidates: LayerCandidate[]): InstructionLayer | undefined {
  for (const candidate of candidates) {
    const body = readLayerBody(candidate.path);
    if (body) return { body, source: candidate.source, label: candidate.label };
  }
  return undefined;
}

/** 工作区层候选：路径、来源与小节标签在同一处配对，避免顺序调整时错位 */
function workspaceCandidates(cwd: string): LayerCandidate[] {
  const [claudeRoot, claudeDir] = workspaceClaudeMdPaths(cwd);
  return [
    { path: workspaceAgentsMdPath(cwd), source: "AGENTS.md", label: "workspace" },
    { path: claudeRoot, source: "CLAUDE.md", label: "workspace (CLAUDE.md)" },
    { path: claudeDir, source: "CLAUDE.md", label: "workspace (.claude/CLAUDE.md)" },
  ];
}

/** 系统提示词的指令段：两层都无内容返回空串（默认提示词字节级不变） */
export function instructionsPromptBlock(cwd?: string): string {
  const global = readFirstLayer([
    { path: globalAgentsMdPath(), source: "AGENTS.md", label: "global" },
    { path: globalClaudeMdPath(), source: "CLAUDE.md", label: "global (CLAUDE.md)" },
  ]);
  const ws = cwd?.trim();
  const workspace = ws ? readFirstLayer(workspaceCandidates(ws)) : undefined;
  const layers = [global, workspace].filter(
    (layer): layer is InstructionLayer => Boolean(layer),
  );
  if (layers.length === 0) return "";

  // 标题按固定来源顺序列出实际命中的文件类型；只有 AGENTS.md 时与旧版完全一致
  const sources = SOURCE_ORDER.filter((source) =>
    layers.some((layer) => layer.source === source),
  );
  const sections = [
    global ? `### ${global.label}\n${global.body}` : undefined,
    workspace ? `### ${workspace.label}\n${workspace.body}` : undefined,
  ].filter((section): section is string => Boolean(section));
  return [`## Instructions (${sources.join(" / ")})`, BLOCK_GUIDE, ...sections].join("\n\n");
}
