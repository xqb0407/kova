/**
 * 生成子智能体内置头像（DiceBear Clay 风格）→ apps/desktop/public/subagent-avatars/*.svg
 *
 *   node scripts/generate-subagent-avatars.mjs
 *
 * 产物入库（每张 ~3KB 纯矢量文本）。Clay 由 DiceBear 官方设计，授权 CC0 1.0
 * （公共领域：可随应用再分发、可商用、无需署名，见每个 SVG 内嵌的 <metadata>）。
 *
 * 24 个预设全部用显式参数（bodyVariant/eyesVariant/... 而不是只给 seed）：
 * DiceBear 换小版本可能换随机数实现，显式参数保证「重新生成 = 原样复现」，
 * 不会某天跑一遍脚本整批头像变脸。seed 只兜底残余随机项（如未固定的 pattern）。
 *
 * 需要网络（api.dicebear.com）；改完表后重跑一次即可。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.dicebear.com/10.x/clay/svg";
const OUT_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "apps/desktop/public/subagent-avatars",
);

/** Clay 部件枚举（api.dicebear.com/10.x/clay/options.json），注释里给中文名方便挑 */
const TOPS = [
  "horns", // 小恶魔角
  "nub", // 短角
  "curl", // 卷毛
  "spikes", // 刺刺
  "antenna", // 天线
  "loop", // 圈圈
  "peak", // 尖发
  "ears", // 兔耳
  "crest", // 鸡冠
  "swirl", // 旋毛
  "pellet", // 丸丸
  "hornsSmall", // 小角
  "tuft", // 呆毛
];
const BODIES = [
  "pear", // 梨形
  "boulder", // 圆石
  "loaf", // 面包
  "column", // 柱形
  "stack", // 叠叠
  "gumdrop", // 软糖
  "dollop", // 奶盖
  "slug", // 小蜗
  "egg", // 蛋蛋
  "blob", // 团子
  "bell", // 铃铛
  "cube", // 方块
  "squat", // 墩墩
  "lean", // 瘦高
];
const BODY_COLORS = [
  "c4795c", "d99277", "e0bd6a", "cf9f52", "a8b37e", "8ba06b",
  "83b0a4", "86a5c3", "9793bd", "ab8bbd", "cd8ea6", "b3a696",
];
const BACKGROUNDS = [
  "f4e8d4", "f8f1e5", "f7e3d9", "f9ecc9", "eff0da", "e3efe9",
  "e2ecf4", "e9e7f4", "f4e4ef", "ece8e2", "f9e8cf", "e8edf0",
];

/**
 * 24 个预设：14 种体型 × 12 种体色打底，眼睛/嘴配友善系表情，头顶装饰轮着来。
 * 表情刻意避开 frown/zigzag 一类丧脸——这是同事列表里的头像，不是桌宠。
 * label 显示在设置页选择器的悬浮提示里。
 */
