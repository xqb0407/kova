/**
 * 项目外观（侧边栏「项目」分组头的身份标记）：内置吉祥物 + 项目主色 + 自传图片。
 *
 * 参考项目用 8×8 像素精灵表达项目身份；我们**两种都收**，做成一组可选项：
 * - 「吉祥物」12 个矢量图标（现成的线稿图标，任何尺寸都干净）；
 * - 「像素」8 个自绘 8×8 精灵（`#` 上色、`.` 透明——眼睛/缝隙就是挖空的洞，
 *   见 components/ui/pixel-mascot.tsx 与 projection-mascots 的网格定义）；
 * 并支持用户上传自己的图片（自动缩到 64×64 存本地）。
 * 两组互斥：同时存在时像素优先（水合时的手改数据兜底；界面在选取时主动清另一组）。
 *
 * 本模块只管数据与存储（无 UI 依赖，便于单测）；图标映射与渲染见
 * components/ui/project-badge.tsx，设置界面见
 * components/agent-thread/project-appearance-dialog.tsx。
 *
 * 存储按项目工作目录（cwd）落 localStorage；与面板标签/开合偏好同款纪律：
 * 模块级 store + useSyncExternalStore（只让 primitive 参与订阅）。
 */
import { useSyncExternalStore } from "react";

/** 内置吉祥物条目：id 给存储，label 给界面；矢量图标映射在 UI 层
 *  （project-badge.tsx），像素精灵的网格紧随其后（rows 字段只像素组有） */
export type ProjectMascotGlyph = {
  id: string;
  label: string;
  /** 仅像素组：8×8 网格行 */
  rows?: readonly string[];
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

/**
 * 8×8 像素吉祥物（两套并列，共 16 个）：`#` 上色、`.` 透明——眼睛/缝隙靠挖洞
 * 表达（像素画里最省事也最像"精灵"的画法）。渲染见
 * components/ui/pixel-mascot.tsx（viewBox 8×8 + crispEdges）。
 * - 技术主题：robot / cpu / terminal / database / signal / gear / drone / headphones；
 * - 形态主题：tile / bolt / cactus / cloud / penguin / cup / fox / moon
 *   （取"平面上好认、轮廓彼此差得开"的八种：方、折、柱、团、卵、杯、尖、弯）。
 * 两套 id 与 label 均不与矢量组（PROJECT_MASCOT_GLYPHS）重复，选择器按 label 去重显示。
 */
export const PROJECT_PIXEL_MASCOTS: readonly ProjectMascotGlyph[] = [
    {
    id: "robot",
    label: "小机器人",
    rows: [
      ".#....#.",
      ".#....#.",
      "########",
      "##.##.##",
      "##.##.##",
      "########",
      "##.##.##",
      ".######.",
    ],
  },
  {
    id: "cpu",
    label: "芯片",
    rows: [
      ".#.#.#.#",
      "########",
      "########",
      "##....##",
      "#......#",
      "##....##",
      "########",
      ".#.#.#.#",
    ],
  },
  {
    id: "terminal",
    label: "终端",
    rows: [
      "########",
      "###..###",
      "#......#",
      "#..#..#.",
      "#......#",
      "#..##...",
      "#......#",
      "########",
    ],
  },
  {
    id: "database",
    label: "数据库",
    rows: [
      "########",
      "#......#",
      "########",
      "#......#",
      "########",
      "#......#",
      "########",
      "#......#",
    ],
  },
  {
    id: "signal",
    label: "信号",
    rows: [
      "........",
      "......#.",
      ".....##.",
      "....###.",
      "...####.",
      "..####..",
      ".######.",
      "########",
    ],
  },
  {
    id: "gear",
    label: "齿轮",
    rows: [
      "..####..",
      "########",
      "##.##.##",
      "###..###",
      "###..###",
      "##.##.##",
      "########",
      "..####..",
    ],
  },
  {
    id: "tile",
    label: "瓦片",
    rows: [
      "..####..",
      ".######.",
      "########",
      "##.##.##",
      "########",
      "##....##",
      ".######.",
      "..####..",
    ],
  },
  {
    id: "bolt",
    label: "闪电",
    rows: [
      "...###..",
      "..###...",
      ".###....",
      "######..",
      "...####.",
      "..###...",
      ".###....",
      "###.....",
    ],
  },
  {
    id: "cactus",
    label: "仙人掌",
    rows: [
      "..####..",
      "..####..",
      "#.####.#",
      "#.####.#",
      "###..###",
      "..####..",
      "..####..",
      "..####..",
    ],
  },
  {
    id: "cloud",
    label: "云朵",
    rows: [
      "........",
      "..####..",
      ".######.",
      "########",
      "########",
      "########",
      ".######.",
      "........",
    ],
  },
  {
    id: "penguin",
    label: "企鹅",
    rows: [
      "..####..",
      ".######.",
      "##.##.##",
      "########",
      "##....##",
      "##....##",
      ".######.",
      ".#....#.",
    ],
  },
   {
    id: "drone",
    label: "无人机",
    rows: [
      ".#....#.",
      ".#....#.",
      "########",
      "###..###",
      "########",
      ".######.",
      "........",
      "........",
    ],
  },
   {
    id: "headphones",
    label: "耳机",
    rows: [
      "..####..",
      ".#....#.",
      "#......#",
      "#......#",
      "###..###",
      "##....##",
      "........",
      "........",
    ],
  },
  {
    id: "cup",
    label: "杯子",
    rows: [
      "..#..#..",
      "..#..#..",
      ".######.",
      "########",
      "########",
      "######.#",
      ".######.",
      "..####..",
    ],
  },
  {
    id: "fox",
    label: "狐狸",
    rows: [
      "#......#",
      "##....##",
      "###..###",
      "########",
      "#.#..#.#",
      "########",
      ".######.",
      "..####..",
    ],
  },
  {
    id: "moon",
    label: "月亮",
    rows: [
      "..###...",
      ".###....",
      "###.....",
      "###.....",
      "###.....",
      "###.....",
      ".###....",
      "..###...",
    ],
  },
] as const;

const PIXEL_IDS = new Set(PROJECT_PIXEL_MASCOTS.map((m) => m.id));

export function isProjectPixelId(value: unknown): value is string {
  return typeof value === "string" && PIXEL_IDS.has(value);
}

/** 像素精灵的网格行；未知 id 返回 null（渲染层回退到不画） */
export function pixelMascotRows(id: string): readonly string[] | null {
  return PROJECT_PIXEL_MASCOTS.find((m) => m.id === id)?.rows ?? null;
}

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

const COLOR_SET = new Set(PROJECT_MASCOT_COLORS);

export function isProjectColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_SET.has(value);
}

