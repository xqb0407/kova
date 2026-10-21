/**
 * 名称 → 稳定色相（0-359）。
 *
 * 用于给没有图标的条目生成首字母/图标底色：同一名称恒定同色，列表刷新或
 * 滚动时颜色不乱跳。结尾的三步 xorshift 混合不是可选的：裸 FNV-1a 的低位
 * 对短字符串偏弱，而 360 = 8×45 恰好吃低位，短名字会成片落到同一色相。
 */
export function hueFromName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) % 360;
}
