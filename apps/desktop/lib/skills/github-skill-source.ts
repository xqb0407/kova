"use client";

/**
 * GitHub 技能源：从精选的公开仓库里发现 SKILL.md。
 *
 * 相比第三方聚合站，这里只做「按仓库取目录、按需回源取正文」：
 *   - 仓库列表 = 内置精选（厂商官方仓库）+ 用户手动添加的 owner/repo；
 *   - 用 GitHub Trees API 找出各目录下的 SKILL.md（每个仓库 1 次树请求，10 分钟缓存）；
 *   - 正文走 raw.githubusercontent.com，按 commit SHA 固定版本，安装时才回源；
 *   - 许可证取自仓库元数据，缺失时明确提示「未声明」。
 *
 * 不镜像整库、不批量下载仓库内容、不转存第三方 logo；缓存只在本会话内存里。
 */

import { useSyncExternalStore } from "react";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
/** GitHub 接口限流时的只读取数回退：jsDelivr 按需读取公开仓库，不落盘 */
const JSDELIVR_API = "https://data.jsdelivr.com/v1/packages/gh";
const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";
const USER_REPOS_KEY = "kova.githubSkillRepos";
const INSTALLED_KEY = "kova.githubSkillInstalled";
const REPO_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** 根目录下这些名字通常是模板/示例，不当技能展示 */
const IGNORED_ROOT_DIRS = new Set([
  "template",
  "templates",
  "example",
  "examples",
  "sample",
  "samples",
]);

export type GithubSkillRepo = {
  owner: string;
  repo: string;
  /** 展示名（默认 owner/repo；用户添加的用 GitHub 规范化全名） */
  label: string;
  addedByUser?: boolean;
};

/** 内置精选：只放厂商官方、长期维护的技能仓库 */
export const CURATED_SKILL_REPOS: GithubSkillRepo[] = [
  { owner: "anthropics", repo: "skills", label: "Anthropic 官方技能" },
  { owner: "vercel-labs", repo: "agent-skills", label: "Vercel 官方技能" },
];

export type GithubSkill = {
  /** `${owner}/${repo}:${path}`：跨 commit 稳定，安装记录按它匹配 */
  id: string;
  owner: string;
  repo: string;
  repoLabel: string;
  /** 仓库内路径，如 skills/docx/SKILL.md */
  path: string;
  /** SKILL.md 所在目录；根目录技能为空串 */
  dir: string;
  /** 展示名：hydrate 前是目录名，hydrate 后换成 frontmatter name */
  name: string;
  description: string;
  /** 仓库许可证（SPDX id）；未声明为 null */
  license: string | null;
  /** 仓库元数据是否成功读取；false = 限流/网络失败，许可证只能标「未知」 */
  metaLoaded: boolean;
  stars: number;
  repoUrl: string;
  /** 固定到 commit / 分支的源文件链接 */
  htmlUrl: string;
  /** 正文来源版本锚点（GitHub commit SHA，或 jsDelivr 回退时的分支名） */
  commitSha: string;
  /** 正文来源前缀（GitHub raw 或 jsDelivr 回退），不含 path */
  contentBaseUrl: string;
  /** 同目录下 SKILL.md 之外的附属文件数（本市场不打包它们） */
  extraFiles: number;
};

export type GithubSkillCatalog = {
  skills: GithubSkill[];
  errors: { repo: string; message: string }[];
};

export type SkillFrontmatter = {
  name: string | null;
  description: string | null;
};

type GithubRepoMeta = {
  full_name?: string;
  default_branch?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  license?: { spdx_id?: string | null; name?: string | null } | null;
};

type GithubRef = { object?: { sha?: string } };
type GithubTreeEntry = { path?: string; type?: string; sha?: string };
type GithubTree = { tree?: GithubTreeEntry[]; truncated?: boolean };

type RepoCacheEntry = {
  at: number;
  commitSha: string;
  skills: GithubSkill[];
};

const repoCache = new Map<string, RepoCacheEntry>();
const contentCache = new Map<string, string>();

