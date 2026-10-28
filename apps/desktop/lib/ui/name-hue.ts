/**
 * 名称 → 稳定哈希 / 色相。
 *
 * 用于给没有图标的条目生成首字母/图标底色，以及按名分配默认头像：同一名称
 * 恒定同值，列表刷新或滚动时不乱跳。结尾的三步 xorshift 混合不是可选的：
 * 裸 FNV-1a 的低位对短字符串偏弱，而 360 = 8×45 恰好吃低位，短名字会成片
 * 落到同一色相（取模 24 同理）。
 */

/** 名称 → 混合后的 32 位无符号哈希（调用方自行取模） */
export function nameHash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

/** 名称 → 稳定色相（0-359） */
export function hueFromName(name: string): number {
  return nameHash(name) % 360;
}
