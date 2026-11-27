/**
 * 项目头像（DiceBear，CC0 1.0）· 纯逻辑，无 React/DOM，可单测。
 *
 * 用 DiceBear 的 JS 库（@dicebear/core + @dicebear/styles）在运行时生成 SVG，
 * 不再预生成静态文件：省掉 public/project-avatars 的产物体积，也不用每次改
 * 预设都联网跑生成脚本。
 *
 * - 24 个 Gaze 预设：参数全部显式（shape/eyes/spacing/体色/背景色 + seed），
 *   同一 id 生成的 SVG 逐字节一致；
 * - 「随机」：从 @dicebear/styles 的 61 种风格里抽一种，只把 style/seed 和
 *   背景色编进 id（`dicebear:<style>:<bg>:<seed>`），形状/配色交给 DiceBear
 *   按 seed 解析，存储只占几十字节；
 * - 兼容早期的 `gaze-r-…` 随机 id（只限 Gaze 全参数）。
 */
import { Avatar, Style, type StyleDefinition } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import {
  DICEBEAR_STYLE_IDS,
  dicebearStyle,
  isDicebearStyleId,
} from "./dicebear-styles";

export interface BuiltinProjectAvatar {
  id: string;
  label: string;
}

type AvatarSpec = BuiltinProjectAvatar & {
  shape: string;
  eyes: string;
  spacing: string;
  bodyColor: string;
  backgroundColor: string;
  seed: string;
};

/** 24 个预设：11 种轮廓轮换出现，眼睛/眼距/体色/背景两两组合，
 *  label 直接描述"轮廓 · 颜色"。新增时只要保证 id/seed 唯一。 */
const AVATAR_SPECS: readonly AvatarSpec[] = [
  { id: "gaze-01", label: "圆 · 陶土", shape: "circle", eyes: "big", spacing: "normal", bodyColor: "#e2725b", backgroundColor: "#f7efe7", seed: "kova-gaze-01" },
  { id: "gaze-02", label: "胶囊 · 蜜黄", shape: "pill", eyes: "happy", spacing: "snug", bodyColor: "#e9b44c", backgroundColor: "#f9f2dd", seed: "kova-gaze-02" },
  { id: "gaze-03", label: "蛋 · 叶绿", shape: "egg", eyes: "dots", spacing: "close", bodyColor: "#7cb342", backgroundColor: "#eef4e4", seed: "kova-gaze-03" },
  { id: "gaze-04", label: "拱 · 海松", shape: "arch", eyes: "wide", spacing: "normal", bodyColor: "#2a9d8f", backgroundColor: "#e7f3f0", seed: "kova-gaze-04" },
  { id: "gaze-05", label: "方 · 天蓝", shape: "square", eyes: "small", spacing: "wide", bodyColor: "#4f86c6", backgroundColor: "#eaf1f8", seed: "kova-gaze-05" },
  { id: "gaze-06", label: "六边 · 紫藤", shape: "hexagon", eyes: "shine", spacing: "normal", bodyColor: "#7c6bc4", backgroundColor: "#f0edf8", seed: "kova-gaze-06" },
  { id: "gaze-07", label: "五边 · 玫瑰", shape: "pentagon", eyes: "beans", spacing: "far", bodyColor: "#d96c9e", backgroundColor: "#f9eaf1", seed: "kova-gaze-07" },
  { id: "gaze-08", label: "菱形 · 杏橙", shape: "diamond", eyes: "tall", spacing: "close", bodyColor: "#f08a5d", backgroundColor: "#fbece5", seed: "kova-gaze-08" },
  { id: "gaze-09", label: "三角 · 鼠尾草", shape: "triangle", eyes: "squint", spacing: "normal", bodyColor: "#6aa6a1", backgroundColor: "#ecf4f2", seed: "kova-gaze-09" },
  { id: "gaze-10", label: "八边 · 藕粉", shape: "octagon", eyes: "grin", spacing: "snug", bodyColor: "#c38d9e", backgroundColor: "#f8edf1", seed: "kova-gaze-10" },
  { id: "gaze-11", label: "柱 · 松绿", shape: "column", eyes: "bars", spacing: "wide", bodyColor: "#5b8e7d", backgroundColor: "#eaf3ef", seed: "kova-gaze-11" },
  { id: "gaze-12", label: "圆 · 可可", shape: "circle", eyes: "happy", spacing: "far", bodyColor: "#8d6e63", backgroundColor: "#f3edea", seed: "kova-gaze-12" },
  { id: "gaze-13", label: "方 · 珊瑚", shape: "square", eyes: "dots", spacing: "snug", bodyColor: "#e76f51", backgroundColor: "#fdeee8", seed: "kova-gaze-13" },
  { id: "gaze-14", label: "六边 · 柠檬", shape: "hexagon", eyes: "wide", spacing: "close", bodyColor: "#d4a72c", backgroundColor: "#faf6df", seed: "kova-gaze-14" },
  { id: "gaze-15", label: "三角 · 薄荷", shape: "triangle", eyes: "shine", spacing: "wide", bodyColor: "#3fb6a8", backgroundColor: "#e6f6f2", seed: "kova-gaze-15" },
  { id: "gaze-16", label: "拱 · 雾蓝", shape: "arch", eyes: "bars", spacing: "far", bodyColor: "#6b8cae", backgroundColor: "#edf2f7", seed: "kova-gaze-16" },
  { id: "gaze-17", label: "菱形 · 薰衣草", shape: "diamond", eyes: "small", spacing: "normal", bodyColor: "#9b8ad6", backgroundColor: "#f2effa", seed: "kova-gaze-17" },
  { id: "gaze-18", label: "五边 · 蜜桃", shape: "pentagon", eyes: "grin", spacing: "close", bodyColor: "#f2a488", backgroundColor: "#fdf0e9", seed: "kova-gaze-18" },
  { id: "gaze-19", label: "蛋 · 莓果", shape: "egg", eyes: "squint", spacing: "wide", bodyColor: "#b45c7c", backgroundColor: "#f9edf2", seed: "kova-gaze-19" },
  { id: "gaze-20", label: "八边 · 橄榄", shape: "octagon", eyes: "tall", spacing: "normal", bodyColor: "#7d8c4f", backgroundColor: "#f1f4e6", seed: "kova-gaze-20" },
  { id: "gaze-21", label: "胶囊 · 天空", shape: "pill", eyes: "big", spacing: "far", bodyColor: "#4aa3df", backgroundColor: "#e8f4fd", seed: "kova-gaze-21" },
  { id: "gaze-22", label: "柱 · 砖红", shape: "column", eyes: "beans", spacing: "close", bodyColor: "#b5654a", backgroundColor: "#f7ece7", seed: "kova-gaze-22" },
  { id: "gaze-23", label: "圆 · 沙金", shape: "circle", eyes: "happy", spacing: "snug", bodyColor: "#c9a227", backgroundColor: "#faf5e2", seed: "kova-gaze-23" },
  { id: "gaze-24", label: "方 · 石墨", shape: "square", eyes: "grin", spacing: "normal", bodyColor: "#4a5568", backgroundColor: "#eef0f3", seed: "kova-gaze-24" },
];

