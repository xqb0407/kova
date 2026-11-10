/**
 * 子智能体头像 · 纯逻辑（无 React / DOM，可单测）。
 *
 * 头像值存 sidecar kv（`set_subagent_avatar` / 随 `save_subagent`），两种形态：
 * - `builtin:<id>` —— 24 个 DiceBear Clay 预设（CC0 1.0）。运行时用 @dicebear/core
 *   + @dicebear/styles/clay.json 现场生成 SVG（与项目头像 lib/projects/project-avatars
 *   同一套做法）：不再落盘静态文件，也不用联网跑下载脚本（旧的
 *   scripts/generate-subagent-avatars.mjs + public/subagent-avatars 已删）；
 * - `data:image/...;base64,...` —— 用户上传（≤128px 缩图）或「随机」生成的头像。
 *
 * 没显式选时按名称哈希分配一张内置预设做默认（defaultSubagentAvatar），所以
 * 渲染层永远有图可画，不存在"空态"。
 *
 * 校验规则与 sidecar 的 normalizeSubagentAvatar 对齐：头像会原样进 <img src>，
 * 两侧都只认白名单形态，http 地址/本地路径一律不放行。
 */
import { Avatar, Style, type StyleDefinition } from "@dicebear/core";
import clayDefinition from "@dicebear/styles/clay.json";
import { nameHash } from "@/lib/ui/name-hue";
import { t } from "@/lib/i18n";

/** 上传图统一缩放到的边长（列表里 16–40px 展示，128 覆盖 2x–4x 屏清晰度） */
export const SUBAGENT_AVATAR_SIZE = 128;

/** data URL 总长度上限（与 sidecar SUBAGENT_AVATAR_MAX_LENGTH 一致） */
export const SUBAGENT_AVATAR_MAX_LENGTH = 256 * 1024;

/** 上传源文件体积上限：超大的先拒绝，别等 canvas 缩完才发现没意义 */
export const SUBAGENT_AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export interface BuiltinSubagentAvatar {
  id: string;
  label: string;
  /** i18n key：渲染层优先取它，label 仅作回退 */
  labelKey: string;
}

/**
 * Clay 部件枚举（@dicebear/styles/clay.json components，注释给中文名）。
 * 眼睛/嘴只收预设里出现过的"友善系"子集——刻意避开 frown/zigzag 一类丧脸，
 * 这是同事列表里的头像，随机生成的也得守同一条线。
 */
const CLAY_TOPS = [
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
] as const;
const CLAY_BODIES = [
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
] as const;
const CLAY_EYES = [
  "happy", "even", "big", "wink", "dots", "up", "side", "googly", "trio", "mono",
] as const;
const CLAY_MOUTHS = [
  "smile", "smileBig", "grin", "smileTongue", "o", "laugh", "cat", "open", "teeth",
  "uu", "toothy", "openSmall",
] as const;
const CLAY_PATTERNS = [
  "checker", "freckles", "prints", "buttons", "stitches", "coil",
] as const;

/** 体色/背景底盘（与项目头像一致用带 # 的 hex——core 不做色值归一化） */
const BODY_COLORS = [
  "#c4795c", "#d99277", "#e0bd6a", "#cf9f52", "#a8b37e", "#8ba06b",
  "#83b0a4", "#86a5c3", "#9793bd", "#ab8bbd", "#cd8ea6", "#b3a696",
] as const;
const BACKGROUNDS = [
  "#f4e8d4", "#f8f1e5", "#f7e3d9", "#f9ecc9", "#eff0da", "#e3efe9",
  "#e2ecf4", "#e9e7f4", "#f4e4ef", "#ece8e2", "#f9e8cf", "#e8edf0",
] as const;

type AvatarSpec = BuiltinSubagentAvatar & {
  body: (typeof CLAY_BODIES)[number];
  eyes: (typeof CLAY_EYES)[number];
  mouth: (typeof CLAY_MOUTHS)[number];
  top: (typeof CLAY_TOPS)[number];
  /** BODY_COLORS / BACKGROUNDS 的下标 */
  color: number;
  bg: number;
  /** 六个预设带花纹，其余关闭，避免整版太闹 */
  pattern?: (typeof CLAY_PATTERNS)[number];
  seed: string;
};

