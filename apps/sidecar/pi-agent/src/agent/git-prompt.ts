/**
 * Git 快照段（编程模式专属）：应用工作模式为 code（编程）且工作目录恰好受
 * git 管理时，向系统提示词追加一段会话级 git 快照——当前分支、主分支、git
 * 用户、`git status --short`、最近提交——让模型开场即知道仓库形状，省掉
 * 每轮开头的 git 勘察往返（对齐 ZCode 提示词的 gitStatus 段）。
 *
 * 生效条件（任一不满足 → 空串，compose 过滤，默认提示词字节级不变）：
 * - 工作模式 = code（work/design 面向非工程人群，注入仓库状态只会添乱）
 * - cwd 解析到 git 仓库根（非 git 项目零注入）
 * - git 可执行且采集不炸（任何异常吞掉只记日志——提示词永远比 git 信息重要）
 *
 * 缓存策略（提示词前缀缓存友好）：事实按仓库根缓存，一轮一次 spawnSync 采集，
 * 同进程后续 compose 复用——快照对整段会话稳定，系统前缀字节一致。
 * 新会话开建（handlers/sessions.new_session）清空整表：下一条会话在开局
 * 重新采集，"at the start of this conversation" 的语义因此是真的；
 * 老会话跨新建后的下一轮 compose 会换到新快照（一次前缀缓存 miss，
 * 换取信息新鲜，可接受——段首文案已明示这是快照而非实况流）。
 */
import { spawnSync } from "node:child_process";
import { logErr } from "../log";
import { getAppMode } from "./app-mode";

export type GitFacts = {
  root: string;
  /** 当前分支；detached HEAD 时为 null（改用 headShort） */
  branch: string | null;
  headShort: string | null;
  /** origin/HEAD → main → master 顺位探测，探不到为 null */
  mainBranch: string | null;
  userName: string | null;
  userEmail: string | null;
  /** git status --short 原始输出（可能为空串 = 干净）；采集失败为 null */
  statusShort: string | null;
  /** 最近提交行（`%h %s`），仓库无提交/失败为空数组 */
  recentCommits: string[];
};

/** status 段截断预算（超长工作区只留前部事实，明示截断而非静默丢） */
const STATUS_CHAR_LIMIT = 2000;
const RECENT_COMMIT_COUNT = 6;
const GIT_TIMEOUT_MS = 2000;

/** 仓库根 → 快照事实。空表=未采过；null=确认非 git/采集炸（同样不重试，
 *  直到 new_session 清表）——避免非 git 工作区每轮白跑一次 rev-parse */
const factCache = new Map<string, GitFacts | null>();

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: process.env,
    });
    const out = typeof res.stdout === "string" ? res.stdout : "";
    return { ok: res.status === 0, out: out.trimEnd() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** cwd → 仓库根；不在任何仓库内返回 null。用 rev-parse 自身解析（macOS
 *  /var→/private/var 这类符号链接由 git 归一，缓存键因此稳定） */
function resolveRepoRoot(cwd: string): string | null {
  const res = git(cwd, ["rev-parse", "--show-toplevel"]);
  return res.ok ? res.out : null;
}

function collectFacts(root: string): GitFacts | null {
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let headShort: string | null = null;
  if (!branch.ok) {
    const short = git(root, ["rev-parse", "--short", "HEAD"]);
    headShort = short.ok ? short.out : null;
    // unborn（全无提交）时两条都失败：branch/head 均 null，仍出段
    if (!headShort) return null;
  }
  let mainBranch: string | null = null;
  const originHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.ok && originHead.out.startsWith("origin/")) {
    mainBranch = originHead.out.slice("origin/".length);
  } else {
    for (const guess of ["main", "master"]) {
      if (git(root, ["rev-parse", "--verify", "--quiet", guess]).ok) {
        mainBranch = guess;
        break;
      }
    }
  }
  const name = git(root, ["config", "user.name"]);
  const email = git(root, ["config", "user.email"]);
  const status = git(root, ["status", "--short"]);
  const log = git(root, ["log", `-n${RECENT_COMMIT_COUNT}`, "--pretty=format:%h %s"]);
  return {
    root,
    branch: branch.ok ? branch.out : null,
    headShort,
    mainBranch,
    userName: name.ok && name.out ? name.out : null,
    userEmail: email.ok && email.out ? email.out : null,
    // 采集失败（null）与干净（""）区分渲染
    statusShort: status.ok ? status.out : null,
    recentCommits: log.ok && log.out ? log.out.split("\n").filter(Boolean) : [],
  };
}

function gitFacts(cwd: string): GitFacts | null {
  const root = resolveRepoRoot(cwd);
  if (!root) return null;
  if (factCache.has(root)) return factCache.get(root) ?? null;
  let facts: GitFacts | null;
  try {
    facts = collectFacts(root);
  } catch (err) {
    logErr("git-prompt: collect failed:", err);
    facts = null;
  }
  factCache.set(root, facts);
  return facts;
}

/** 快照段渲染（英文，与系统提示词主体同语言） */
export function renderGitBlock(facts: GitFacts): string {
  const lines: string[] = [
    `gitStatus: This is the git status snapshot at the start of this conversation (repo: ${facts.root}). It is a snapshot in time and will not update during the conversation — run git commands yourself when you need live state.`,
    "",
    facts.branch
      ? `Current branch: ${facts.branch}`
      : `HEAD: detached @ ${facts.headShort ?? "unborn"}`,
  ];
  if (facts.mainBranch) {
    lines.push(`Main branch (you will usually use this for PRs): ${facts.mainBranch}`);
  }
  if (facts.userName) {
    lines.push(`Git user: ${facts.userName}${facts.userEmail ? ` <${facts.userEmail}>` : ""}`);
  }
  lines.push("");
  lines.push("Status:");
  if (facts.statusShort === null) {
    lines.push("(git status unavailable)");
  } else if (!facts.statusShort) {
    lines.push("(clean)");
  } else if (facts.statusShort.length > STATUS_CHAR_LIMIT) {
    lines.push(facts.statusShort.slice(0, STATUS_CHAR_LIMIT).trimEnd());
    lines.push(
      `... (truncated because it exceeds ${STATUS_CHAR_LIMIT} characters; run git status for the rest)`,
    );
  } else {
    lines.push(facts.statusShort);
  }
  if (facts.recentCommits.length) {
    lines.push("");
    lines.push("Recent commits:");
    lines.push(...facts.recentCommits);
  }
  return lines.join("\n");
}

/** 新会话开建时调用：清空快照表，下一条会话开局重采（见头注缓存策略） */
export function invalidateGitSnapshots(): void {
  factCache.clear();
}

/** 测试辅助：清缓存 + 可选直注事实（绕开真实 git，渲染分支单测用） */
export function setFactsForTest(root: string, facts: GitFacts | null): void {
  factCache.set(root, facts);
}

export function resetGitPromptForTests(): void {
  factCache.clear();
}
