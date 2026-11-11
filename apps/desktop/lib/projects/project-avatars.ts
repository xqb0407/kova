/**
 * 项目内置头像（DiceBear Gaze，CC0 1.0）· 纯逻辑，无 React/DOM，可单测。
 *
 * 用 DiceBear 的 JS 库（@dicebear/core + @dicebear/styles）在运行时生成 SVG，
 * 不再预生成 12 张静态文件：省掉 public/project-avatars 的产物体积，也不用
 * 每次改预设都联网跑生成脚本。Gaze 定义来自 CC0 的 @dicebear/styles。
 *
 * 参数全部显式（shape/eyes/spacing/体色/背景色 + seed），不依赖随机数实现，
 * 同一 id 在桌面端/SSR/测试里生成的 SVG 逐字节一致。
 */
import { Avatar, Style, type StyleDefinition } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";

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

/** Gaze 定义只包一次：Style 构造会做 schema 校验与深拷贝，别每张头像重跑 */
const GAZE_STYLE = new Style(gazeDefinition as unknown as StyleDefinition);

/** 生成过的 data URI 按 id 缓存：侧栏/选择器每次渲染都调 projectAvatarSrc */
const DATA_URI_CACHE = new Map<string, string>();

export function isProjectAvatarId(value: unknown): value is string {
  return typeof value === "string" && AVATAR_IDS.has(value);
}

/** 内置头像 id → 可直接喂给 <img src> 的 data URI；未知 id 返回 null（回退图标） */
export function projectAvatarSrc(id: string | undefined | null): string | null {
  if (!isProjectAvatarId(id)) return null;
  const cached = DATA_URI_CACHE.get(id);
  if (cached) return cached;

  const spec = SPEC_BY_ID.get(id)!;
  const uri = new Avatar(GAZE_STYLE, {
    seed: spec.seed,
    shapeVariant: spec.shape,
    shapeProbability: 100,
    eyesVariant: spec.eyes,
    eyesProbability: 100,
    spacingVariant: spec.spacing,
    spacingProbability: 100,
    animationVariant: "none",
    bodyColor: [spec.bodyColor],
    backgroundColor: [spec.backgroundColor],
  }).toDataUri();

  DATA_URI_CACHE.set(id, uri);
  return uri;
}
