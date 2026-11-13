"use client";

import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";

/**
 * 技能市场目录（KovaHub：search.openkova.site）的只读客户端。
 *
 * 接口由 kova-search Worker 提供，公开只读、CORS 全开，渲染进程可直连：
 *   GET /api/marketplace       目录搜索：?kind=skill &q= &category= &featured=1
 *                              &sort=hot|new|stars|name &page= &per_page=
 *   GET /api/marketplace/meta  计数 + 分类字典（分类条与计数用）
 *   GET /api/marketplace/item  单条全文：?kind=skill&id=<source_id>
 *                              （detail.skill_md.content 是完整 SKILL.md 原文）
 *
 * 这里只做取数与类型，不做缓存/去重——分页、防抖、在途竞态都由调用方
 * （skill-market.tsx）按 UI 语义处理。
 */

/** 线上目录地址；换环境时改这一处（或 localStorage 里存 kova.skillMarketApiBase 覆盖） */
export const SKILL_MARKET_API_BASE = (() => {
  if (typeof window === "undefined") return "https://search.openkova.site";
  try {
    return (
      window.localStorage.getItem("kova.skillMarketApiBase") ||
      "https://search.openkova.site"
    );
  } catch {
    return "https://search.openkova.site";
  }
})();

/** 列表条目（服务端 LIST_COLUMNS 的子集，只取 UI 用得到的字段） */
export type SkillMarketItem = {
  kind: string;
  /** 上游 source_id；取详情时的标识 */
  id: string;
  name: string;
  owner: string;
  repo: string;
  url: string;
  description_zh: string | null;
  description_en: string | null;
  categories: string[];
  logo: string | null;
  stars: number;
  favorite_count: number;
  featured: boolean;
  hosted: boolean;
  skill_id: string | null;
  variants_count: number | null;
  quality_level: string | null;
  source_updated_at: number | null;
};

export type SkillMarketCategory = {
  id: string;
  name: string;
  count: number;
  /** true = 特殊筛选（全部/精选/最火等），不是真实分类标签 */
  special: boolean;
};

export type SkillMarketMeta = {
  counts: { mcp: number; skill: number };
  categories: { mcp: SkillMarketCategory[]; skill: SkillMarketCategory[] };
  sync?: unknown;
};

export type SkillMarketSort = "hot" | "new" | "stars" | "name";

export type SkillMarketListResponse = {
  kind: string;
  query: string;
  category: string | null;
  sort: SkillMarketSort;
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  items: SkillMarketItem[];
};

/** 详情包里的上游详情（只声明用到的字段；detail 可能为 null——上游拉取失败时回落） */
export type SkillMarketDetail = {
  files?: string[];
  skill_md?: { content?: string } | null;
  skill_path?: string | null;
  token_count?: number | null;
  programming_language?: string | null;
  license?: string | null;
  topics?: string[];
};

export type SkillMarketItemResponse = SkillMarketItem & {
  raw?: unknown;
  detail: SkillMarketDetail | null;
};

export type SkillMarketListParams = {
  q?: string;
  category?: string;
  /** 「精选」特殊分类走 featured=1（其余 special id：全部=无参，真实标签=category） */
  featured?: boolean;
  sort?: SkillMarketSort;
  page?: number;
  per_page?: number;
};

/** 特殊分类的 API 参数映射：服务端 categories.special 条目不是真实标签 */
export function categoryToParams(category: SkillMarketCategory | null): {
  category?: string;
  featured?: boolean;
} {
  if (!category || category.id === "all") return {};
  if (category.id === "featured") return { featured: true };
  return { category: category.id };
}

/** 单请求默认硬超时：连接挂起时不能让加载态永远转圈（kova-search web 端同款 10 秒） */
const REQUEST_TIMEOUT_MS = 10_000;