const AVATARS = [
  { id: "clay-01", label: "团子 · 薄荷", body: "blob", eyes: "happy", mouth: "smile", top: "antenna", color: 6, bg: 6, seed: "kova-01" },
  { id: "clay-02", label: "方块 · 杏仁", body: "cube", eyes: "even", mouth: "smileBig", top: "ears", color: 1, bg: 1, seed: "kova-02" },
  { id: "clay-03", label: "墩墩 · 杏黄", body: "squat", eyes: "big", mouth: "grin", top: "crest", color: 3, bg: 3, seed: "kova-03" },
  { id: "clay-04", label: "铃铛 · 薰衣草", body: "bell", eyes: "wink", mouth: "smileTongue", top: "curl", color: 8, bg: 7, seed: "kova-04" },
  { id: "clay-05", label: "蛋蛋 · 奶油", body: "egg", eyes: "dots", mouth: "o", top: "nub", color: 10, bg: 0, seed: "kova-05" },
  { id: "clay-06", label: "面包 · 焦糖", body: "loaf", eyes: "happy", mouth: "laugh", top: "tuft", color: 0, bg: 2, seed: "kova-06" },
  { id: "clay-07", label: "软糖 · 天蓝", body: "gumdrop", eyes: "up", mouth: "smile", top: "swirl", color: 7, bg: 5, seed: "kova-07" },
  { id: "clay-08", label: "奶盖 · 鼠尾草", body: "dollop", eyes: "side", mouth: "cat", top: "loop", color: 4, bg: 4, seed: "kova-08" },
  { id: "clay-09", label: "小蜗 · 玫瑰", body: "slug", eyes: "googly", mouth: "open", top: "spikes", color: 10, bg: 8, seed: "kova-09" },
  { id: "clay-10", label: "梨子 · 蜜黄", body: "pear", eyes: "happy", mouth: "teeth", top: "peak", color: 2, bg: 10, seed: "kova-10" },
  { id: "clay-11", label: "圆石 · 藤绿", body: "boulder", eyes: "even", mouth: "smileBig", top: "hornsSmall", color: 5, bg: 5, seed: "kova-11" },
  { id: "clay-12", label: "柱柱 · 丁香", body: "column", eyes: "big", mouth: "smile", top: "horns", color: 8, bg: 11, seed: "kova-12" },
  { id: "clay-13", label: "叠叠 · 粉紫", body: "stack", eyes: "wink", mouth: "smile", top: "pellet", color: 9, bg: 8, seed: "kova-13" },
  { id: "clay-14", label: "瘦高 · 湖绿", body: "lean", eyes: "trio", mouth: "grin", top: "antenna", color: 6, bg: 9, seed: "kova-14" },
  { id: "clay-15", label: "团子 · 蜜桃", body: "blob", eyes: "happy", mouth: "smileBig", top: "tuft", color: 1, bg: 8, seed: "kova-15" },
  { id: "clay-16", label: "方块 · 鼠尾草", body: "cube", eyes: "dots", mouth: "cat", top: "swirl", color: 4, bg: 2, seed: "kova-16" },
  { id: "clay-17", label: "蛋蛋 · 鹅黄", body: "egg", eyes: "even", mouth: "uu", top: "crest", color: 2, bg: 3, seed: "kova-17" },
  { id: "clay-18", label: "铃铛 · 蜜橙", body: "bell", eyes: "big", mouth: "toothy", top: "ears", color: 0, bg: 1, seed: "kova-18" },
  { id: "clay-19", label: "墩墩 · 青苔", body: "squat", eyes: "happy", mouth: "smileTongue", top: "nub", color: 5, bg: 0, seed: "kova-19" },
  { id: "clay-20", label: "面包 · 苔绿", body: "loaf", eyes: "up", mouth: "smile", top: "peak", color: 4, bg: 6, seed: "kova-20" },
  { id: "clay-21", label: "软糖 · 丁香", body: "gumdrop", eyes: "side", mouth: "grin", top: "loop", color: 8, bg: 4, seed: "kova-21" },
  { id: "clay-22", label: "奶盖 · 冰蓝", body: "dollop", eyes: "happy", mouth: "openSmall", top: "curl", color: 7, bg: 11, seed: "kova-22" },
  { id: "clay-23", label: "梨子 · 紫藤", body: "pear", eyes: "mono", mouth: "smile", top: "hornsSmall", color: 9, bg: 7, seed: "kova-23" },
  { id: "clay-24", label: "圆石 · 暖沙", body: "boulder", eyes: "even", mouth: "laugh", top: "spikes", color: 11, bg: 9, seed: "kova-24" },
];

/** 六个预设带花纹（patternProbability=100 + 指定花型），其余关闭，避免整版太闹 */
const PATTERNS = {
  "clay-03": "checker",
  "clay-06": "freckles",
  "clay-09": "prints",
  "clay-13": "buttons",
  "clay-17": "stitches",
  "clay-22": "coil",
};

function urlFor(a) {
  const params = new URLSearchParams({
    seed: a.seed,
    bodyVariant: a.body,
    eyesVariant: a.eyes,
    mouthVariant: a.mouth,
    topVariant: a.top,
    topProbability: "100",
    bodyColor: BODY_COLORS[a.color],
    backgroundColor: BACKGROUNDS[a.bg],
    animationVariant: "none",
    ...(PATTERNS[a.id]
      ? { patternVariant: PATTERNS[a.id], patternProbability: "100" }
      : { patternProbability: "0" }),
  });
  return `${API}?${params}`;
}

const header = (id) =>
  `<!-- Kova built-in subagent avatar (${id}). Style: DiceBear Clay, CC0 1.0. Regenerate: node scripts/generate-subagent-avatars.mjs -->\n`;

mkdirSync(OUT_DIR, { recursive: true });
let failures = 0;
for (const a of AVATARS) {
  const res = await fetch(urlFor(a));
  if (!res.ok) {
    console.error(`[generate-subagent-avatars] ${a.id}: HTTP ${res.status}`);
    failures += 1;
    continue;
  }
  let svg = await res.text();
  // 前端以 <img> 渲染并可能嵌进 data URL：只保留干净的结构块
  svg = svg.replace(/<metadata[\s\S]*?<\/metadata>/, "");
  if (!svg.startsWith("<svg")) {
    console.error(`[generate-subagent-avatars] ${a.id}: 响应不是 SVG`);
    failures += 1;
    continue;
  }
  writeFileSync(join(OUT_DIR, `${a.id}.svg`), header(a.id) + svg, "utf8");
  console.log(`ok ${a.id} ${a.label} (${svg.length} bytes)`);
}
if (failures > 0) {
  console.error(`[generate-subagent-avatars] ${failures} 张失败`);
  process.exit(1);
}
console.log(`[generate-subagent-avatars] ${AVATARS.length} 个预设已写入 ${OUT_DIR}`);
