/**
 * 项目外观（侧边栏「项目」分组头的身份标记）：内置吉祥物 + 内置头像 +
 * 项目主色 + 自传图片。
 *
 * - 「吉祥物」12 个矢量图标（现成线稿，任何尺寸都干净）；
 * - 「头像」24 张 DiceBear Gaze 预设 + `dicebear:…` 随机头像（运行时生成，
 *   覆盖 @dicebear/styles 全部 61 种风格，CC0 1.0）；
 * - 「颜色」给吉祥物/默认文件夹图标上色；内置头像与上传图片使用自身配色；
 * - 支持用户上传图片（自动缩到 64×64 存本地）。
 * 吉祥物与内置头像互斥；上传图片在展示上盖过两者（移除图片后恢复）。
 *
 * 本模块只管数据与存储（无 UI 依赖，便于单测）；头像清单见
 * lib/projects/project-avatars.ts，渲染见 components/ui/project-badge.tsx，
 * 设置界面见 components/agent-thread/project-settings-popover.tsx。
 *
 * 存储按项目工作目录（cwd）落 localStorage；与面板标签/开合偏好同款纪律：
 * 模块级 store + useSyncExternalStore（只让 primitive 参与订阅）。
 */
import { useSyncExternalStore } from "react";
import { isProjectAvatarId } from "./project-avatars";

/** 内置吉祥物条目：id 给存储，label 给界面；矢量图标映射在 UI 层 */
export type ProjectMascotGlyph = {
  id: string;
  label: string;
};

/** 12 个内置吉祥物（猫/兔/鸟/鱼/蜗牛/松鼠/虫/龟 + 樱桃/甜甜圈/披萨/咖啡） */
export const PROJECT_MASCOT_GLYPHS: readonly ProjectMascotGlyph[] = [
  { id: "cat", label: "猫" },
  { id: "rabbit", label: "兔" },
  { id: "bird", label: "鸟" },
  { id: "fish", label: "鱼" },
  { id: "snail", label: "蜗牛" },
  { id: "squirrel", label: "松鼠" },
  { id: "bug", label: "虫" },
  { id: "turtle", label: "龟" },
  { id: "cherry", label: "樱桃" },
  { id: "donut", label: "甜甜圈" },
  { id: "pizza", label: "披萨" },
  { id: "bot", label: "机器人" },
] as const;

const GLYPH_IDS = new Set(PROJECT_MASCOT_GLYPHS.map((g) => g.id));

export function isProjectGlyphId(value: unknown): value is string {
  return typeof value === "string" && GLYPH_IDS.has(value);
}

/** 项目主色预设（6 位 hex：徽章底色取其 13% 透明度，深浅主题都成立） */
export const PROJECT_MASCOT_COLORS: readonly string[] = [
  "#64748b",
  "#3b82f6",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#8b5cf6",
  "#ec4899",
] as const;

const COLOR_RE = /^#[0-9a-f]{6}$/iu;

/** 主色：预设 swatch 或自定义取色器给出的 6 位 hex。
 *  收紧到 hex 是为了直接安全地拼进 `style`（徽章底色取 `${color}22`） */
export function isProjectColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_RE.test(value);
}

/** 外观字段（吉祥物 / 内置头像 / 主色 / 图片）；空对象 = 未设置（回退文件夹图标） */
export type ProjectAppearance = {
  /** 内置吉祥物（矢量图标）id；缺省 = 不用 */
  glyph?: string;
  /** 头像 id：Gaze 预设 id 或 `dicebear:<style>:<bg>:<seed>` 随机 id；
   *  与 glyph 互斥，同时存在时头像优先 */
  avatar?: string;
  /** 主色 hex（预设或自定义）；缺省 = 主题色 */
  color?: string;
  /** 自传图片（dataURL，64×64 PNG）；设置后盖过 glyph/avatar/color */
  image?: string;
};

/** 自传图片 dataURL 上限（约 150KB 图；64×64 PNG 正常在 5–20KB） */
export const PROJECT_IMAGE_MAX_CHARS = 200_000;

const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/iu;

export function isProjectImageDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PROJECT_IMAGE_MAX_CHARS &&
    DATA_IMAGE_RE.test(value)
  );
}