/**
 * 24 个预设：14 种体型 × 12 种体色打底，眼睛/嘴配友善系表情，头顶装饰轮着来。
 * label 显示在设置页选择器的悬浮提示里。id 集合与旧版静态文件一致——已存的
 * kv 值 `builtin:clay-XX` 靠它继续解析。参数全部显式，不依赖随机数实现。
 */
const AVATAR_SPECS: readonly AvatarSpec[] = [
  { id: "clay-01", label: "团子 · 薄荷", labelKey: "settings.subagents.avatar.clay01", body: "blob", eyes: "happy", mouth: "smile", top: "antenna", color: 6, bg: 6, seed: "kova-01" },
  { id: "clay-02", label: "方块 · 杏仁", labelKey: "settings.subagents.avatar.clay02", body: "cube", eyes: "even", mouth: "smileBig", top: "ears", color: 1, bg: 1, seed: "kova-02" },
  { id: "clay-03", label: "墩墩 · 杏黄", labelKey: "settings.subagents.avatar.clay03", body: "squat", eyes: "big", mouth: "grin", top: "crest", color: 3, bg: 3, pattern: "checker", seed: "kova-03" },
  { id: "clay-04", label: "铃铛 · 薰衣草", labelKey: "settings.subagents.avatar.clay04", body: "bell", eyes: "wink", mouth: "smileTongue", top: "curl", color: 8, bg: 7, seed: "kova-04" },
  { id: "clay-05", label: "蛋蛋 · 奶油", labelKey: "settings.subagents.avatar.clay05", body: "egg", eyes: "dots", mouth: "o", top: "nub", color: 10, bg: 0, seed: "kova-05" },
  { id: "clay-06", label: "面包 · 焦糖", labelKey: "settings.subagents.avatar.clay06", body: "loaf", eyes: "happy", mouth: "laugh", top: "tuft", color: 0, bg: 2, pattern: "freckles", seed: "kova-06" },
  { id: "clay-07", label: "软糖 · 天蓝", labelKey: "settings.subagents.avatar.clay07", body: "gumdrop", eyes: "up", mouth: "smile", top: "swirl", color: 7, bg: 5, seed: "kova-07" },
  { id: "clay-08", label: "奶盖 · 鼠尾草", labelKey: "settings.subagents.avatar.clay08", body: "dollop", eyes: "side", mouth: "cat", top: "loop", color: 4, bg: 4, seed: "kova-08" },
  { id: "clay-09", label: "小蜗 · 玫瑰", labelKey: "settings.subagents.avatar.clay09", body: "slug", eyes: "googly", mouth: "open", top: "spikes", color: 10, bg: 8, pattern: "prints", seed: "kova-09" },
  { id: "clay-10", label: "梨子 · 蜜黄", labelKey: "settings.subagents.avatar.clay10", body: "pear", eyes: "happy", mouth: "teeth", top: "peak", color: 2, bg: 10, seed: "kova-10" },
  { id: "clay-11", label: "圆石 · 藤绿", labelKey: "settings.subagents.avatar.clay11", body: "boulder", eyes: "even", mouth: "smileBig", top: "hornsSmall", color: 5, bg: 5, seed: "kova-11" },
  { id: "clay-12", label: "柱柱 · 丁香", labelKey: "settings.subagents.avatar.clay12", body: "column", eyes: "big", mouth: "smile", top: "horns", color: 8, bg: 11, seed: "kova-12" },
  { id: "clay-13", label: "叠叠 · 粉紫", labelKey: "settings.subagents.avatar.clay13", body: "stack", eyes: "wink", mouth: "smile", top: "pellet", color: 9, bg: 8, pattern: "buttons", seed: "kova-13" },
  { id: "clay-14", label: "瘦高 · 湖绿", labelKey: "settings.subagents.avatar.clay14", body: "lean", eyes: "trio", mouth: "grin", top: "antenna", color: 6, bg: 9, seed: "kova-14" },
  { id: "clay-15", label: "团子 · 蜜桃", labelKey: "settings.subagents.avatar.clay15", body: "blob", eyes: "happy", mouth: "smileBig", top: "tuft", color: 1, bg: 8, seed: "kova-15" },
  { id: "clay-16", label: "方块 · 鼠尾草", labelKey: "settings.subagents.avatar.clay16", body: "cube", eyes: "dots", mouth: "cat", top: "swirl", color: 4, bg: 2, seed: "kova-16" },
  { id: "clay-17", label: "蛋蛋 · 鹅黄", labelKey: "settings.subagents.avatar.clay17", body: "egg", eyes: "even", mouth: "uu", top: "crest", color: 2, bg: 3, pattern: "stitches", seed: "kova-17" },
  { id: "clay-18", label: "铃铛 · 蜜橙", labelKey: "settings.subagents.avatar.clay18", body: "bell", eyes: "big", mouth: "toothy", top: "ears", color: 0, bg: 1, seed: "kova-18" },
  { id: "clay-19", label: "墩墩 · 青苔", labelKey: "settings.subagents.avatar.clay19", body: "squat", eyes: "happy", mouth: "smileTongue", top: "nub", color: 5, bg: 0, seed: "kova-19" },
  { id: "clay-20", label: "面包 · 苔绿", labelKey: "settings.subagents.avatar.clay20", body: "loaf", eyes: "up", mouth: "smile", top: "peak", color: 4, bg: 6, seed: "kova-20" },
  { id: "clay-21", label: "软糖 · 丁香", labelKey: "settings.subagents.avatar.clay21", body: "gumdrop", eyes: "side", mouth: "grin", top: "loop", color: 8, bg: 4, seed: "kova-21" },
  { id: "clay-22", label: "奶盖 · 冰蓝", labelKey: "settings.subagents.avatar.clay22", body: "dollop", eyes: "happy", mouth: "openSmall", top: "curl", color: 7, bg: 11, pattern: "coil", seed: "kova-22" },
  { id: "clay-23", label: "梨子 · 紫藤", labelKey: "settings.subagents.avatar.clay23", body: "pear", eyes: "mono", mouth: "smile", top: "hornsSmall", color: 9, bg: 7, seed: "kova-23" },
  { id: "clay-24", label: "圆石 · 暖沙", labelKey: "settings.subagents.avatar.clay24", body: "boulder", eyes: "even", mouth: "laugh", top: "spikes", color: 11, bg: 9, seed: "kova-24" },
];

