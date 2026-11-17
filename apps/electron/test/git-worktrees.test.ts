/**
 * 受管 worktree 单测（真 git + 临时目录；docs/git-worktrees.md）。
 * KOVA_WORKTREES_DIR 钉住受管根，绕过 kv/appData。
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createBranch,
  createWorktree,
  isManagedWorktreePath,
  listWorktrees,
  purgeWorktree,
  removeWorktree,
  resetWorktreesForTest,
  restoreWorktree,
  sweepTrash,
  worktreesRoot,
  worktreesStartupSweep,
  type WorktreeRecord,
} from "../main/worktrees";

let dataDir = "";
let worktreesDir = "";
let repo = "";
const leftovers: string[] = [];

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

const commitAll = (message: string): void => {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message);
};

const initRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kova-wt-repo-"));
  leftovers.push(dir);
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};

const setup = (): void => {
  dataDir = mkdtempSync(join(tmpdir(), "kova-wt-data-"));
  leftovers.push(dataDir);
  worktreesDir = join(dataDir, "worktrees");
  repo = initRepo();
  process.env.KOVA_WORKTREES_DIR = worktreesDir;
  resetWorktreesForTest();
};

const teardown = (): void => {
  for (const dir of leftovers) rmSync(dir, { recursive: true, force: true });
};

const readWt = (wt: WorktreeRecord, rel: string): string => readFileSync(join(wt.path, rel), "utf8");

describe("受管 worktree", () => {
  beforeEach(() => setup());
  afterAll(teardown);

  test("创建（clean）：detached HEAD、文件就位、注册表持久化", async () => {
    writeFileSync(join(repo, "a.txt"), "hello");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add a");

    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    expect(record.status).toBe("active");
    expect(record.branch).toBeUndefined();
    expect(existsSync(join(record.path, "a.txt"))).toBe(true);
    expect(existsSync(join(record.path, ".git"))).toBe(true);

    // detached：无当前分支
    const r = spawnSync("git", ["-C", record.path, "symbolic-ref", "--short", "-q", "HEAD"]);
    expect(r.status === 0).toBe(false);

    // 注册表持久化（缓存重置后仍可读回）
    resetWorktreesForTest();
    const all = listWorktrees();
    expect(all).toHaveLength(1);
    expect(all[0]?.path).toBe(record.path);
    expect(all[0]?.exists).toBe(true);

    // 信任面：worktree 内部命中，主仓库/无关目录不命中
    expect(isManagedWorktreePath(record.path)).toBe(true);
    expect(isManagedWorktreePath(join(record.path, "src", "x.ts"))).toBe(true);
    expect(isManagedWorktreePath(repo)).toBe(false);
    expect(worktreesRoot()).toBe(worktreesDir);
  });

  test("创建（includeUncommitted）：staged + unstaged diff 与 untracked 文件跟随", async () => {
    writeFileSync(join(repo, "a.txt"), "v1");
    commitAll("a");
    writeFileSync(join(repo, "a.txt"), "v2 (unstaged)");
    writeFileSync(join(repo, "c.txt"), "staged new");
    git(repo, "add", "c.txt");
    writeFileSync(join(repo, "b.txt"), "untracked");

    const { record, warnings } = await createWorktree({
      repoRoot: repo,
      base: "main",
      includeUncommitted: true,
    });
    expect(readWt(record, "a.txt")).toBe("v2 (unstaged)");
    expect(readWt(record, "c.txt")).toBe("staged new");
    expect(readWt(record, "b.txt")).toBe("untracked");
    expect(warnings.some((w) => w.includes("未跟踪"))).toBe(true);
  });

  test(".worktreeinclude：ignored 拷入 + symlink 跳过 + AGENTS.override.md 恒含", async () => {
    writeFileSync(join(repo, "a.txt"), "tracked");
    writeFileSync(join(repo, ".gitignore"), "secret.env\nlink\n");
    commitAll("base");
    // ignored 未跟踪文件
    writeFileSync(join(repo, "secret.env"), "TOKEN=1");
    // 恒含的未跟踪 override
    writeFileSync(join(repo, "AGENTS.override.md"), "# override");
    // ignored 的 symlink：include 命中但必须跳过
    writeFileSync(join(repo, "real.txt"), "target");
    spawnSync("ln", ["-s", "real.txt", join(repo, "link")]);
    writeFileSync(join(repo, ".worktreeinclude"), "secret.env\nlink\n# 注释\n");

    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    expect(readWt(record, "secret.env")).toBe("TOKEN=1");
    expect(readWt(record, "AGENTS.override.md")).toBe("# override");
    expect(existsSync(join(record.path, "link"))).toBe(false);
    expect(existsSync(join(record.path, "a.txt"))).toBe(true);
  });

  test("创建失败（基线不存在）：无残留目录与注册表条目", async () => {
    let threw = false;
    try {
      await createWorktree({ repoRoot: repo, base: "no-such-branch" });
    } catch (err) {
      threw = true;
      expect(err instanceof Error && err.message.includes("基线不存在")).toBe(true);
    }
    expect(threw).toBe(true);
    expect(listWorktrees()).toHaveLength(0);
  });

  test("收尾：创建分支 kova/<slug>；删除→trash→恢复→彻底删除", async () => {
    writeFileSync(join(repo, "f.txt"), "x");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "f");
    const { record } = await createWorktree({ repoRoot: repo, base: "main", name: "我的任务!" });

    const branched = await createBranch(record.id);
    expect(branched.branch).toBe("kova/我的任务");
    const r = spawnSync("git", ["-C", record.path, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(r.stdout.toString().trim()).toBe("kova/我的任务");

    const removed = await removeWorktree(record.id);
    expect(removed.status).toBe("trashed");
    expect(removed.trashPath && existsSync(removed.trashPath)).toBe(true);
    expect(existsSync(record.path)).toBe(false);

    const restored = await restoreWorktree(record.id);
    expect(restored.status).toBe("active");
    expect(existsSync(record.path)).toBe(true);

    const removed2 = await removeWorktree(record.id);
    await purgeWorktree(record.id);
    expect(removed2.trashPath && existsSync(removed2.trashPath)).toBe(false);
    expect(listWorktrees()).toHaveLength(0);
    // 彻底删除后主仓库元数据被 prune：worktree list 不再含该路径
    const wl = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    expect(wl.stdout.toString()).not.toContain(record.path);
  });

  test("恢复后的 worktree 元数据完好：remove 阶段不 prune", async () => {
    writeFileSync(join(repo, "f.txt"), "x");
    commitAll("f");
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    await removeWorktree(record.id);
    const restored = await restoreWorktree(record.id);
    const r = spawnSync("git", ["-C", restored.path, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("true");
    // 清场：走 purge 释放主仓库元数据
    await removeWorktree(record.id);
    await purgeWorktree(record.id);
  });

  test("trash 保留期清理与启动死记录剔除", async () => {
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    const removed = await removeWorktree(record.id);

    // 未过期：保留
    expect(await sweepTrash(7 * 24 * 60 * 60 * 1000)).toBe(0);
    expect(removed.trashPath && existsSync(removed.trashPath)).toBe(true);

    // 过期：目录与注册表条目一起清掉
    expect(await sweepTrash(0)).toBe(1);
    expect(removed.trashPath && existsSync(removed.trashPath)).toBe(false);
    expect(listWorktrees()).toHaveLength(0);

    // 启动清扫：目录物理消失的 active 记录被剔除
    const { record: wt2 } = await createWorktree({ repoRoot: repo, base: "main" });
    rmSync(wt2.path, { recursive: true, force: true });
    await import("../main/worktrees").then((m) => m.worktreesStartupSweep());
    expect(listWorktrees()).toHaveLength(0);
  });

  test("命令层：未受信 repo 拒绝创建", async () => {
    const handlers: Record<string, (args: any) => any> = {};
    const { setupWorktreeCommands } = await import("../main/worktrees");
    setupWorktreeCommands((name, fn) => {
      handlers[name] = fn;
    });
    const other = initRepo(); // 不在受信根清单里
    try {
      let threw = false;
      try {
        await handlers.worktree_create({ repoRoot: other, base: "main" });
      } catch (err) {
        threw = true;
        expect(err instanceof Error && err.message.includes("不在受信根内")).toBe(true);
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
