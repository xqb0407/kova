import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitPromptBlock,
  invalidateGitSnapshots,
  resetGitPromptForTests,
} from "../../src/agent/git-prompt";
import { composeModeSystemPrompt } from "../../src/agent/modes";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-git-prompt-"));
const prevGlobalAgents = process.env.PI_GLOBAL_AGENTS_MD;
const prevGlobalClaude = process.env.PI_GLOBAL_CLAUDE_MD;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 每个用例独立仓库：分支/提交缓存按仓库根隔离，避免用例互相污染 */
function makeRepo(name: string): string {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init commit"]);
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "second commit"]);
  return dir;
}

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 指令段全局层钉到不存在的临时路径：compose 集成断言不受开发者真实
  // ~/.kova/AGENTS.md 或 ~/.claude/CLAUDE.md 影响
  process.env.PI_GLOBAL_AGENTS_MD = path.join(tmp, "global-AGENTS.md");
  process.env.PI_GLOBAL_CLAUDE_MD = path.join(tmp, "global-CLAUDE.md");
});

beforeEach(() => {
  resetGitPromptForTests();
});

afterAll(() => {
  resetGitPromptForTests();
  resetStorageForTest();
  if (prevGlobalAgents === undefined) delete process.env.PI_GLOBAL_AGENTS_MD;
  else process.env.PI_GLOBAL_AGENTS_MD = prevGlobalAgents;
  if (prevGlobalClaude === undefined) delete process.env.PI_GLOBAL_CLAUDE_MD;
  else process.env.PI_GLOBAL_CLAUDE_MD = prevGlobalClaude;
  rmSync(tmp, { recursive: true, force: true });
});

describe("gitPromptBlock", () => {
  test("code 档 + 真实仓库：分支、Git 用户、未跟踪文件与最近提交都进段", () => {
    const repo = makeRepo("full");
    writeFileSync(path.join(repo, "dirty.txt"), "x\n");

    const block = gitPromptBlock(repo, "code");
    expect(block).toContain("gitStatus: This is the git status snapshot");
    expect(block).toContain("Current branch:");
    expect(block).toContain("Git user: Test User <test@example.com>");
    expect(block).toContain("?? dirty.txt");
    expect(block).toContain("Recent commits:");
    expect(block).toContain("init commit");
    expect(block).toContain("second commit");
  });

  test("work / design 档：即使目录是 git 仓库也返回空串", () => {
    const repo = makeRepo("modes");
    expect(gitPromptBlock(repo, "work")).toBe("");
    expect(gitPromptBlock(repo, "design")).toBe("");
  });

  test("非 git 目录：空串（不抛错）", () => {
    const plain = path.join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    expect(gitPromptBlock(plain, "code")).toBe("");
    // 空 cwd 不能 resolve 成 sidecar 进程自身目录
    expect(gitPromptBlock("", "code")).toBe("");
    expect(gitPromptBlock("   ", "code")).toBe("");
  });

  test("快照按仓库缓存：新提交不自动刷新，invalidate 后重新采集", () => {
    const repo = makeRepo("cache");
    expect(gitPromptBlock(repo, "code")).toContain("second commit");

    git(repo, ["commit", "--allow-empty", "-q", "-m", "third commit"]);
    expect(gitPromptBlock(repo, "code")).not.toContain("third commit");

    invalidateGitSnapshots();
    expect(gitPromptBlock(repo, "code")).toContain("third commit");
  });
});

describe("composeModeSystemPrompt 集成", () => {
  test("code 档拼接 git 段；work / design 不拼接", () => {
    const repo = makeRepo("compose");

    const code = composeModeSystemPrompt("agent", repo, "code", null);
    expect(code).toContain("Recent commits:");
    expect(code).toContain("second commit");

    const work = composeModeSystemPrompt("agent", repo, "work", null);
    expect(work).not.toContain("Recent commits:");

    const design = composeModeSystemPrompt("agent", repo, "design", null);
    expect(design).not.toContain("Recent commits:");
  });
});