export const BUILTIN_SUBAGENT_AVATARS: readonly BuiltinSubagentAvatar[] =
  AVATAR_SPECS;

export const BUILTIN_AVATAR_PREFIX = "builtin:";

const SPEC_BY_ID = new Map(AVATAR_SPECS.map((a) => [a.id, a]));

/** Clay 定义只包一次：Style 构造会做 schema 校验与深拷贝，别每张头像重跑 */
const CLAY_STYLE = new Style(clayDefinition as unknown as StyleDefinition);

/** 生成过的 data URL 按 id 缓存：侧栏/聊天/选择器每次渲染都来取 */
const DATA_URI_CACHE = new Map<string, string>();

/** SVG → base64 data URL：sidecar 的白名单只认 base64 形态（toDataUri 的
 * percent-encoded 形态过不了校验），所以落 kv 的都从这里出。 */
function svgToBase64DataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** 一组显式 Clay 参数 → 原始 SVG。参数给全，不依赖随机数实现。 */
function renderClaySvg(spec: {
  seed: string;
  body: string;
  eyes: string;
  mouth: string;
  top: string;
  pattern?: string;
  bodyColor: string;
  backgroundColor: string;
}): string {
  return new Avatar(CLAY_STYLE, {
    seed: spec.seed,
    bodyVariant: spec.body,
    eyesVariant: spec.eyes,
    mouthVariant: spec.mouth,
    topVariant: spec.top,
    topProbability: 100,
    patternProbability: spec.pattern ? 100 : 0,
    ...(spec.pattern ? { patternVariant: spec.pattern } : {}),
    bodyColor: [spec.bodyColor],
    backgroundColor: [spec.backgroundColor],
    animationVariant: "none",
  }).toString();
}

/**
 * 内置预设 id → 可直接喂给 <img src> 的 base64 data URL；未知 id 返回 null
 * （渲染层回落按名默认，不出破图）。
 */