export const BUILTIN_PROJECT_AVATARS: readonly BuiltinProjectAvatar[] =
  AVATAR_SPECS;

const AVATAR_IDS = new Set(AVATAR_SPECS.map((a) => a.id));
const SPEC_BY_ID = new Map(AVATAR_SPECS.map((a) => [a.id, a]));

/** 随机头像的背景色：复用 24 张预设的浅色底盘，保证各种风格的随机头像
 *  在侧栏/选择器里都有干净底色；形状/五官/体色交给 DiceBear 按 seed 抽 */
const PROJECT_AVATAR_BACKGROUNDS = [
  ...new Set(AVATAR_SPECS.map((a) => a.backgroundColor)),
];

const HEX6_RE = /^[0-9a-f]{6}$/u;
/** seed 只允许小写字母/数字：会直接拼进 id，白名单外一律不认 */
const RANDOM_SEED_RE = /^[a-z0-9]{4,16}$/u;

/** 全风格随机 id：dicebear:<style>:<bgHex>:<seed>。
 *  style 必须命中 @dicebear/styles 清单；seed 决定形状/五官/配色，背景色
 *  取预设浅色板。只存参数不落 data URL，刷新/重开后仍重建同一张图。 */
const DICEBEAR_AVATAR_PREFIX = "dicebear:";

type DicebearAvatarSpec = {
  styleId: string;
  seed: string;
  backgroundColor: string;
};

/** 解析全风格随机 id；风格/颜色/seed 越界返回 null（白名单外不渲染） */
function parseDicebearAvatarId(id: string): DicebearAvatarSpec | null {
  if (!id.startsWith(DICEBEAR_AVATAR_PREFIX)) return null;
  const [styleId, bgHex, seed, ...rest] = id
    .slice(DICEBEAR_AVATAR_PREFIX.length)
    .split(":");
  if (rest.length > 0 || !styleId || !bgHex || !seed) return null;
  if (
    !isDicebearStyleId(styleId) ||
    !HEX6_RE.test(bgHex) ||
    !RANDOM_SEED_RE.test(seed)
  ) {
    return null;
  }
  return {
    styleId,
    seed,
    backgroundColor: `#${bgHex}`,
  };
}

/** 早期 Gaze 随机 id：gaze-r-<bodyHex>-<bgHex>-<seed>（保留兼容） */
const GAZE_RANDOM_PREFIX = "gaze-r-";

type GazeRandomAvatarSpec = {
  seed: string;
  bodyColor: string;
  backgroundColor: string;
};

