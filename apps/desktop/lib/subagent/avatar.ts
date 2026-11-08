/**
 * 子智能体头像 · 纯逻辑（无 React / DOM，可单测）。
 *
 * 头像值存 sidecar kv（`set_subagent_avatar` / 随 `save_subagent`），两种形态：
 * - `builtin:<id>` —— 随应用发布的 DiceBear Clay 预设（public/subagent-avatars/<id>.svg，
 *   CC0 1.0，见 scripts/generate-subagent-avatars.mjs）；
 * - `data:image/...;base64,...` —— 用户上传后前端缩好的小图（≤128px）。
 *
 * 没显式选时按名称哈希分配一张内置预设做默认（defaultSubagentAvatar），所以
 * 渲染层永远有图可画，不存在"空态"。
 *
 * 校验规则与 sidecar 的 normalizeSubagentAvatar 对齐：头像会原样进 <img src>，
 * 两侧都只认白名单形态，http 地址/本地路径一律不放行。
 */
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
 * 内置预设清单。与 scripts/generate-subagent-avatars.mjs 的 AVATARS 表一一对应：
 * 那边加/删预设，这边同步（测试保证每个 id 都有对应的 SVG 文件落盘）。
 */
export const BUILTIN_SUBAGENT_AVATARS: readonly BuiltinSubagentAvatar[] = [
  { id: "clay-01", label: "团子 · 薄荷", labelKey: "settings.subagents.avatar.clay01" },
  { id: "clay-02", label: "方块 · 杏仁", labelKey: "settings.subagents.avatar.clay02" },
  { id: "clay-03", label: "墩墩 · 杏黄", labelKey: "settings.subagents.avatar.clay03" },
  { id: "clay-04", label: "铃铛 · 薰衣草", labelKey: "settings.subagents.avatar.clay04" },
  { id: "clay-05", label: "蛋蛋 · 奶油", labelKey: "settings.subagents.avatar.clay05" },
  { id: "clay-06", label: "面包 · 焦糖", labelKey: "settings.subagents.avatar.clay06" },
  { id: "clay-07", label: "软糖 · 天蓝", labelKey: "settings.subagents.avatar.clay07" },
  { id: "clay-08", label: "奶盖 · 鼠尾草", labelKey: "settings.subagents.avatar.clay08" },
  { id: "clay-09", label: "小蜗 · 玫瑰", labelKey: "settings.subagents.avatar.clay09" },
  { id: "clay-10", label: "梨子 · 蜜黄", labelKey: "settings.subagents.avatar.clay10" },
  { id: "clay-11", label: "圆石 · 藤绿", labelKey: "settings.subagents.avatar.clay11" },
  { id: "clay-12", label: "柱柱 · 丁香", labelKey: "settings.subagents.avatar.clay12" },
  { id: "clay-13", label: "叠叠 · 粉紫", labelKey: "settings.subagents.avatar.clay13" },
  { id: "clay-14", label: "瘦高 · 湖绿", labelKey: "settings.subagents.avatar.clay14" },
  { id: "clay-15", label: "团子 · 蜜桃", labelKey: "settings.subagents.avatar.clay15" },
  { id: "clay-16", label: "方块 · 鼠尾草", labelKey: "settings.subagents.avatar.clay16" },
  { id: "clay-17", label: "蛋蛋 · 鹅黄", labelKey: "settings.subagents.avatar.clay17" },
  { id: "clay-18", label: "铃铛 · 蜜橙", labelKey: "settings.subagents.avatar.clay18" },
  { id: "clay-19", label: "墩墩 · 青苔", labelKey: "settings.subagents.avatar.clay19" },
  { id: "clay-20", label: "面包 · 苔绿", labelKey: "settings.subagents.avatar.clay20" },
  { id: "clay-21", label: "软糖 · 丁香", labelKey: "settings.subagents.avatar.clay21" },
  { id: "clay-22", label: "奶盖 · 冰蓝", labelKey: "settings.subagents.avatar.clay22" },
  { id: "clay-23", label: "梨子 · 紫藤", labelKey: "settings.subagents.avatar.clay23" },
  { id: "clay-24", label: "圆石 · 暖沙", labelKey: "settings.subagents.avatar.clay24" },
];

export const BUILTIN_AVATAR_PREFIX = "builtin:";

/** 内置预设的静态地址（根相对：桌面 kova://app 与网页端同形） */
export function builtinAvatarSrc(id: string): string {
  return `/subagent-avatars/${id}.svg`;
}

/** 头像值 → 可直接喂给 <img src> 的地址；不可识别的值返回 null（渲染默认图标） */
export function subagentAvatarSrc(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.startsWith(BUILTIN_AVATAR_PREFIX)) {
    const id = value.slice(BUILTIN_AVATAR_PREFIX.length);
    return BUILTIN_SUBAGENT_AVATARS.some((a) => a.id === id) ? builtinAvatarSrc(id) : null;
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