/**
 * 存储/水合时的收口：逐字段校验，坏字段丢弃；所有字段都为空返回 null。
 * 存储里可能混进旧版本/手改数据——一律静默丢弃而不是崩或显示坏图。
 */
export function normalizeProjectAppearance(
  value: unknown,
): ProjectAppearance | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const next: ProjectAppearance = {};
  if (isProjectGlyphId(raw.glyph)) next.glyph = raw.glyph;
  if (isProjectAvatarId(raw.avatar)) next.avatar = raw.avatar;
  // 颜色统一小写入库：预设比较、customColor 判断都按小写进行，
  // 避免取色器回传大写 hex 时出现"预设色被当成自定义色"的双选状态
  if (isProjectColor(raw.color)) next.color = raw.color.toLowerCase();
  if (isProjectImageDataUrl(raw.image)) next.image = raw.image;
  // 吉祥物与内置头像互斥（界面上选取时会主动清另一组；这里兜底手改/旧版本数据）
  if (next.avatar !== undefined) delete next.glyph;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * 是否有"可显示的标记"（图片 / 内置头像 / 矢量吉祥物，三者任一）。
 * UI 判条件统一走这里，不要手写 `appearance.image || appearance.glyph || ...`——
 * 新增一种身份来源时手写的条件最容易漏改（曾发生：加了一组图标但判定只认
 * image/glyph，选新图标时侧栏看起来"没切换"）。注意：只选了颜色不算
 * （颜色是"给图标上色"用的，由调用方把颜色套在默认文件夹图标上）。
 */
export function hasProjectAppearance(
  appearance: ProjectAppearance | null,
): boolean {
  return Boolean(
    appearance && (appearance.image || appearance.avatar || appearance.glyph),
  );
}

/* ------------------------------- 存储 ------------------------------- */

const STORAGE_KEY = "project-appearance-v1";
/** 记住多少个项目的外观（LRU）：项目数会增长，无上限就变成泄漏 */
const MAX_PROJECTS = 200;

/** cwd → 外观（Map 迭代序 = 写入序，超限从头淘汰） */
let byProject = new Map<string, ProjectAppearance>();
let hydrated = false;
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};

function readStorage(): Record<string, unknown> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  const stored = readStorage();
  if (!stored) return;
  // 超上限取后 MAX_PROJECTS 条（原写入序的后段 = 最近使用）
  for (const [cwd, value] of Object.entries(stored).slice(-MAX_PROJECTS)) {
    if (!cwd) continue;
    const appearance = normalizeProjectAppearance(value);
    if (appearance) byProject.set(cwd, appearance);
  }
}

function persist(): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(byProject)),
    );
  } catch {
    /* 存储不可用（隐私模式/配额）：内存态照常工作 */
  }
}

/** 项目当前外观；未设置/数据已失效 → null（渲染回退文件夹图标） */
export function projectAppearanceFor(cwd: string): ProjectAppearance | null {
  if (!cwd) return null;
  ensureHydrated();
  return byProject.get(cwd) ?? null;
}

/**
 * 覆盖设置某项目的外观（整对象替换；传 null 清除）。
 * 传对象时内部先经 normalizeProjectAppearance 收口——坏数据进不了存储。
 */
export function setProjectAppearance(
  cwd: string,
  appearance: ProjectAppearance | null,
): void {
  if (!cwd) return;
  ensureHydrated();
  const next = normalizeProjectAppearance(appearance);
  const prev = byProject.get(cwd) ?? null;
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  byProject.delete(cwd);
  if (next !== null) {
    byProject.set(cwd, next);
    if (byProject.size > MAX_PROJECTS) {
      for (const key of byProject.keys()) {
        if (byProject.size <= MAX_PROJECTS) break;
        byProject.delete(key);
      }
    }
  }
  persist();
  notify();
}

/**
 * 订阅"任何项目的外观变了"。侧边栏遍历分组时不能在循环里调 hook（hook 顺序
 * 会随组数变化），所以订阅收敛成一条：拿版本号，逐行直接读值。外观极少变，
 * 版本号变化触发的整表重渲代价可忽略。
 */
export function useProjectAppearancesVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => 0,
  );
}

/** 测试缝：用例之间隔离（清内存态与 hydration 标记） */
export function resetProjectAppearancesForTest(): void {
  byProject = new Map();
  hydrated = false;
  version = 0;
  listeners.clear();
}
