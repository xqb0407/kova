import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  globalAgentsMdPath,
  instructionsPromptBlock,
  workspaceAgentsMdPath,
} from "../../src/agent/instructions";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { workspacePromptLine } from "../../src/tools/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-instructions-"));
const ws = path.join(tmp, "ws");
const prevPin = process.env.PI_GLOBAL_AGENTS_MD;

const globalPath = path.join(tmp, "global-AGENTS.md");
const wsPath = path.join(ws, "AGENTS.md");

beforeAll(() => {
  // 全局层钉到临时文件，保证基线不受真实 ~/.kova/AGENTS.md 影响
  process.env.PI_GLOBAL_AGENTS_MD = globalPath;
  mkdirSync(ws, { recursive: true });
});

afterAll(() => {
  if (prevPin === undefined) delete process.env.PI_GLOBAL_AGENTS_MD;
  else process.env.PI_GLOBAL_AGENTS_MD = prevPin;
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
    rmSync(globalPath, { recursive: true, force: true });
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
    rmSync(globalPath, { recursive: true, force: true });
    rmSync(wsPath, { recursive: true, force: true });
    mkdirSync(globalPath, { recursive: true });
    expect(instructionsPromptBlock(ws)).toBe("");
  });

  test("超限文件保头截断并附标记", () => {
    rmSync(globalPath, { recursive: true, force: true });
    const big = "x".repeat(20_000);
    writeFileSync(wsPath, big);
    const block = instructionsPromptBlock(ws);
    expect(block).toContain("[truncated");
    expect(block.length).toBeLessThan(big.length);
  });

  test("cwd 为空/纯空白时只读全局层", () => {
    writeFileSync(globalPath, "global only\n");
    rmSync(wsPath, { recursive: true, force: true });
    const block = instructionsPromptBlock("   ");
    expect(block).toContain("### global");
    expect(block).not.toContain("### workspace");
  });
});

describe("路径解析", () => {
  test("PI_GLOBAL_AGENTS_MD 钉住生效；工作区层 = <cwd>/AGENTS.md", () => {
    expect(globalAgentsMdPath()).toBe(globalPath);
    expect(workspaceAgentsMdPath("/repo")).toBe(path.join("/repo", "AGENTS.md"));
  });
});

describe("composeModeSystemPrompt 集成", () => {
  test("有 AGENTS.md 时提示词含指令段，环境块仍收尾", () => {
    writeFileSync(wsPath, "Keep diffs minimal.\n");
    const prompt = composeModeSystemPrompt("agent", ws);
    expect(prompt).toContain("## Instructions (AGENTS.md)");
    expect(prompt).toContain("Keep diffs minimal.");
    expect(prompt.endsWith(workspacePromptLine(ws))).toBe(true);
    // 指令段必须在环境事实块之前（动态尾部顺序：技能段 < 指令段 < 环境块）
    expect(prompt.indexOf("## Instructions (AGENTS.md)")).toBeLessThan(
      prompt.indexOf("Environment (host facts):"),
    );
  });

  test("删除文件后重组：提示词回到不含指令段", () => {
    rmSync(wsPath, { recursive: true, force: true });
    rmSync(globalPath, { recursive: true, force: true });
    const prompt = composeModeSystemPrompt("agent", ws);
    expect(prompt).not.toContain("AGENTS.md");
  });
});