function repoKey(repo: GithubSkillRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

async function githubRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      signal: merged,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error(
        `GitHub 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）`,
      );
    throw err;
  }
  if (!res.ok) {
    // 403 + 限流头是最常见的失败：给出可操作的文案，而不是裸 HTTP 状态
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        remaining === "0" || res.status === 429
          ? "GitHub 接口触发限流（未登录每分钟 60 次），请稍后再试"
          : `GitHub 拒绝访问（HTTP ${res.status}）`,
      );
    }
    throw new Error(`GitHub 请求失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

type JsDelivrFile = { name?: string };
type JsDelivrFiles = { files?: JsDelivrFile[] };

async function jsdelivrRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(`${JSDELIVR_API}${path}`, {
      signal: merged,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error("jsDelivr 请求超时，请检查网络后重试");
    throw err;
  }
  if (!res.ok) throw new Error(`jsDelivr 请求失败（HTTP ${res.status}）`);
  return (await res.json()) as T;
}

/** GitHub 限流时不阻塞市场：依次尝试 main / master 读仓库文件列表 */
async function fetchJsdelivrFiles(
  repo: GithubSkillRepo,
  signal?: AbortSignal,
): Promise<{ ref: string; paths: string[] }> {
  for (const ref of ["main", "master"]) {
    try {
      const res = await jsdelivrRequest<JsDelivrFiles>(
        `/${repo.owner}/${repo.repo}@${ref}?structure=flat`,
        signal,
      );
      const paths = (res.files ?? [])
        .map((file) => (file.name ?? "").replace(/^\/+/, ""))
        .filter(Boolean);
      if (paths.length > 0) return { ref, paths };
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  throw new Error("jsDelivr 也未能读取该仓库（main/master 均不可用）");
}

function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

// ---------------------------------------------------------------------------
// 用户添加的仓库（仅本地保存仓库地址，不存内容）
// ---------------------------------------------------------------------------

function readUserRepos(): GithubSkillRepo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_REPOS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const repos: GithubSkillRepo[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Partial<GithubSkillRepo>;
      if (typeof rec.owner !== "string" || typeof rec.repo !== "string")
        continue;
      repos.push({
        owner: rec.owner,
        repo: rec.repo,
        label:
          typeof rec.label === "string" ? rec.label : `${rec.owner}/${rec.repo}`,
        addedByUser: true,
      });
    }
    return repos;
  } catch {
    return [];
  }
}

let userRepos: GithubSkillRepo[] = readUserRepos();

function persistUserRepos(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      USER_REPOS_KEY,
      JSON.stringify(
        userRepos.map(({ owner, repo, label }) => ({ owner, repo, label })),
      ),
    );
  } catch {
    // 隐私模式/配额满：本次会话仍可用，只是不持久化
  }
}

export function getUserSkillRepos(): GithubSkillRepo[] {
  return userRepos;
}

/** 内置精选 + 用户添加（去重） */
export function getAllSkillRepos(): GithubSkillRepo[] {
  const seen = new Set<string>();
  const out: GithubSkillRepo[] = [];
  for (const repo of [...CURATED_SKILL_REPOS, ...userRepos]) {
    const key = repoKey(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/** 校验并添加一个 owner/repo（或 GitHub 链接）；失败抛出可读错误 */
export async function addUserSkillRepo(
  input: string,
  signal?: AbortSignal,
): Promise<GithubSkillRepo> {
  const parsed = parseRepoInput(input);
  if (!parsed) throw new Error("请填写 owner/repo，例如 anthropics/skills");
  const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  if (getAllSkillRepos().some((r) => repoKey(r).toLowerCase() === key))
    throw new Error("该仓库已在列表中");
  let fullName = `${parsed.owner}/${parsed.repo}`;
  try {
    const meta = await githubRequest<GithubRepoMeta>(
      `/repos/${parsed.owner}/${parsed.repo}`,
      signal,
    );
    fullName = meta.full_name ?? fullName;
  } catch (err) {
    if (signal?.aborted) throw err;
    // GitHub 限流时用 jsDelivr 验证仓库确实可读；仍失败则保留 GitHub 的原始错误
    try {
      await fetchJsdelivrFiles({ ...parsed, label: fullName }, signal);
    } catch {
      throw err;
    }
  }
  const repo: GithubSkillRepo = {
    owner: parsed.owner,
    repo: parsed.repo,
    label: fullName,
    addedByUser: true,
  };
  userRepos = [...userRepos, repo];
  persistUserRepos();
  repoCache.delete(repoKey(repo));
  return repo;
}

export function removeUserSkillRepo(fullName: string): void {
  userRepos = userRepos.filter(
    (r) => `${r.owner}/${r.repo}`.toLowerCase() !== fullName.toLowerCase(),
  );
  persistUserRepos();
}

// ---------------------------------------------------------------------------
// 目录发现
// ---------------------------------------------------------------------------

type SkillPath = { path: string; dir: string; extraFiles: number };

function toSkillPaths(allPaths: string[]): SkillPath[] {
  const out: SkillPath[] = [];
  for (const path of allPaths) {
    if (!/(^|\/)SKILL\.md$/.test(path)) continue;
    const dir = path.replace(/\/?SKILL\.md$/, "");
    const rootSegment = dir.split("/")[0]?.toLowerCase() ?? "";
    if (rootSegment && IGNORED_ROOT_DIRS.has(rootSegment)) continue;
    let extraFiles = 0;
    if (dir) {
      const prefix = `${dir}/`;
      for (const other of allPaths) {
        if (!other.startsWith(prefix)) continue;
        if (other === `${dir}/SKILL.md`) continue;
        extraFiles += 1;
      }
    }
    out.push({ path, dir, extraFiles });
  }
  return out;
}

function buildSkills(
  repo: GithubSkillRepo,
  paths: SkillPath[],
  opts: {
    meta: GithubRepoMeta | null;
    ref: string;
    contentBaseUrl: string;
  },
): GithubSkill[] {
  const { meta, ref, contentBaseUrl } = opts;
  const licenseRaw = meta?.license?.spdx_id ?? meta?.license?.name ?? null;
  const license =
    licenseRaw && licenseRaw !== "NOASSERTION" ? licenseRaw : null;
  const repoUrl =
    meta?.html_url ?? `https://github.com/${repo.owner}/${repo.repo}`;

  const skills: GithubSkill[] = paths.map(({ path, dir, extraFiles }) => ({
    id: `${repo.owner}/${repo.repo}:${path}`,
    owner: repo.owner,
    repo: repo.repo,
    repoLabel: repo.label,
    path,
    dir,
    name: dir ? dir.split("/").pop()! : repo.repo,
    description: "",
    license,
    metaLoaded: Boolean(meta),
    stars: meta?.stargazers_count ?? 0,
    repoUrl,
    htmlUrl: `${repoUrl}/blob/${ref}/${path}`,
    commitSha: ref,
    contentBaseUrl,
    extraFiles,
  }));

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function fetchRepoSkills(
  repo: GithubSkillRepo,
  signal?: AbortSignal,
  force = false,
): Promise<GithubSkill[]> {
  const key = repoKey(repo);
  const cached = repoCache.get(key);
  if (!force && cached && Date.now() - cached.at < REPO_TTL_MS)
    return cached.skills;

  let meta: GithubRepoMeta | null = null;
  try {
    meta = await githubRequest<GithubRepoMeta>(
      `/repos/${repo.owner}/${repo.repo}`,
      signal,
    );
    const branch = meta.default_branch || "main";
    // 取分支最新 commit 作版本锚点；失败时退回分支名（raw 仍可用）
    const ref = await githubRequest<GithubRef>(
      `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${branch}`,
      signal,
    ).catch(() => null);
    const commitSha = ref?.object?.sha ?? branch;
    const treeRes = await githubRequest<GithubTree>(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${commitSha}?recursive=1`,
      signal,
    );
    const allPaths = (treeRes.tree ?? [])
      .filter((entry) => entry.type === "blob" && entry.path)
      .map((entry) => entry.path!);
    const skills = buildSkills(repo, toSkillPaths(allPaths), {
      meta,
      ref: commitSha,
      contentBaseUrl: `${RAW_BASE}/${repo.owner}/${repo.repo}/${commitSha}`,
    });
    repoCache.set(key, { at: Date.now(), commitSha, skills });
    return skills;
  } catch (err) {
    if (signal?.aborted) throw err;
    // GitHub 接口限流/不可用时改用 jsDelivr 只读取数；许可证等元数据尽力而为
    const { ref, paths } = await fetchJsdelivrFiles(repo, signal);
    const skills = buildSkills(repo, toSkillPaths(paths), {
      meta,
      ref,
      contentBaseUrl: `${JSDELIVR_CDN}/${repo.owner}/${repo.repo}@${ref}`,
    });
    repoCache.set(key, { at: Date.now(), commitSha: ref, skills });
    return skills;
  }
}

/** 并行读取所有仓库的 SKILL.md 路径；单仓库失败只记录，不拖垮整页 */
export async function fetchSkillCatalog(
  repos: GithubSkillRepo[],
  signal?: AbortSignal,
  force = false,
): Promise<GithubSkillCatalog> {
  type RepoResult = {
    repo: GithubSkillRepo;
    skills: GithubSkill[];
    error?: string;
  };
  const results: RepoResult[] = await Promise.all(
    repos.map(async (repo): Promise<RepoResult> => {
      try {
        return { repo, skills: await fetchRepoSkills(repo, signal, force) };
      } catch (err) {
        if (signal?.aborted) return { repo, skills: [] };
        return {
          repo,
          skills: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const skills = results.flatMap((r) => r.skills);
  const errors = results
    .filter((r) => r.error)
    .map((r) => ({
      repo: `${r.repo.owner}/${r.repo.repo}`,
      message: r.error ?? "",
    }));
  return { skills, errors };
}

/** 回源取 SKILL.md 原文（按 commit SHA 固定；会话内缓存，不落盘） */
export async function fetchSkillMarkdown(
  skill: GithubSkill,
  signal?: AbortSignal,
): Promise<string> {
  const base =
    skill.contentBaseUrl ||
    `${RAW_BASE}/${skill.owner}/${skill.repo}/${skill.commitSha}`;
  const key = `${base}:${skill.path}`;
  const cached = contentCache.get(key);
  if (cached !== undefined) return cached;

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  const encodedPath = skill.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  let res: Response;
  try {
    res = await fetch(`${base}/${encodedPath}`, { signal: merged });
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error("获取 SKILL.md 超时，请检查网络后重试");
    throw err;
  }
  if (!res.ok) throw new Error(`获取 SKILL.md 失败（HTTP ${res.status}）`);
  const text = await res.text();
  contentCache.set(key, text);
  return text;
}

// ---------------------------------------------------------------------------
// frontmatter 解析（只取 name / description；装盘仍由 sidecar 解析原文）
// ---------------------------------------------------------------------------

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .trim();
  }
  return trimmed;
}

export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  if (!block) return { name: null, description: null };
  const lines = block.split(/\r?\n/);
  const fields: Record<string, string> = {};

  let i = 0;
  while (i < lines.length) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1]!;
    let value = match[2] ?? "";
    const trimmed = value.trim();
    i += 1;

    // 折叠块（| / >）：收集后续缩进行
    if (/^[|>][+-]?$/.test(trimmed)) {
      const collected: string[] = [];
      while (
        i < lines.length &&
        (/^\s+/.test(lines[i]!) || lines[i]!.trim() === "")
      ) {
        collected.push(lines[i]!);
        i += 1;
      }
      value = collected
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    } else if (trimmed.startsWith('"') && !trimmed.endsWith('"')) {
      // 跨行引号字符串：一直拼到收尾引号
      let buffer = value;
      while (i < lines.length) {
        const line = lines[i]!;
        i += 1;
        buffer += ` ${line.trim()}`;
        if (/"[ \t]*$/.test(buffer)) break;
      }
      value = buffer;
    }
    fields[key] = unquote(value);
  }

  const name = fields.name?.trim() || null;
  const description = fields.description?.trim() || null;
  return { name, description };
}

// ---------------------------------------------------------------------------
// 本机安装记录（市场「已安装」徽标的事实源）
// ---------------------------------------------------------------------------

export type GithubSkillInstallRecord = {
  /** 安装落盘的技能名（与本地清单比对存在性） */
  name: string;
  scope: "system" | "workspace";
  installedAt: number;
};

const EMPTY_RECORDS: Record<string, GithubSkillInstallRecord> = {};

function loadInstallRecords(): Record<string, GithubSkillInstallRecord> {
  if (typeof window === "undefined") return EMPTY_RECORDS;
  try {
    const raw = window.localStorage.getItem(INSTALLED_KEY);
    if (!raw) return EMPTY_RECORDS;
    const parsed = JSON.parse(raw) as Record<string, GithubSkillInstallRecord>;
    return parsed && typeof parsed === "object" ? parsed : EMPTY_RECORDS;
  } catch {
    return EMPTY_RECORDS;
  }
}

let installRecords = loadInstallRecords();
const installListeners = new Set<() => void>();

export function recordGithubSkillInstall(
  skillId: string,
  name: string,
  scope: "system" | "workspace",
): void {
  installRecords = {
    ...installRecords,
    [skillId]: { name, scope, installedAt: Date.now() },
  };
  try {
    window.localStorage.setItem(INSTALLED_KEY, JSON.stringify(installRecords));
  } catch {
    // 持久化不可用：记录仅本会话生效
  }
  for (const listener of installListeners) listener();
}

export function useGithubSkillInstalls(): Record<
  string,
  GithubSkillInstallRecord
> {
  const subscribe = (listener: () => void) => {
    installListeners.add(listener);
    return () => installListeners.delete(listener);
  };
  return useSyncExternalStore(
    subscribe,
    () => installRecords,
    () => EMPTY_RECORDS,
  );
}
