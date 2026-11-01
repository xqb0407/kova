/**
 * 项目内置头像（DiceBear Gaze，CC0 1.0）· 纯逻辑，无 React/DOM，可单测。
 *
 * 与 scripts/generate-project-avatars.mjs 的 AVATARS 表一一对应：那边加/删，
 * 这边同步（测试保证每个 id 都有对应的 SVG 落盘）。SVG 以根相对路径直接喂
 * 给 <img src>，与子智能体的内置头像同一套做法。
 */
export interface BuiltinProjectAvatar {
  id: string;
  label: string;
}

export const BUILTIN_PROJECT_AVATARS: readonly BuiltinProjectAvatar[] = [
  { id: "gaze-01", label: "圆 · 陶土" },
  { id: "gaze-02", label: "胶囊 · 蜜黄" },
  { id: "gaze-03", label: "蛋 · 叶绿" },
  { id: "gaze-04", label: "拱 · 海松" },
  { id: "gaze-05", label: "方 · 天蓝" },
  { id: "gaze-06", label: "六边 · 紫藤" },
  { id: "gaze-07", label: "五边 · 玫瑰" },
  { id: "gaze-08", label: "菱形 · 杏橙" },
  { id: "gaze-09", label: "三角 · 鼠尾草" },
  { id: "gaze-10", label: "八边 · 藕粉" },
  { id: "gaze-11", label: "柱 · 松绿" },
  { id: "gaze-12", label: "圆 · 可可" },
] as const;

const AVATAR_IDS = new Set(BUILTIN_PROJECT_AVATARS.map((a) => a.id));

export function isProjectAvatarId(value: unknown): value is string {
  return typeof value === "string" && AVATAR_IDS.has(value);
}

/** 内置头像 id → 可直接喂给 <img src> 的地址；未知 id 返回 null（回退图标） */
export function projectAvatarSrc(id: string | undefined | null): string | null {
  return isProjectAvatarId(id) ? `/project-avatars/${id}.svg` : null;
}