/** 外观三件套；空对象 = 未设置（回退默认文件夹图标） */
export type ProjectAppearance = {
  /** 内置吉祥物（矢量图标）id；缺省 = 不用 */
  glyph?: string;
  /** 内置像素精灵 id（与 glyph 互斥，同时存在时像素优先） */
  pixel?: string;
  /** 预设主色 hex；缺省 = 主题色 */
  color?: string;
  /** 自传图片（dataURL，64×64 PNG）；设置后盖过 glyph/color */
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
 * 存储/水合时的收口：逐字段校验，坏字段丢弃；三字段全空返回 null。
 * 存储里可能混进旧版本/手改数据——一律静默丢弃而不是崩或显示坏图。
 */
export function normalizeProjectAppearance(
  value: unknown,
): ProjectAppearance | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const next: ProjectAppearance = {};
  if (isProjectGlyphId(raw.glyph)) next.glyph = raw.glyph;
  if (isProjectPixelId(raw.pixel)) next.pixel = raw.pixel;
  if (isProjectColor(raw.color)) next.color = raw.color;
  if (isProjectImageDataUrl(raw.image)) next.image = raw.image;
  // 两组吉祥物互斥（界面上选取时会主动清另一组；这里兜底手改/旧版本数据）
  if (next.pixel !== undefined) delete next.glyph;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * 是否有"可显示的标记"（图片 / 矢量吉祥物 / 像素吉祥物，三者任一）。
 * UI 判条件统一走这里，不要手写 `appearance.image || appearance.glyph || ...`——
 * 新增一组吉祥物时手写的条件最容易漏改（曾发生：加了像素组但判定只认 image/glyph，
 * 选像素时侧栏看起来"没切换"）。注意：只选了颜色不算（颜色是"给图标上色"用的，
 * 由调用方把颜色套在默认文件夹图标上）。
 */
export function hasProjectAppearance(
  appearance: ProjectAppearance | null,
): boolean {
  return Boolean(
    appearance && (appearance.image || appearance.glyph || appearance.pixel),
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
