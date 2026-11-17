/**
 * 受管 worktree 单测（真 git + 临时目录；docs/git-worktrees.md）。
 * KOVA_WORKTREES_DIR 钉住受管根，绕过 kv/appData。
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

describe("worktree 设置与数量上限清理", () => {
  beforeEach(() => setup());
  afterAll(teardown);

  test("设置：默认值 / clamp / set 后 get 一致", () => {
    const { setWorktreeSettings, getWorktreeSettings } = require("../main/worktrees");
    expect(getWorktreeSettings()).toEqual({
      fetchBeforeCreate: false,
      autoCleanup: true,
      autoCleanupLimit: 15,
    });
    setWorktreeSettings({ autoCleanupLimit: 99 });
    expect(getWorktreeSettings().autoCleanupLimit).toBe(50);
    setWorktreeSettings({ autoCleanupLimit: 0 });
    expect(getWorktreeSettings().autoCleanupLimit).toBe(1);
    setWorktreeSettings({ fetchBeforeCreate: true, autoCleanup: false, autoCleanupLimit: 15 });
    expect(getWorktreeSettings()).toEqual({
      fetchBeforeCreate: true,
      autoCleanup: false,
      autoCleanupLimit: 15,
    });
  });

  test("数量上限：超限从最旧未绑定开始清（进 trash），绑定会话的保护", async () => {
    const { setWorktreeSettings, sweepActiveBeyondLimit, bindSession } = await import(
      "../main/worktrees"
    );
    const a = (await createWorktree({ repoRoot: repo, base: "main", name: "a" })).record;
    const b = (await createWorktree({ repoRoot: repo, base: "main", name: "b" })).record;
    const c = (await createWorktree({ repoRoot: repo, base: "main", name: "c" })).record;
    await bindSession(b.id, "sess-1"); // 绑定了会话的不参与自动清理

    setWorktreeSettings({ autoCleanup: true, autoCleanupLimit: 3 });
    expect(await sweepActiveBeyondLimit()).toBe(0); // 未超限
    expect(listWorktrees().filter((w) => w.status === "active")).toHaveLength(3);

    setWorktreeSettings({ autoCleanup: true, autoCleanupLimit: 2 });
    expect(await sweepActiveBeyondLimit()).toBe(1); // 移走最旧的未绑定 a
    const after = listWorktrees();
    expect(after.find((w) => w.id === a.id)?.status).toBe("trashed");
    expect(after.find((w) => w.id === b.id)?.status).toBe("active");
    expect(after.find((w) => w.id === c.id)?.status).toBe("active");

    setWorktreeSettings({ autoCleanup: true, autoCleanupLimit: 1 });
    expect(await sweepActiveBeyondLimit()).toBe(1); // 再移走 c（b 受保护）
    const final = listWorktrees();
    expect(final.find((w) => w.id === b.id)?.status).toBe("active");
    expect(final.filter((w) => w.status === "active")).toHaveLength(1);

    // 自动清理进入 trash：可恢复
    await restoreWorktree(a.id);
    expect(existsSync(a.path)).toBe(true);
  });

  test("一键移除：只清未绑定会话的 worktree", async () => {
    const { removeAllUnbound, bindSession } = await import("../main/worktrees");
    const a = (await createWorktree({ repoRoot: repo, base: "main" })).record;
    const b = (await createWorktree({ repoRoot: repo, base: "main" })).record;
    await bindSession(b.id, "sess-9");

    expect(await removeAllUnbound()).toBe(1);
    const after = listWorktrees();
    expect(after.find((w) => w.id === a.id)?.status).toBe("trashed");
    expect(after.find((w) => w.id === b.id)?.status).toBe("active");
  });
});

describe("受信仓库路径（多仓库工作区）", () => {
  test("根本身/直接子仓库放行；孙目录/无 .git 子目录/无关目录拒绝", async () => {
    const { isTrustedRepoPath } = await import("../main/trusted-repos");
    const { mkdirSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "kova-wt-roots-"));
    leftovers.push(root);
    mkdirSync(join(root, ".git")); // 根本身是仓库
    const nested = join(root, "repo-a");
    mkdirSync(join(nested, ".git"), { recursive: true });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const grandchild = join(root, "repo-b", "inner");
    mkdirSync(join(grandchild, ".git"), { recursive: true });
    const unrelated = join(tmpdir(), `kova-wt-unrelated-${Date.now()}`);
    mkdirSync(join(unrelated, ".git"), { recursive: true });
    leftovers.push(unrelated);

    expect(isTrustedRepoPath(root, [root])).toBe(true);
    expect(isTrustedRepoPath(nested, [root])).toBe(true);
    expect(isTrustedRepoPath(plain, [root])).toBe(false);
    expect(isTrustedRepoPath(grandchild, [root])).toBe(false);
    expect(isTrustedRepoPath(unrelated, [root])).toBe(false);
    expect(isTrustedRepoPath(nested, [])).toBe(false);
  });
});

describe("worktree 边缘场景", () => {
  beforeEach(() => setup());
  afterAll(teardown);

  test("删除时目录已被外部移除：仍能登记 trash 并闭环 purge", async () => {
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    rmSync(record.path, { recursive: true, force: true });
    const removed = await removeWorktree(record.id);
    expect(removed.status).toBe("trashed");
    expect(removed.trashPath).toBeUndefined();
    await purgeWorktree(record.id);
    expect(listWorktrees()).toHaveLength(0);
  });

  test("自动清理关闭时：超限也不动", async () => {
    const { setWorktreeSettings, sweepActiveBeyondLimit } = await import("../main/worktrees");
    await createWorktree({ repoRoot: repo, base: "main" });
    await createWorktree({ repoRoot: repo, base: "main" });
    setWorktreeSettings({ autoCleanup: false, autoCleanupLimit: 1 });
    expect(await sweepActiveBeyondLimit()).toBe(0);
    expect(listWorktrees().filter((w) => w.status === "active")).toHaveLength(2);
  });

  test("恢复冲突：目标路径已存在时拒绝且记录保持 trashed", async () => {
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    await removeWorktree(record.id);
    mkdirSync(record.path, { recursive: true }); // 占位目标
    let threw = false;
    try {
      await restoreWorktree(record.id);
    } catch (err) {
      threw = true;
      expect(err instanceof Error && err.message.includes("目标已存在")).toBe(true);
    }
    expect(threw).toBe(true);
    expect(listWorktrees()[0]?.status).toBe("trashed");
  });

  test("绑定会话数封顶 20（保留最新）", async () => {
    const { bindSession } = await import("../main/worktrees");
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    for (let i = 0; i < 25; i += 1) await bindSession(record.id, `s-${i}`);
    const wt = listWorktrees().find((w) => w.id === record.id);
    expect(wt?.sessionIds).toHaveLength(20);
    expect(wt?.sessionIds.at(-1)).toBe("s-24");
    expect(wt?.sessionIds.includes("s-0")).toBe(false);
  });

  test("注册表坏条目丢弃，好条目保留", async () => {
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    const regPath = join(worktreesDir, "registry.json");
    const doc = JSON.parse(readFileSync(regPath, "utf8")) as { worktrees: unknown[] };
    doc.worktrees.push({ id: "broken" });
    writeFileSync(regPath, JSON.stringify(doc), "utf8");
    resetWorktreesForTest();
    const all = listWorktrees();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(record.id);
  });

  test("并发创建：串行化且 id 不撞", async () => {
    const [a, b] = await Promise.all([
      createWorktree({ repoRoot: repo, base: "main" }),
      createWorktree({ repoRoot: repo, base: "main" }),
    ]);
    expect(a.record.id === b.record.id).toBe(false);
    expect(a.record.path === b.record.path).toBe(false);
    expect(listWorktrees().filter((w) => w.status === "active")).toHaveLength(2);
  });

  test("空仓库（无提交）：创建失败且无残留", async () => {
    const empty = initRepo();
    spawnSync("git", ["-C", empty, "update-ref", "-d", "HEAD"]);
    let threw = false;
    try {
      await createWorktree({ repoRoot: empty, base: "main" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(listWorktrees()).toHaveLength(0);
  });

  test("fetch 开关在无 remote 的仓库上不阻断创建", async () => {
    const { setWorktreeSettings } = await import("../main/worktrees");
    setWorktreeSettings({ fetchBeforeCreate: true });
    const { record, warnings } = await createWorktree({ repoRoot: repo, base: "main" });
    expect(record.status).toBe("active");
    // 无 remote 时 git fetch --all 通常成功且无输出；不要求 warnings 为空
    expect(Array.isArray(warnings)).toBe(true);
  });
});

describe("会话归档后的保护口径（对齐主流）", () => {
  beforeEach(() => setup());
  afterAll(teardown);

  test("存活会话保护；归档/删除后不再保护，可自动清理与一键移除", async () => {
    const { __setLiveSessionsForTest, setWorktreeSettings, sweepActiveBeyondLimit, removeAllUnbound, bindSession } =
      await import("../main/worktrees");
    const a = (await createWorktree({ repoRoot: repo, base: "main" })).record;
    const b = (await createWorktree({ repoRoot: repo, base: "main" })).record;
    await bindSession(a.id, "live-1");
    await bindSession(b.id, "dead-2");

    __setLiveSessionsForTest(["live-1"]); // b 的会话已归档/删除
    const list = listWorktrees();
    expect(list.find((w) => w.id === a.id)?.protected).toBe(true);
    expect(list.find((w) => w.id === b.id)?.protected).toBe(false);

    setWorktreeSettings({ autoCleanup: true, autoCleanupLimit: 1 });
    expect(await sweepActiveBeyondLimit()).toBe(1); // 只清 b（a 受保护）
    expect(listWorktrees().find((w) => w.id === a.id)?.status).toBe("active");
    expect(listWorktrees().find((w) => w.id === b.id)?.status).toBe("trashed");

    __setLiveSessionsForTest([]); // a 的会话也归档
    expect(listWorktrees().find((w) => w.id === a.id)?.protected).toBe(false);
    expect(await removeAllUnbound()).toBe(1);
    expect(listWorktrees().find((w) => w.id === a.id)?.status).toBe("trashed");
  });
});

describe("崩溃安全的孤儿目录", () => {
  beforeEach(() => setup());
  afterAll(teardown);

  test("启动清扫把未登记的 wt-* 目录移入 trash（可恢复，不静默删）", async () => {
    const orphan = join(worktreesDir, "wt-orphan123");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "leftover.txt"), "x");
    await worktreesStartupSweep();
    expect(existsSync(orphan)).toBe(false);
    const trashRoot = join(worktreesDir, ".trash");
    const moved = readdirSync(trashRoot).filter((n) => n.startsWith("orphan-wt-orphan123-"));
    expect(moved).toHaveLength(1);
    expect(existsSync(join(trashRoot, moved[0]!, "leftover.txt"))).toBe(true);
  });

  test("已登记目录不会被当作孤儿移走", async () => {
    const { record } = await createWorktree({ repoRoot: repo, base: "main" });
    await worktreesStartupSweep();
    expect(existsSync(record.path)).toBe(true);
  });
});
