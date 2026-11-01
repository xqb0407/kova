/**
 * 生成项目内置头像（DiceBear Gaze 风格）→ apps/desktop/public/project-avatars/*.svg
 *
 *   node scripts/generate-project-avatars.mjs
 *
 * 产物入库（每张 ~2KB 纯矢量文本）。Gaze 由 DiceBear 官方设计，授权 CC0 1.0
 * （公共领域：可随应用再分发、可商用、无需署名，见每个 SVG 内嵌的 <metadata>）。
 *
 * 与 generate-subagent-avatars.mjs 同一套纪律：全部用显式参数（shapeVariant /
 * eyesVariant / spacingVariant / 颜色），不依赖随机数实现——换 DiceBear 小版本
 * 重跑脚本也应原样复现；seed 只兜底残余随机项。
 *
 * 需要网络（api.dicebear.com）；改完表后重跑一次即可。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.dicebear.com/10.x/gaze/svg";
const OUT_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "apps/desktop/public/project-avatars",
);

/** Gaze 部件（api.dicebear.com/10.x/gaze/options.json），注释里给中文名方便挑 */
const SHAPES = [
  "circle", // 圆
  "pill", // 胶囊
  "egg", // 蛋
  "arch", // 拱
  "square", // 方
  "hexagon", // 六边
  "pentagon", // 五边
  "diamond", // 菱形
  "triangle", // 三角
  "octagon", // 八边
  "column", // 柱
];
const EYES = [
  "bars", // 横条
  "beans", // 豆眼
  "big", // 大眼
  "dots", // 点眼
  "grin", // 笑眼
  "happy", // 弯眼
  "shine", // 闪光
  "small", // 小眼
  "squint", // 眯眼
  "tall", // 竖眼
  "wide", // 宽眼
];
const SPACINGS = ["close", "far", "normal", "snug", "wide"];
const BODY_COLORS = [
  "e2725b", "e9b44c", "7cb342", "2a9d8f", "4f86c6", "7c6bc4",
  "d96c9e", "f08a5d", "6aa6a1", "c38d9e", "5b8e7d", "8d6e63",
];
const BACKGROUNDS = [
  "f7efe7", "f9f2dd", "eef4e4", "e7f3f0", "eaf1f8", "f0edf8",
  "f9eaf1", "fbece5", "ecf4f2", "f8edf1", "eaf3ef", "f3edea",
];

/**
 * 12 个预设：11 种轮廓 + 圆重复一次，眼睛/眼距每张都不同。
 * 体色与背景成对从上面的表里取，label 直接描述"轮廓 · 颜色"。
 */
const AVATARS = [
  { id: "gaze-01", label: "圆 · 陶土", shape: SHAPES[0], eyes: EYES[2], spacing: SPACINGS[2], color: 0, bg: 0, seed: "kova-gaze-01" },
  { id: "gaze-02", label: "胶囊 · 蜜黄", shape: SHAPES[1], eyes: EYES[5], spacing: SPACINGS[3], color: 1, bg: 1, seed: "kova-gaze-02" },
  { id: "gaze-03", label: "蛋 · 叶绿", shape: SHAPES[2], eyes: EYES[3], spacing: SPACINGS[0], color: 2, bg: 2, seed: "kova-gaze-03" },
  { id: "gaze-04", label: "拱 · 海松", shape: SHAPES[3], eyes: EYES[10], spacing: SPACINGS[2], color: 3, bg: 3, seed: "kova-gaze-04" },
  { id: "gaze-05", label: "方 · 天蓝", shape: SHAPES[4], eyes: EYES[7], spacing: SPACINGS[4], color: 4, bg: 4, seed: "kova-gaze-05" },
  { id: "gaze-06", label: "六边 · 紫藤", shape: SHAPES[5], eyes: EYES[6], spacing: SPACINGS[2], color: 5, bg: 5, seed: "kova-gaze-06" },
  { id: "gaze-07", label: "五边 · 玫瑰", shape: SHAPES[6], eyes: EYES[1], spacing: SPACINGS[1], color: 6, bg: 6, seed: "kova-gaze-07" },
  { id: "gaze-08", label: "菱形 · 杏橙", shape: SHAPES[7], eyes: EYES[9], spacing: SPACINGS[0], color: 7, bg: 7, seed: "kova-gaze-08" },
  { id: "gaze-09", label: "三角 · 鼠尾草", shape: SHAPES[8], eyes: EYES[8], spacing: SPACINGS[2], color: 8, bg: 8, seed: "kova-gaze-09" },
  { id: "gaze-10", label: "八边 · 藕粉", shape: SHAPES[9], eyes: EYES[4], spacing: SPACINGS[3], color: 9, bg: 9, seed: "kova-gaze-10" },
  { id: "gaze-11", label: "柱 · 松绿", shape: SHAPES[10], eyes: EYES[0], spacing: SPACINGS[4], color: 10, bg: 10, seed: "kova-gaze-11" },
  { id: "gaze-12", label: "圆 · 可可", shape: SHAPES[0], eyes: EYES[5], spacing: SPACINGS[1], color: 11, bg: 11, seed: "kova-gaze-12" },
];

function urlFor(a) {
  const params = new URLSearchParams({
    seed: a.seed,
    shapeVariant: a.shape,
    shapeProbability: "100",
    eyesVariant: a.eyes,
    eyesProbability: "100",
    spacingVariant: a.spacing,
    spacingProbability: "100",
    bodyColor: BODY_COLORS[a.color],
    backgroundColor: BACKGROUNDS[a.bg],
    animationVariant: "none",
  });
  return `${API}?${params}`;
}

const header = (id) =>
  `<!-- Kova built-in project avatar (${id}). Style: DiceBear Gaze, CC0 1.0. Regenerate: node scripts/generate-project-avatars.mjs -->\n`;

mkdirSync(OUT_DIR, { recursive: true });
let failures = 0;
for (const a of AVATARS) {
  const res = await fetch(urlFor(a));
  if (!res.ok) {
    console.error(`[generate-project-avatars] ${a.id}: HTTP ${res.status}`);
    failures += 1;
    continue;
  }
  let svg = await res.text();
  // 前端以 <img> 渲染：去掉 metadata 压缩体积，只保留干净的结构块
  svg = svg.replace(/<metadata[\s\S]*?<\/metadata>/, "");
  if (!svg.startsWith("<svg")) {
    console.error(`[generate-project-avatars] ${a.id}: 响应不是 SVG`);
    failures += 1;
    continue;
  }
  writeFileSync(join(OUT_DIR, `${a.id}.svg`), header(a.id) + svg, "utf8");
  console.log(`ok ${a.id} ${a.label} (${svg.length} bytes)`);
}
if (failures > 0) {
  console.error(`[generate-project-avatars] ${failures} 张失败`);
  process.exit(1);
}
console.log(`[generate-project-avatars] ${AVATARS.length} 个预设已写入 ${OUT_DIR}`);