/** RequestInit + 每调用超时覆盖（文件包这类多跳端点需要比默认更长的窗口） */
type RequestOptions = RequestInit & { timeoutMs?: number };

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  // 调用方 signal（换筛选/卸载）与超时取并集；任一触发即中断
  const timeoutMs = init?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    init?.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeout])
      : (init?.signal ?? timeout);
  let res: Response;
  try {
    res = await fetch(`${SKILL_MARKET_API_BASE}${path}`, {
      ...init,
      signal,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // 调用方没 abort 而超时信号已触发 → 归因为超时，文案可读
    if (!init?.signal?.aborted && timeout.aborted)
      throw new Error(
        t("marketplace.kovahub.error.timeout", {
          seconds: Math.round(timeoutMs / 1000),
        }),
      );
    throw err;
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      // 非 JSON 错误体：保留 HTTP 状态码
    }
    throw new Error(
      t("marketplace.kovahub.error.requestFailed", { message }),
    );
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** 目录搜索（固定 kind=skill；本组件不消费 mcp 段） */
export function fetchSkillMarketList(
  params: SkillMarketListParams,
  signal?: AbortSignal,
): Promise<SkillMarketListResponse> {
  return request<SkillMarketListResponse>(
    `/api/marketplace${qs({
      kind: "skill",
      q: params.q,
      category: params.category,
      // 服务端判断的是 featured === "1"，布尔 true 会被序列化成 "true" 而被忽略
      featured: params.featured ? 1 : undefined,
      sort: params.sort,
      page: params.page,
      per_page: params.per_page,
    })}`,
    { signal },
  );
}

/** 分类字典 + 计数（分类条数据源；sync 水位线 UI 暂不用） */
export function fetchSkillMarketMeta(signal?: AbortSignal): Promise<SkillMarketMeta> {
  return request<SkillMarketMeta>("/api/marketplace/meta", { signal });
}

/** 单条详情（含 SKILL.md 原文；失败/缺失时 detail 为 null） */
export function fetchSkillMarketItem(
  id: string,
  signal?: AbortSignal,
): Promise<SkillMarketItemResponse> {
  return request<SkillMarketItemResponse>(
    `/api/marketplace/item${qs({ kind: "skill", id })}`,
    { signal },
  );
}

/** 附属文件包（正文引用的脚本/资源；二进制与超限文件在 skipped 里说明原因） */
export type SkillMarketFileBundle = {
  kind: string;
  id: string;
  files: { path: string; content: string }[];
  skipped: { path: string; reason: string }[];
  cached?: boolean;
};

/** 取附属文件包（Worker 按 GitHub 树 + raw 直链抓取并缓存；失败时安装回落单文件）。
 *  Worker 端是 1 次树查询 + 32 个并行 raw 抓取，最坏 ~16s，给 30s 窗口。 */
export function fetchSkillMarketFiles(
  id: string,
  signal?: AbortSignal,
): Promise<SkillMarketFileBundle> {
  return request<SkillMarketFileBundle>(
    `/api/marketplace/files${qs({ kind: "skill", id })}`,
    { signal, timeoutMs: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// 本机安装记录：市场「已安装」徽标的事实源（按 source_id 精确匹配，不靠名字猜）
//
// 记录只存在本机 localStorage（不随账号/工作区同步，清站点数据即丢）；
// 判定「已安装」时还要求本地仍存在同名技能——用户在设置页删掉后徽标自然消失。
// 丢记录的代价只是徽标消失、按钮回到「安装」，同名覆盖确认仍会兜底。
// ---------------------------------------------------------------------------

export type SkillMarketInstallRecord = {
  /** 安装落盘的技能名（与本地清单比对存在性） */
  name: string;
  scope: "system" | "workspace" | "compat";
  installedAt: number;
};

const INSTALLED_RECORDS_KEY = "kova.skillMarket.installed";
const EMPTY_RECORDS: Record<string, SkillMarketInstallRecord> = {};

function loadInstalledRecords(): Record<string, SkillMarketInstallRecord> {
  if (typeof window === "undefined") return EMPTY_RECORDS;
  try {
    const raw = window.localStorage.getItem(INSTALLED_RECORDS_KEY);
    if (!raw) return EMPTY_RECORDS;
    const parsed = JSON.parse(raw) as Record<string, SkillMarketInstallRecord>;
    return parsed && typeof parsed === "object" ? parsed : EMPTY_RECORDS;
  } catch {
    return EMPTY_RECORDS;
  }
}

let installedRecords: Record<string, SkillMarketInstallRecord> =
  loadInstalledRecords();
const installedListeners = new Set<() => void>();

function emitInstalled() {
  for (const listener of installedListeners) listener();
}

/** 安装成功后登记 source_id（本会话即时生效，并尽力持久化） */
export function recordSkillMarketInstall(
  sourceId: string,
  name: string,
  scope: "system" | "workspace" | "compat",
): void {
  installedRecords = {
    ...installedRecords,
    [sourceId]: { name, scope, installedAt: Date.now() },
  };
  try {
    window.localStorage.setItem(
      INSTALLED_RECORDS_KEY,
      JSON.stringify(installedRecords),
    );
  } catch {
    // 隐私模式/配额满：持久化不可用，记录仅本会话生效
  }
  emitInstalled();
}

/** 订阅本机安装记录（安装成功后卡片徽标即时回流） */
export function useSkillMarketInstallRecords(): Record<
  string,
  SkillMarketInstallRecord
> {
  return useSyncExternalStore(
    (listener) => {
      installedListeners.add(listener);
      return () => installedListeners.delete(listener);
    },
    () => installedRecords,
    () => EMPTY_RECORDS,
  );
}
