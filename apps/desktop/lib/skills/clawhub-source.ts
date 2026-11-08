"use client";

import { t } from "@/lib/i18n";

/**
 * ClawHub 技能源：OpenClaw 官方技能注册表的公开只读接口。
 *
 * 与 GitHub 精选仓库的区别：
 *   - 目录是服务端分页/检索的，不用逐仓库拉树，也不会撞 GitHub 的 60 次/小时限流；
 *   - 官方文档明确允许第三方目录复用公开读接口，全部技能按 MIT-0 发布；
 *   - 列表自带下载量/星标/版本，卡片无需二次回源取描述；
 *   - 正文仍按需读取：/skills/{slug}/file?path=SKILL.md&owner=...
 *
 * 注意：slug 不全局唯一（多个 owner 可能有同名技能），所有详情与文件请求
 * 都必须带 owner，否则接口返回 409 AMBIGUOUS_SKILL_SLUG。
 */

const CLAWHUB_BASE = "https://clawhub.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 30;
const SEARCH_LIMIT = 40;
const CACHE_TTL_MS = 10 * 60 * 1000;

export type ClawhubSort = "downloads" | "stars" | "createdAt" | "trending" | "recommended";

export type ClawhubSkill = {
  /** `${owner}/${slug}`，跨版本稳定，安装记录按它匹配 */
  id: string;
  owner: string;
  slug: string;
  name: string;
  summary: string;
  /** 最新版本号；搜索接口不返回时为空 */
  version: string | null;
  /**
   * 技能图标：可能是 https 图片，也可能是 `lucide:Brain` 这样的 lucide 图标名。
   * 列表接口不带图标，需要详情接口补齐（见 fetchClawhubSkillIcon）。
   */
  icon: string | null;
  downloads: number;
  installs: number;
  stars: number;
  versionCount: number;
  topics: string[];
  updatedAt: number | null;
  /** 官方列表页，用于回链来源 */
  pageUrl: string;
  /** ClawHub 全部技能统一 MIT-0 */
  license: "MIT-0";
};

type RawStats = {
  downloads?: number;
  installs?: number;
  stars?: number;
  versions?: number;
};

type RawSkill = {
  ownerHandle?: string;
  slug?: string;
  displayName?: string;
  summary?: string | null;
  description?: string | null;
  icon?: string | null;
  topics?: string[] | string | null;
  stats?: RawStats;
  latestVersion?: { version?: string } | null;
  updatedAt?: number;
  metrics?: { updatedAt?: number };
  canonicalUrl?: string;
  native?: {
    skill?: {
      displayName?: string;
      summary?: string | null;
      topics?: string[] | string | null;
      stats?: RawStats;
    };
  };
};

type SkillListResponse = {
  items?: RawSkill[];
  nextCursor?: string | null;
};

type SkillSearchResponse = {
  results?: RawSkill[];
};

type CacheEntry = {
  at: number;
  skills: ClawhubSkill[];
  nextCursor: string | null;
};

const listCache = new Map<string, CacheEntry>();

