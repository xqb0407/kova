"use client";

/**
 * GitHub 技能源：从精选的公开仓库里发现 SKILL.md。
 *
 * 相比第三方聚合站，这里只做「按仓库取目录、按需回源取正文」：
 *   - 仓库列表 = 内置精选仓库；
 *   - 用 GitHub Trees API 找出各目录下的 SKILL.md（每个仓库 1 次树请求，10 分钟缓存）；
 *   - 正文走 raw.githubusercontent.com，按 commit SHA 固定版本，安装时才回源；
 *   - 许可证取自仓库元数据，缺失时明确提示「未声明」。
 *
 * 不镜像整库、不批量下载仓库内容、不转存第三方 logo；缓存只在本会话内存里。
 */

import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
/** GitHub 接口限流时的只读取数回退：jsDelivr 按需读取公开仓库，不落盘 */
const JSDELIVR_API = "https://data.jsdelivr.com/v1/packages/gh";
const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";
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
  /** 展示名的词典 key；缺失时直接展示 label */
  labelKey?: string;
};

/** 内置精选：厂商官方仓库 + 高口碑长期维护的技能仓库 */
export const CURATED_SKILL_REPOS: GithubSkillRepo[] = [
  {
    owner: "anthropics",
    repo: "skills",
    label: "Anthropic 官方技能",
    labelKey: "marketplace.github.sourceLabels.anthropic",
  },
  {
    owner: "openai",
    repo: "skills",
    label: "OpenAI 官方技能",
    labelKey: "marketplace.github.sourceLabels.openai",
  },
  {
    owner: "vercel-labs",
    repo: "agent-skills",
    label: "Vercel 官方技能",
    labelKey: "marketplace.github.sourceLabels.vercel",
  },
  {
    owner: "cloudflare",
    repo: "skills",
    label: "Cloudflare 官方技能",
    labelKey: "marketplace.github.sourceLabels.cloudflare",
  },
  {
    owner: "supabase",
    repo: "agent-skills",
    label: "Supabase 官方技能",
    labelKey: "marketplace.github.sourceLabels.supabase",
  },
  {
    owner: "prisma",
    repo: "skills",
    label: "Prisma 官方技能",
    labelKey: "marketplace.github.sourceLabels.prisma",
  },
  {
    owner: "obra",
    repo: "superpowers",
    label: "Superpowers 社区精选",
    labelKey: "marketplace.github.sourceLabels.superpowers",
  },
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
        t("marketplace.github.error.timeout", {
          seconds: Math.round(REQUEST_TIMEOUT_MS / 1000),
        }),
      );
    throw err;
  }
  if (!res.ok) {
    // 403 + 限流头是最常见的失败：给出可操作的文案，而不是裸 HTTP 状态
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        remaining === "0" || res.status === 429
          ? t("marketplace.github.error.rateLimit")
          : t("marketplace.github.error.forbidden", { status: res.status }),
      );
    }
    throw new Error(
      t("marketplace.github.error.requestFailed", { status: res.status }),
    );
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
      throw new Error(t("marketplace.github.error.jsdelivrTimeout"));
    throw err;
  }
  if (!res.ok)
    throw new Error(
      t("marketplace.github.error.jsdelivrFailed", { status: res.status }),
    );
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
  throw new Error(t("marketplace.github.error.jsdelivrUnavailable"));
}

/** 市场仓库列表：固定为内置精选 */
export function getAllSkillRepos(): GithubSkillRepo[] {
  return CURATED_SKILL_REPOS;
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
    const segments = dir.split("/");
    const rootSegment = segments[0]?.toLowerCase() ?? "";
    if (rootSegment && IGNORED_ROOT_DIRS.has(rootSegment)) continue;
    // .system 是各家 Agent 自带的内部技能，不面向市场展示
    if (segments.includes(".system")) continue;
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
      throw new Error(t("marketplace.github.error.markdownTimeout"));
    throw err;
  }
  if (!res.ok)
    throw new Error(
      t("marketplace.github.error.markdownFailed", { status: res.status }),
    );
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
  scope: "system" | "workspace" | "compat";
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
  scope: "system" | "workspace" | "compat",
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
