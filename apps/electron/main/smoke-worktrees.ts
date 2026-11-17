/**
 * worktree 冒烟（仅 KOVA_SMOKE_WORKTREES=1 时由 index ready 触发）：
 * 在**真实主进程**里走命令表跑完整链路——临时数据目录、嵌套仓库发现、
 * 创建（含未提交改动）、会话绑定、创建分支、列表保护态、trash/恢复/purge。
 * 全程不碰用户数据（脚本用 KOVA_DATA_DIR 指向临时目录），结束后 app.exit。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "./paths";
import { invokeCommand } from "./ipc";
import { kvSet } from "./store";
import { piRequestInternal } from "./pi-agent";

type Step = { name: string; ok: boolean; detail?: string };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await invokeCommand(name, args);
  if (!res.ok) throw new Error(res.error);
  return res.value as T;
}

function must(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

export async function runWorktreeSmoke(): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const run = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      steps.push({ name, ok: true });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  // 隔离基目录：数据目录下，脚本结束后随临时数据目录一并删除
  const base = join(appDataDir(), "smoke-worktrees");
  rmSync(base, { recursive: true, force: true });
  const repoParent = join(base, "repos");
  const repo = join(repoParent, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=smoke@t", "-c", "user.name=smoke", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
  git(repo, "add", "a.txt");
  git(repo, "-c", "user.email=smoke@t", "-c", "user.name=smoke", "commit", "-q", "-m", "a");
  writeFileSync(join(repo, "a.txt"), "v2 dirty\n");

  // 嵌套仓库工作区 + 受管根
  kvSet("workspace", repoParent);
  kvSet("worktrees.root", join(base, "worktrees"));
  const repoReal = realpathSync(repo);

  let wtId = "";
  let wtPath = "";
  let sessionId = "";

  await run("worktree_repos 发现嵌套仓库", async () => {
    const res = await call<{ repos: { path: string }[] }>("worktree_repos");
    must(res.repos.some((r) => r.path === repoReal), "repo not discovered");
  });

  await run("worktree_create（跟随未提交改动）", async () => {
    const res = await call<{
      worktree: { id: string; path: string; status: string };
    }>("worktree_create", {
      repoRoot: repo,
      base: "main",
      includeUncommitted: true,
      name: "smoke",
    });
    must(res.worktree.status === "active", "not active");
    must(existsSync(join(res.worktree.path, "a.txt")), "a.txt missing");
    must(existsSync(join(res.worktree.path, "dirty.txt")), "dirty.txt missing");
    must(existsSync(join(res.worktree.path, ".git")), "worktree .git missing");
    wtId = res.worktree.id;
    wtPath = res.worktree.path;
  });

  await run("git 工具信任（git_branches in worktree）", async () => {
    const res = await call<{ branches: unknown[] }>("git_branches", { cwd: wtPath });
    must(res.branches.length >= 1, "no branches in worktree");
  });

  await run("new_session + worktree_bind_session", async () => {
    const line = await piRequestInternal({
      payload: {
        type: "new_session",
        threadId: `smoke-${Date.now()}`,
        cwd: wtPath,
      },
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(line) as { type?: string; sessionId?: string; errorText?: string };
    if (parsed.type === "error" || !parsed.sessionId) {
      throw new Error(parsed.errorText ?? "new_session returned no sessionId");
    }
    sessionId = parsed.sessionId;
    await call("worktree_bind_session", { id: wtId, sessionId });
  });

  await run("worktree_list 保护态（存在未归档会话）", async () => {
    // 会话行由 sidecar 写入共享库，可能有毫秒级延迟：轮询最多 3s
    const deadline = Date.now() + 3_000;
    let last: { id: string; protected?: boolean; status: string } | undefined;
    for (;;) {
      const res = await call<{
        worktrees: { id: string; protected?: boolean; status: string }[];
      }>("worktree_list");
      last = res.worktrees.find((w) => w.id === wtId);
      if (last?.protected === true || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    must(last?.status === "active", "worktree not active");
    must(last?.protected === true, `expected protected=true (sessionId=${sessionId})`);
  });

  await run("worktree_branch（kova/smoke）", async () => {
    const res = await call<{ worktree: { branch?: string } }>("worktree_branch", {
      id: wtId,
      name: "smoke",
    });
    must(res.worktree.branch === "kova/smoke", `branch=${res.worktree.branch}`);
    must(git(wtPath, "rev-parse", "--abbrev-ref", "HEAD") === "kova/smoke", "HEAD not on branch");
  });

  await run("worktree_remove → restore → remove+purge", async () => {
    const removed = await call<{ worktree: { status: string } }>("worktree_remove", { id: wtId });
    must(removed.worktree.status === "trashed", "remove did not trash");
    must(!existsSync(wtPath), "directory still present after remove");
    await call("worktree_restore", { id: wtId });
    must(existsSync(join(wtPath, "a.txt")), "restore did not bring files back");
    must(git(wtPath, "rev-parse", "--is-inside-work-tree") === "true", "restored wt broken");
    await call("worktree_remove", { id: wtId });
    await call("worktree_purge", { id: wtId });
    const list = await call<{ worktrees: { id: string }[] }>("worktree_list");
    must(!list.worktrees.some((w) => w.id === wtId), "purged record still listed");
  });

  // 清场：工作区 kv 指回空，避免影响同数据目录后续使用（冒烟数据目录本身也是临时的）
  rmSync(base, { recursive: true, force: true });

  return { ok: steps.every((s) => s.ok), steps };
}