function normalizeTopics(value: RawSkill["topics"]): string[] {
  if (Array.isArray(value)) {
    return value.filter((topic): topic is string => typeof topic === "string");
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function normalizeSkill(raw: RawSkill): ClawhubSkill | null {
  const owner = raw.ownerHandle?.trim();
  const slug = raw.slug?.trim();
  if (!owner || !slug) return null;
  const stats = raw.stats ?? raw.native?.skill?.stats ?? {};
  const summary = (raw.summary ?? raw.native?.skill?.summary ?? raw.description ?? "").trim();
  const version = raw.latestVersion?.version?.trim() || null;
  return {
    id: `${owner}/${slug}`,
    owner,
    slug,
    name: (raw.displayName ?? raw.native?.skill?.displayName ?? slug).trim(),
    summary,
    version,
    icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : null,
    downloads: stats.downloads ?? 0,
    installs: stats.installs ?? 0,
    stars: stats.stars ?? 0,
    versionCount: stats.versions ?? 0,
    topics: normalizeTopics(raw.topics ?? raw.native?.skill?.topics),
    updatedAt:
      typeof raw.updatedAt === "number"
        ? raw.updatedAt
        : typeof raw.metrics?.updatedAt === "number"
          ? raw.metrics.updatedAt
          : null,
    pageUrl: raw.canonicalUrl
      ? `${CLAWHUB_BASE}${raw.canonicalUrl}`
      : `${CLAWHUB_BASE}/${owner}/skills/${slug}`,
    license: "MIT-0",
  };
}

async function clawhubRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(`${CLAWHUB_BASE}${path}`, {
      signal: merged,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error(
        t("marketplace.clawhub.error.timeout", {
          seconds: Math.round(REQUEST_TIMEOUT_MS / 1000),
        }),
      );
    throw err;
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(
      retry
        ? t("marketplace.clawhub.error.rateLimitRetry", { retry })
        : t("marketplace.clawhub.error.rateLimit"),
    );
  }
  if (!res.ok)
    throw new Error(
      t("marketplace.clawhub.error.requestFailed", { status: res.status }),
    );
  return (await res.json()) as T;
}

/** 浏览目录（按下载/星标/最新/推荐排序），游标分页 */
export async function fetchClawhubSkills(options: {
  sort?: ClawhubSort;
  cursor?: string | null;
  signal?: AbortSignal;
  /** true = 跳过 10 分钟缓存 */
  force?: boolean;
}): Promise<{ skills: ClawhubSkill[]; nextCursor: string | null }> {
  const sort = options.sort ?? "downloads";
  const cursor = options.cursor ?? null;
  const key = `${sort}:${cursor ?? ""}`;
  const cached = listCache.get(key);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { skills: cached.skills, nextCursor: cached.nextCursor };
  }
  const params = new URLSearchParams({ limit: String(LIST_LIMIT), sort });
  if (cursor) params.set("cursor", cursor);
  const data = await clawhubRequest<SkillListResponse>(
    `/api/v1/skills?${params.toString()}`,
    options.signal,
  );
  const skills = (data.items ?? [])
    .map(normalizeSkill)
    .filter((skill): skill is ClawhubSkill => skill !== null);
  const nextCursor = data.nextCursor ?? null;
  listCache.set(key, { at: Date.now(), skills, nextCursor });
  return { skills, nextCursor };
}

/** 全文检索。搜索接口不分页，一次最多 40 条 */
export async function searchClawhubSkills(
  query: string,
  signal?: AbortSignal,
): Promise<ClawhubSkill[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(SEARCH_LIMIT),
    nonSuspiciousOnly: "true",
  });
  const data = await clawhubRequest<SkillSearchResponse>(
    `/api/v1/search?${params.toString()}`,
    signal,
  );
  return (data.results ?? [])
    .map(normalizeSkill)
    .filter((skill): skill is ClawhubSkill => skill !== null);
}

/** 详情接口只为了补图标：图标很少变，缓存 24 小时 */
const ICON_TTL_MS = 24 * 60 * 60 * 1000;

type SkillDetailResponse = { skill?: { icon?: string | null } };

const iconCache = new Map<string, { at: number; icon: string | null }>();

/** 列表接口不返回图标，详情接口才有；按 owner/slug 缓存，避免翻页重复请求 */
export async function fetchClawhubSkillIcon(
  owner: string,
  slug: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = `${owner}/${slug}`;
  const cached = iconCache.get(key);
  if (cached && Date.now() - cached.at < ICON_TTL_MS) return cached.icon;
  const params = new URLSearchParams({ owner });
  const data = await clawhubRequest<SkillDetailResponse>(
    `/api/v1/skills/${encodeURIComponent(slug)}?${params.toString()}`,
    signal,
  );
  const icon =
    typeof data.skill?.icon === "string" && data.skill.icon.trim()
      ? data.skill.icon.trim()
      : null;
  iconCache.set(key, { at: Date.now(), icon });
  return icon;
}

/** 读取技能正文（SKILL.md 原文，frontmatter 由 saveSkill 侧解析） */
export async function fetchClawhubSkillMarkdown(
  skill: Pick<ClawhubSkill, "owner" | "slug">,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
  const params = new URLSearchParams({ path: "SKILL.md", owner: skill.owner });
  let res: Response;
  try {
    res = await fetch(
      `${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(skill.slug)}/file?${params.toString()}`,
      {
        signal: merged,
        headers: { Accept: "text/plain" },
      },
    );
  } catch (err) {
    if (!signal?.aborted && timeout.aborted)
      throw new Error(
        t("marketplace.clawhub.error.markdownTimeout", {
          seconds: Math.round(REQUEST_TIMEOUT_MS / 1000),
        }),
      );
    throw err;
  }
  if (!res.ok) {
    if (res.status === 404)
      throw new Error(t("marketplace.clawhub.error.noSkillMd"));
    throw new Error(
      t("marketplace.clawhub.error.markdownFailed", { status: res.status }),
    );
  }
  // 接口在错误场景下返回 text/plain 的错误文案，成功时是 Markdown 原文
  return await res.text();
}