export function builtinAvatarSrc(id: string): string | null {
  const cached = DATA_URI_CACHE.get(id);
  if (cached) return cached;
  const spec = SPEC_BY_ID.get(id);
  if (!spec) return null;

  const uri = svgToBase64DataUrl(
    renderClaySvg({
      seed: spec.seed,
      body: spec.body,
      eyes: spec.eyes,
      mouth: spec.mouth,
      top: spec.top,
      pattern: spec.pattern,
      bodyColor: BODY_COLORS[spec.color]!,
      backgroundColor: BACKGROUNDS[spec.bg]!,
    }),
  );
  DATA_URI_CACHE.set(id, uri);
  return uri;
}

/** 头像值 → 可直接喂给 <img src> 的地址；不可识别的值返回 null（渲染默认图标） */
export function subagentAvatarSrc(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.startsWith(BUILTIN_AVATAR_PREFIX)) {
    return builtinAvatarSrc(value.slice(BUILTIN_AVATAR_PREFIX.length));
  }
  return value.startsWith("data:image/") ? value : null;
}

/**
 * 没手动选头像时的默认：按名称哈希从内置预设里固定分配一张——每个子智能体
 * 天生就有一张脸，而不是一个灰圈/通用机器人图标；同名恒定同脸，列表、聊天、
 * 编辑器三处一致。名字按 sidecar 的归一规则（trim + 小写）取哈希，
 * "Explorer" 与 "explorer" 是同一个身份就该是同一张脸。
 * 这是纯渲染规则：kv 只存用户显式选的值，默认不落库。
 */
export function defaultSubagentAvatar(name: string): string {
  const index = nameHash(name.trim().toLowerCase()) % BUILTIN_SUBAGENT_AVATARS.length;
  return `${BUILTIN_AVATAR_PREFIX}${BUILTIN_SUBAGENT_AVATARS[index]!.id}`;
}

/** 生效头像的地址：显式值可解析就用它，否则落按名默认（预设清单为空时才可能 null） */
export function resolveSubagentAvatarSrc(avatar: string | undefined | null, name: string): string | null {
  return subagentAvatarSrc(avatar) ?? subagentAvatarSrc(defaultSubagentAvatar(name));
}

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/**
 * 「随机一张」：从 Clay 全参数空间（体 14 × 眼 10 × 嘴 12 × 头顶 13 × 体色 12 ×
 * 背景 12 ≈ 300 万组合，花纹按预设同款比例约 1/4 概率带上）随机生成一张新头像，
 * 以 base64 data URL 返回——kv 形态天然合法，选了就存，不满意再点一次。
 */
export function randomSubagentAvatar(): string {
  const value = svgToBase64DataUrl(
    renderClaySvg({
      seed: `kova-rnd-${Math.random().toString(36).slice(2, 10)}`,
      body: pick(CLAY_BODIES),
      eyes: pick(CLAY_EYES),
      mouth: pick(CLAY_MOUTHS),
      top: pick(CLAY_TOPS),
      pattern: Math.random() < 0.25 ? pick(CLAY_PATTERNS) : undefined,
      bodyColor: pick(BODY_COLORS),
      backgroundColor: pick(BACKGROUNDS),
    }),
  );
  // 兜底：落 kv 的值必须过校验，理论到不了这里
  const invalid = subagentAvatarValidationError(value);
  if (invalid !== undefined) throw new Error(invalid);
  return value;
}

const BUILTIN_AVATAR_RE = /^builtin:[a-z0-9][a-z0-9-]{0,39}$/;
const DATA_AVATAR_RE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

/**
 * 保存前的客户端预检（sidecar 侧还有同规则的真校验）：
 * 不合法返回错误文案，合法返回 undefined。空串/空白 = 清除，合法。
 */
export function subagentAvatarValidationError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (BUILTIN_AVATAR_RE.test(trimmed)) return undefined;
  if (trimmed.length > SUBAGENT_AVATAR_MAX_LENGTH) {
    return t("settings.subagents.avatar.errorValidationTooLarge", {
      kb: Math.round(SUBAGENT_AVATAR_MAX_LENGTH / 1024),
    });
  }
  if (DATA_AVATAR_RE.test(trimmed)) return undefined;
  return t("settings.subagents.avatar.errorValidationFormat");
}