/** 解析早期 Gaze 随机 id；不是该形态、颜色/seed 越界返回 null */
function parseGazeRandomAvatarId(id: string): GazeRandomAvatarSpec | null {
  if (!id.startsWith(GAZE_RANDOM_PREFIX)) return null;
  const [bodyHex, bgHex, seed, ...rest] = id
    .slice(GAZE_RANDOM_PREFIX.length)
    .split("-");
  if (rest.length > 0 || !bodyHex || !bgHex || !seed) return null;
  if (
    !HEX6_RE.test(bodyHex) ||
    !HEX6_RE.test(bgHex) ||
    !RANDOM_SEED_RE.test(seed)
  ) {
    return null;
  }
  return {
    seed,
    bodyColor: `#${bodyHex}`,
    backgroundColor: `#${bgHex}`,
  };
}

/** Gaze 定义只包一次：Style 构造会做 schema 校验与深拷贝，别每张头像重跑 */
const GAZE_STYLE = new Style(gazeDefinition as unknown as StyleDefinition);

/** 生成过的 data URI 按 id 缓存：侧栏/选择器每次渲染都调 projectAvatarSrc */
const DATA_URI_CACHE = new Map<string, string>();

const pick = <T,>(list: readonly T[]): T =>
  list[Math.floor(Math.random() * list.length)]!;

const RANDOM_SEED_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8 位 base36 随机串：每次点「随机」都换一个 seed，头像才会真的变 */
function randomSeed(): string {
  let seed = "";
  for (let i = 0; i < 8; i += 1) {
    seed += RANDOM_SEED_ALPHABET[
      Math.floor(Math.random() * RANDOM_SEED_ALPHABET.length)
    ];
  }
  return seed;
}

/**
 * 「随机一张」：从 DiceBear 全部 61 种风格里等概率抽一种，再给一个全新的
 * 随机 seed（决定形状/五官/配色）；背景色取预设浅色板，保证在侧栏/选择器
 * 里都有干净底盘。id 只存 style/seed/背景，几十字节，刷新后仍复现同一张。
 */
export function randomProjectAvatar(): string {
  return `dicebear:${pick(DICEBEAR_STYLE_IDS)}:${pick(
    PROJECT_AVATAR_BACKGROUNDS,
  ).slice(1)}:${randomSeed()}`;
}

/** 按风格 + seed 组装随机风格头像 id（与 randomProjectAvatar 同一格式）：
 *  背景色由 seed 确定性地取自预设浅色板，同一 (style, seed) 恒同图。
 *  风格越界 / seed 不合白名单返回 null。笔记图标选择器的风格页签用它。 */
export function dicebearStyleAvatarValue(
  styleId: string,
  seed: string,
): string | null {
  if (!isDicebearStyleId(styleId) || !RANDOM_SEED_RE.test(seed)) return null;
  const bg = PROJECT_AVATAR_BACKGROUNDS[
    (seed.charCodeAt(0) + seed.length) % PROJECT_AVATAR_BACKGROUNDS.length
  ];
  return `dicebear:${styleId}:${bg.slice(1)}:${seed}`;
}

export function isProjectAvatarId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (AVATAR_IDS.has(value) ||
      parseGazeRandomAvatarId(value) !== null ||
      parseDicebearAvatarId(value) !== null)
  );
}

/** 内置/随机头像 id → 可直接喂给 <img src> 的 data URI；
 *  未知 id 返回 null（回退图标） */
export function projectAvatarSrc(id: string | undefined | null): string | null {
  if (typeof id !== "string") return null;
  const cached = DATA_URI_CACHE.get(id);
  if (cached) return cached;

  const preset = SPEC_BY_ID.get(id);
  const gazeRandom = preset ? null : parseGazeRandomAvatarId(id);
  const dicebear = preset || gazeRandom ? null : parseDicebearAvatarId(id);
  if (!preset && !gazeRandom && !dicebear) return null;

  let uri: string;
  if (preset) {
    // 固定预设：参数全部显式，保证 24 张的造型/配色不变
    uri = new Avatar(GAZE_STYLE, {
      seed: preset.seed,
      shapeVariant: preset.shape,
      shapeProbability: 100,
      eyesVariant: preset.eyes,
      eyesProbability: 100,
      spacingVariant: preset.spacing,
      spacingProbability: 100,
      animationVariant: "none",
      bodyColor: [preset.bodyColor],
      backgroundColor: [preset.backgroundColor],
    }).toDataUri();
  } else if (dicebear) {
    // 全风格随机：形状/五官/配色交给 DiceBear 按 seed 解析；固定静态
    // （部分风格自带 animation 组件，列表里不该自己动）
    const style = dicebearStyle(dicebear.styleId);
    if (!style) return null;
    uri = new Avatar(style, {
      seed: dicebear.seed,
      animationVariant: "none",
      backgroundColor: [dicebear.backgroundColor],
    }).toDataUri();
  } else {
    // 兼容早期只限 Gaze 的随机 id
    uri = new Avatar(GAZE_STYLE, {
      seed: gazeRandom!.seed,
      animationVariant: "none",
      bodyColor: [gazeRandom!.bodyColor],
      backgroundColor: [gazeRandom!.backgroundColor],
    }).toDataUri();
  }

  DATA_URI_CACHE.set(id, uri);
  return uri;
}
