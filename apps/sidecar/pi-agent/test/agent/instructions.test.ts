import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  globalAgentsMdPath,
  globalClaudeMdPath,
  instructionsPromptBlock,
  workspaceAgentsMdPath,
  workspaceClaudeMdPaths,
} from "../../src/agent/instructions";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { workspacePromptLine } from "../../src/tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-instructions-"));
const ws = path.join(tmp, "ws");
const prevPin = process.env.PI_GLOBAL_AGENTS_MD;
const prevClaudePin = process.env.PI_GLOBAL_CLAUDE_MD;

const globalPath = path.join(tmp, "global-AGENTS.md");
const globalClaudePath = path.join(tmp, "global-CLAUDE.md");
const wsPath = path.join(ws, "AGENTS.md");

beforeAll(() => {
  // 两层全局路径都钉到临时文件，保证基线不受真实 ~/.kova/AGENTS.md 或
  // ~/.claude/CLAUDE.md 影响
  process.env.PI_GLOBAL_AGENTS_MD = globalPath;
  process.env.PI_GLOBAL_CLAUDE_MD = globalClaudePath;
  mkdirSync(ws, { recursive: true });
});

beforeEach(() => {
  // 每个用例从空目录起步：既有用例原本依赖执行顺序，这里统一收口
  rmSync(globalPath, { recursive: true, force: true });
  rmSync(globalClaudePath, { recursive: true, force: true });
  rmSync(wsPath, { recursive: true, force: true });
  rmSync(path.join(ws, "CLAUDE.md"), { recursive: true, force: true });
  rmSync(path.join(ws, ".claude"), { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
});

afterAll(() => {
  if (prevPin === undefined) delete process.env.PI_GLOBAL_AGENTS_MD;
  else process.env.PI_GLOBAL_AGENTS_MD = prevPin;
  if (prevClaudePin === undefined) delete process.env.PI_GLOBAL_CLAUDE_MD;
  else process.env.PI_GLOBAL_CLAUDE_MD = prevClaudePin;
});

describe("instructionsPromptBlock", () => {
  test("两层都无文件 → 空串（默认提示词字节级不变）", () => {
    expect(instructionsPromptBlock(ws)).toBe("");
  });

  test("仅全局层：含 global 小节，不含 workspace 小节", () => {
    writeFileSync(globalPath, "Always use pnpm in any repo.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("## Instructions (AGENTS.md)");
    expect(block).toContain("### global");
    expect(block).toContain("Always use pnpm");
    expect(block).not.toContain("### workspace");
  });

  test("仅工作区层：含 workspace 小节，不含 global 小节", () => {
    writeFileSync(wsPath, "Prefer bun test over jest.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("### workspace");
    expect(block).toContain("Prefer bun test");
    expect(block).not.toContain("### global");
  });

  test("两层并存：全局在前、工作区在后", () => {
    writeFileSync(globalPath, "global rule\n");
    writeFileSync(wsPath, "workspace rule\n");
    const block = instructionsPromptBlock(ws);
    expect(block.indexOf("### global")).toBeGreaterThan(-1);
    expect(block.indexOf("### global")).toBeLessThan(block.indexOf("### workspace"));
  });

  test("空文件/纯空白 → 该层跳过；两层都空 → 空串", () => {
    writeFileSync(globalPath, "   \n\t\n");
    writeFileSync(wsPath, "");
    expect(instructionsPromptBlock(ws)).toBe("");
  });

  test("路径是目录 → 跳过不抛错", () => {
    mkdirSync(globalPath, { recursive: true });
    mkdirSync(wsPath, { recursive: true });
    expect(instructionsPromptBlock(ws)).toBe("");
  });

  test("超限文件保头截断并附标记", () => {
    const big = "x".repeat(20_000);
    writeFileSync(wsPath, big);
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("[truncated");
    expect(block.length).toBeLessThan(big.length);
  });

  test("cwd 为空/纯空白时只读全局层", () => {
    writeFileSync(globalPath, "global only\n");
    const block = instructionsPromptBlock("   ");
    expect(block).toContain("### global");
    expect(block).not.toContain("### workspace");
  });
});

describe("CLAUDE.md 回退", () => {
  test("工作区无 AGENTS.md 时读 <cwd>/CLAUDE.md", () => {
    writeFileSync(path.join(ws, "CLAUDE.md"), "Use CLAUDE rules.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("## Instructions (CLAUDE.md)");
    expect(block).toContain("### workspace (CLAUDE.md)");
    expect(block).toContain("Use CLAUDE rules.");
  });

  test("<cwd>/.claude/CLAUDE.md 作为第二回退", () => {
    mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeFileSync(path.join(ws, ".claude", "CLAUDE.md"), "Nested rules.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("## Instructions (CLAUDE.md)");
    expect(block).toContain("### workspace (.claude/CLAUDE.md)");
    expect(block).toContain("Nested rules.");
  });

  test("AGENTS.md 优先：同层同时存在时只注入 AGENTS.md", () => {
    writeFileSync(wsPath, "AGENTS wins.\n");
    writeFileSync(path.join(ws, "CLAUDE.md"), "CLAUDE loses.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("### workspace");
    expect(block).toContain("AGENTS wins.");
    expect(block).not.toContain("CLAUDE loses.");
  });

  test("全局层回退 ~/.claude/CLAUDE.md", () => {
    writeFileSync(globalClaudePath, "Global CLAUDE rule.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("## Instructions (CLAUDE.md)");
    expect(block).toContain("### global (CLAUDE.md)");
    expect(block).toContain("Global CLAUDE rule.");
  });

  test("混合来源：标题按 AGENTS.md / CLAUDE.md 固定顺序", () => {
    writeFileSync(globalPath, "global agents\n");
    writeFileSync(path.join(ws, "CLAUDE.md"), "workspace claude\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("## Instructions (AGENTS.md / CLAUDE.md)");
    expect(block).toContain("### global");
    expect(block).toContain("### workspace (CLAUDE.md)");
  });

  test("空 AGENTS.md 回退到 CLAUDE.md", () => {
    writeFileSync(wsPath, "   \n");
    writeFileSync(path.join(ws, "CLAUDE.md"), "Fallback body.\n");
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("### workspace (CLAUDE.md)");
    expect(block).toContain("Fallback body.");
  });

  test("CLAUDE.md 同样受 16k 截断", () => {
    const big = "c".repeat(20_000);
    writeFileSync(path.join(ws, "CLAUDE.md"), big);
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("[truncated");
    expect(block.length).toBeLessThan(big.length);
  });
});

describe("路径解析", () => {
  test("PI_GLOBAL_AGENTS_MD 钉住生效；工作区层 = <cwd>/AGENTS.md", () => {
    expect(globalAgentsMdPath()).toBe(globalPath);
    expect(workspaceAgentsMdPath("/repo")).toBe(path.join("/repo", "AGENTS.md"));
  });

  test("PI_GLOBAL_CLAUDE_MD 钉住生效；工作区 CLAUDE 候选根级优先", () => {
    expect(globalClaudeMdPath()).toBe(globalClaudePath);
    expect(workspaceClaudeMdPaths("/repo")).toEqual([
      path.join("/repo", "CLAUDE.md"),
      path.join("/repo", ".claude", "CLAUDE.md"),
    ]);
  });
});

describe("composeModeSystemPrompt 集成", () => {
  test("有 AGENTS.md 时提示词含指令段，环境块仍收尾", () => {
    writeFileSync(wsPath, "Keep diffs minimal.\n");
    const prompt = composeModeSystemPrompt("agent", ws, "code");
    expect(prompt).toContain("## Instructions (AGENTS.md)");
    expect(prompt).toContain("Keep diffs minimal.");
    expect(prompt.endsWith(workspacePromptLine(ws))).toBe(true);
    // 指令段必须在环境事实块之前（动态尾部顺序：技能段 < 指令段 < 环境块）
    expect(prompt.indexOf("## Instructions (AGENTS.md)")).toBeLessThan(
      prompt.indexOf("Environment (host facts):"),
    );
  });

  test("删除文件后重组：提示词回到不含指令段", () => {
    const prompt = composeModeSystemPrompt("agent", ws, "code");
    expect(prompt).not.toContain("AGENTS.md");
  });
});
